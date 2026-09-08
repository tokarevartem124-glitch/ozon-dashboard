import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
  Ozon Seller Analytics — API-only sync (schema v4)

  Source policy:
    - every operational Ozon dataset comes ONLY from Seller API;
    - Excel Ozon reports are never used as a calculation baseline;
    - purchase cost and RRP live in index.html/local browser state and are joined by offer_id/article.

  Modes:
    fast  — hourly: catalogue, prices, stocks, recent finance + recent postings;
    daily — same + one top-1000 funnel snapshot for the uncovered date interval.

  First run after migration:
    if the previous encrypted payload is not API-only schema v4, it is ignored and
    the script performs a one-time API backfill for HISTORY_DAYS.
*/

const BASE = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SYNC_MODE = String(process.env.SYNC_MODE || 'fast').toLowerCase();
const PREVIOUS_DATA_URL = process.env.PREVIOUS_DATA_URL || '';
const FINANCE_LOOKBACK_DAYS = Math.max(1, Number(process.env.FINANCE_LOOKBACK_DAYS || 3));
const POSTING_LOOKBACK_DAYS = Math.max(7, Number(process.env.POSTING_LOOKBACK_DAYS || 35));
const RETURN_LOOKBACK_DAYS = Math.max(7, Number(process.env.RETURN_LOOKBACK_DAYS || 35));
const HISTORY_DAYS = Math.max(30, Number(process.env.OZON_HISTORY_DAYS || 120));
const ANALYTICS_MAX_CATCHUP_DAYS = Math.max(1, Number(process.env.ANALYTICS_MAX_CATCHUP_DAYS || 7));

if (!CLIENT_ID || !API_KEY || !PASSWORD) throw new Error('Missing OZON_CLIENT_ID, OZON_API_KEY or DASHBOARD_PASSWORD');
if (!['fast','daily'].includes(SYNC_MODE)) throw new Error(`Unknown SYNC_MODE=${SYNC_MODE}`);

const isoDate = d => d.toISOString().slice(0,10);
const asNum = (v, fallback=0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const asStr = v => v == null ? '' : String(v);
const first = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '');
const sleep = ms => new Promise(r => setTimeout(r,ms));
const addDays = (dateStr,days) => { const d=new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return isoDate(d); };
const minDateStr = (...x) => x.filter(Boolean).sort()[0] || null;
const maxDateStr = (...x) => x.filter(Boolean).sort().at(-1) || null;
const TODAY = isoDate(new Date());
const YESTERDAY = addDays(TODAY,-1);
const HISTORY_START = addDays(TODAY,-(HISTORY_DAYS-1));

async function post(endpoint, body, {allowError=false,retries=3,analytics=false}={}) {
  for (let attempt=0; attempt<=retries; attempt++) {
    const res=await fetch(BASE+endpoint,{
      method:'POST',
      headers:{'Client-Id':CLIENT_ID,'Api-Key':API_KEY,'Content-Type':'application/json','Accept':'application/json'},
      body:JSON.stringify(body??{})
    });
    const text=await res.text();
    let json={}; try{json=text?JSON.parse(text):{}}catch{json={raw:text}}
    if(res.ok)return json;
    const msg=`${endpoint}: HTTP ${res.status} ${JSON.stringify(json).slice(0,700)}`;
    const retryable=res.status===429||res.status>=500;
    if(retryable&&attempt<retries){
      const retryAfter=Number(res.headers.get('retry-after'));
      const waitMs=Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:(analytics?90000:Math.min(20000,2500*(attempt+1)));
      console.warn(`${msg} — retry ${attempt+1}/${retries} after ${Math.round(waitMs/1000)}s`);
      await sleep(waitMs); continue;
    }
    if(allowError)return {__error:msg,__status:res.status};
    throw new Error(msg);
  }
}

async function testAuth(){ return post('/v4/product/info/limit',{}); }

/* ----------------------------- encryption ----------------------------- */
function encryptJson(obj,password){
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),iterations=250000;
  const key=crypto.pbkdf2Sync(password,salt,iterations,32,'sha256');
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const plain=Buffer.from(JSON.stringify(obj),'utf8');
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  const tag=cipher.getAuthTag();
  return {v:1,alg:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations,salt:salt.toString('base64'),iv:iv.toString('base64'),data:Buffer.concat([ciphertext,tag]).toString('base64'),generatedAt:obj.generatedAt};
}
function decryptJson(env,password){
  const salt=Buffer.from(env.salt,'base64'),iv=Buffer.from(env.iv,'base64'),data=Buffer.from(env.data,'base64');
  const ciphertext=data.subarray(0,data.length-16),tag=data.subarray(data.length-16);
  const key=crypto.pbkdf2Sync(password,salt,Number(env.iterations||250000),32,'sha256');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
}
async function loadPreviousPayload(){
  if(!PREVIOUS_DATA_URL)return null;
  try{
    const sep=PREVIOUS_DATA_URL.includes('?')?'&':'?';
    const res=await fetch(`${PREVIOUS_DATA_URL}${sep}t=${Date.now()}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const payload=decryptJson(await res.json(),PASSWORD);
    if(payload?.version!==4||payload?.sourcePolicy!=='ozon-api-only') {
      console.warn(`Previous payload ignored: version=${payload?.version}, sourcePolicy=${payload?.sourcePolicy||'none'}. A clean API-only backfill will be created.`);
      return null;
    }
    console.log(`Previous API-only state loaded: ${payload.generatedAt}`);
    return payload;
  }catch(e){console.warn(`Previous API-only state unavailable: ${e}`);return null}
}
function datasetOf(payload,type){return payload?.datasets?.find(d=>d.type===type)||null}

/* ------------------------------- helpers ------------------------------ */
function monthChunks(fromStr,toStr){
  const out=[];let cur=new Date(`${fromStr}T00:00:00Z`),end=new Date(`${toStr}T23:59:59.999Z`);
  while(cur<=end){
    const mEnd=new Date(Date.UTC(cur.getUTCFullYear(),cur.getUTCMonth()+1,0,23,59,59,999));
    const stop=mEnd<end?mEnd:end;out.push([cur.toISOString(),stop.toISOString()]);cur=new Date(stop.getTime()+1);
  }
  return out;
}
function extractProductSkuCandidates(p){
  const set=new Set();
  for(const v of [p.sku,p.fbo_sku,p.fbs_sku])if(v)set.add(asStr(v));
  for(const s of p.sources||[])for(const v of [s.sku,s.source_sku])if(v)set.add(asStr(v));
  return [...set];
}
function datasetRange(rows){
  const ds=rows.map(r=>r.date).filter(Boolean).sort();
  return {start:ds[0]||null,end:ds.at(-1)||null};
}

/* ------------------------------- products ----------------------------- */
async function fetchProducts(){
  const items=[];let lastId='';
  for(let guard=0;guard<100;guard++){
    let r=await post('/v3/product/list',{filter:{visibility:'ALL'},last_id:lastId,limit:1000},{allowError:true});
    if(r.__error&&guard===0)r=await post('/v2/product/list',{filter:{visibility:'ALL'},last_id:lastId,limit:1000});
    else if(r.__error)throw new Error(r.__error);
    const result=r.result||r,batch=Array.isArray(result.items)?result.items:[];
    items.push(...batch);const next=asStr(first(result.last_id,result.cursor));
    if(!batch.length||!next||next===lastId)break;lastId=next;
  } return items;
}
async function fetchPrices(){
  const items=[];let cursor='',endpoint='/v5/product/info/prices';
  for(let guard=0;guard<100;guard++){
    const body={filter:{visibility:'ALL'},limit:1000};if(cursor)body.cursor=cursor;
    let r=await post(endpoint,body,{allowError:true});
    if(r.__error&&guard===0){endpoint='/v4/product/info/prices';r=await post(endpoint,{filter:{visibility:'ALL'},limit:1000,last_id:''});}
    else if(r.__error)throw new Error(r.__error);
    const result=r.result||r,batch=Array.isArray(result.items)?result.items:[];
    items.push(...batch);const next=asStr(first(result.cursor,result.last_id));
    if(!batch.length||!next||next===cursor)break;cursor=next;
  } return items;
}
async function fetchProductStocks(){
  const items=[];let cursor='',endpoint='/v4/product/info/stocks';
  for(let guard=0;guard<100;guard++){
    let r=await post(endpoint,{cursor,filter:{visibility:'ALL'},limit:1000},{allowError:true});
    if(r.__error&&guard===0){endpoint='/v3/product/info/stocks';break}
    if(r.__error)throw new Error(r.__error);
    const result=r.result||r,batch=Array.isArray(result.items)?result.items:[];
    items.push(...batch);const next=asStr(first(result.cursor,r.cursor));
    if(!batch.length||batch.length<1000||!next||next===cursor)return {rows:items,source:endpoint,complete:true};
    cursor=next;
  }
  if(endpoint==='/v3/product/info/stocks'){
    const legacy=[];let lastId='';
    for(let guard=0;guard<100;guard++){
      const r=await post(endpoint,{filter:{visibility:'ALL'},last_id:lastId,limit:1000});
      const result=r.result||r,batch=Array.isArray(result.items)?result.items:[];
      legacy.push(...batch);const next=asStr(first(result.last_id,r.last_id));
      if(!batch.length||batch.length<1000||!next||next===lastId)return {rows:legacy,source:endpoint,complete:true};
      lastId=next;
    } return {rows:legacy,source:endpoint,complete:false};
  }
  return {rows:items,source:endpoint,complete:false};
}


async function fetchProductDetails(products){
  const offers=[...new Set((products||[]).map(p=>asStr(first(p.offer_id,p.offerId))).filter(Boolean))];
  const out=[];
  for(let i=0;i<offers.length;i+=1000){
    const batch=offers.slice(i,i+1000);
    const r=await post('/v3/product/info/list',{offer_id:batch},{allowError:true,retries:2});
    if(r.__error)throw new Error(r.__error);
    const items=r?.items||r?.result?.items||[];
    out.push(...items);
  }
  return out;
}
async function fetchCategoryTree(){
  const r=await post('/v1/description-category/tree',{language:'RU'},{allowError:true,retries:2});
  if(r.__error)throw new Error(r.__error);
  return Array.isArray(r.result)?r.result:[];
}
function flattenCategoryTree(nodes){
  const categories=new Map(),types=new Map();
  function walk(node,path=[]){
    if(!node||typeof node!=='object')return;
    const catId=asStr(node.description_category_id),catName=asStr(node.category_name);
    const nextPath=catName?[...path,catName]:path;
    if(catId)categories.set(catId,{name:catName||`Категория ${catId}`,path:nextPath.filter(Boolean)});
    const typeId=asStr(node.type_id),typeName=asStr(node.type_name);
    if(typeId)types.set(typeId,{name:typeName||`Тип ${typeId}`,categoryId:catId||'',path:nextPath.filter(Boolean)});
    for(const child of node.children||[])walk(child,nextPath);
  }
  for(const n of nodes||[])walk(n,[]);
  return {categories,types};
}
function buildMaps(products,stockRaw,previousStock=[],productDetails=[],categoryTree=[]){
  const articleBySku=new Map(),nameBySku=new Map(),productByArticle=new Map();
  const cat=flattenCategoryTree(categoryTree);
  const detailByArticle=new Map();
  for(const d of productDetails||[]){
    const article=asStr(first(d.offer_id,d.offerId));if(article)detailByArticle.set(article,d);
  }
  for(const p of products){
    const article=asStr(first(p.offer_id,p.offerId)),productId=asStr(first(p.product_id,p.id));
    const d=detailByArticle.get(article)||{};
    const categoryId=asStr(first(d.description_category_id,d.category_id));
    const typeId=asStr(d.type_id);
    const catMeta=cat.categories.get(categoryId)||cat.types.get(typeId)||{};
    const typeMeta=cat.types.get(typeId)||{};
    const category=catMeta.path?.length?catMeta.path.join(' → '):(catMeta.name||'');
    const type=typeMeta.name||'';
    const name=asStr(first(d.name,p.name));
    if(article)productByArticle.set(article,{article,productId:asStr(first(d.id,d.product_id,productId)),name,category,type,categoryId,typeId});
    const candidates=new Set([...extractProductSkuCandidates(p),...extractProductSkuCandidates(d)]);
    for(const sku of candidates){if(article)articleBySku.set(sku,article);if(name)nameBySku.set(sku,name)}
  }
  for(const s of [...stockRaw,...previousStock]){
    const article=asStr(first(s.item_code,s.offer_id,s.offerId,s.article)),directSku=asStr(first(s.sku,s.fbo_sku,s.fbs_sku));
    const nested=Array.isArray(s.stocks)?s.stocks.map(st=>asStr(first(st.sku,st.fbo_sku,st.fbs_sku))).filter(Boolean):[];
    for(const sku of new Set([directSku,...nested].filter(Boolean))){if(article)articleBySku.set(sku,article);if(first(s.item_name,s.name))nameBySku.set(sku,asStr(first(s.item_name,s.name)))}
  }
  return {articleBySku,nameBySku,productByArticle,categoryMaps:cat};
}
function getPriceValue(p){return asNum(first(p?.price?.marketing_seller_price,p?.price?.marketing_price,p?.price?.price,p?.marketing_seller_price,p?.marketing_price,p?.price,p?.min_ozon_price),NaN)}
function normalizeCommissions(p){
  const arr=Array.isArray(p.commissions)?p.commissions:(Array.isArray(p?.price?.commissions)?p.price.commissions:[]);
  let fbo=null,fbs=null;
  for(const c of arr){const schema=asStr(first(c.sale_schema,c.saleSchema,c.delivery_schema)).toLowerCase(),pct=asNum(first(c.percent,c.commission_percent,c.value),NaN);if(!Number.isFinite(pct))continue;if(schema.includes('fbo'))fbo=pct;if(schema.includes('fbs'))fbs=pct}
  return {fbo,fbs};
}
function normalizePrices(prices,maps){
  return prices.map(p=>{const article=asStr(first(p.offer_id,p.offerId));const comm=normalizeCommissions(p);return{
    article,sku:'',productId:asStr(first(p.product_id,p.id)),name:asStr(first(p.name,maps.productByArticle.get(article)?.name)),
    currentPrice:getPriceValue(p),volume:asNum(first(p.volume_weight,p.volume),NaN),cost:null,costColumn:null,acquiring:null,
    commissionFbo:comm.fbo,commissionFbs:comm.fbs,logMaxFbo:null,lastMileFbo:null,nonstandardFbo:null,procMaxFbs:null,logMaxFbs:null,lastMileFbs:null,nonstandardFbs:null,orders7:null
  }}).filter(r=>r.article);
}
function normalizeStock(stockRaw,maps,priceByArticle){
  const grouped=new Map();
  for(const r of stockRaw){
    const nested=Array.isArray(r.stocks)?r.stocks.map(st=>asStr(first(st.sku,st.fbo_sku,st.fbs_sku))).filter(Boolean):[];
    const sku=asStr(first(r.sku,r.fbo_sku,r.fbs_sku,nested[0])),article=asStr(first(r.item_code,r.offer_id,r.offerId,maps.articleBySku.get(sku)));
    if(!sku&&!article)continue;const key=article||`sku:${sku}`;
    const meta=maps.productByArticle.get(article)||{};
    const o=grouped.get(key)||{article,sku,name:asStr(first(r.item_name,r.name,maps.nameBySku.get(sku),meta.name)),category:asStr(meta.category),type:asStr(meta.type),brand:'',productId:asStr(first(r.product_id,meta.productId)),volume:null,currentPrice:null,stockFbo:0,stockFbs:0,stockRealFbs:0,reservedFbo:0,reservedFbs:0};
    if('free_to_sell_amount' in r)o.stockFbo+=asNum(r.free_to_sell_amount);
    else if(Array.isArray(r.stocks)){
      for(const st of r.stocks){const type=asStr(first(st.type,st.stock_type,st.warehouse_type,st.shipment_type)).toLowerCase();const present=asNum(first(st.present,st.stock,st.free_to_sell_amount)),reserved=Math.max(0,asNum(first(st.reserved,st.reserved_amount),0)),available=Math.max(0,present-reserved);if(type.includes('fbs')||type.includes('rfbs')){o.stockFbs+=available;o.reservedFbs+=reserved}else{o.stockFbo+=available;o.reservedFbo+=reserved}}
    }else o.stockFbo+=asNum(first(r.present,r.stock,r.free_to_sell_amount));
    const pr=priceByArticle.get(article);if(pr)o.currentPrice=getPriceValue(pr);grouped.set(key,o);
  }
  return [...grouped.values()];
}

/* ------------------------------- finance ------------------------------ */
async function fetchFinance(fromDate,toDate){
  const operations=[];
  for(const [from,to] of monthChunks(fromDate,toDate)){
    for(let page=1;page<1000;page++){
      const r=await post('/v3/finance/transaction/list',{filter:{date:{from,to},operation_type:[],posting_number:'',transaction_type:'ALL'},page,page_size:1000});
      const result=r.result||{},batch=result.operations||[];operations.push(...batch);
      if(!batch.length||page>=asNum(result.page_count,page))break;
    }
  } return operations;
}
function classifyService(name){
  const s=asStr(name).toLowerCase();
  if(s.includes('эквайр')||s.includes('acquir'))return'acquiring';
  if(s.includes('хранен')||s.includes('storage'))return'storage';
  if(s.includes('реклам')||s.includes('продвиж')||s.includes('advert'))return'ads';
  if(s.includes('штраф')||s.includes('penalt'))return'fines';
  if(s.includes('возврат')||s.includes('return'))return'returns';
  if(s.includes('логист')||s.includes('достав')||s.includes('обработ')||s.includes('fulfillment')||s.includes('delivery'))return'logistics';
  return'other';
}
function normalizeFinance(ops,maps){
  const rows=[];
  for(const op of ops){
    const items=Array.isArray(op.items)?op.items:[],single=items.length===1?items[0]:null,sku=asStr(single?.sku),article=asStr(maps.articleBySku.get(sku));
    const gross=asNum(op.accruals_for_sale,0),amount=asNum(op.amount,0);
    const comp={commission:Math.abs(asNum(op.sale_commission,0)),acquiring:0,logistics:Math.abs(asNum(op.delivery_charge,0)),storage:0,ads:0,fines:0,returns:Math.abs(asNum(op.return_delivery_charge,0)),other:0};
    for(const s of op.services||[])comp[classifyService(s.name)]+=-asNum(s.price,0);
    const known=Object.values(comp).reduce((a,b)=>a+b,0);comp.other+=gross-known-amount;
    rows.push({
      date:asStr(op.operation_date).slice(0,10),article,sku,postingNumber:asStr(op?.posting?.posting_number),itemSkus:items.map(it=>asStr(it?.sku)).filter(Boolean),
      group:asStr(op.type),operation:asStr(first(op.operation_type_name,op.operation_type)),transactionId:asStr(op.operation_id),grossRevenue:gross||null,
      soldQty:0,returnedQty:0,commission:comp.commission,acquiring:comp.acquiring,logistics:comp.logistics,storage:comp.storage,ads:comp.ads,fines:comp.fines,returns:comp.returns,other:comp.other,rawAmount:amount
    });
  } return rows;
}
function mergeFinanceRows(previousRows,freshRows){
  const freshIds=new Set(freshRows.map(r=>asStr(r.transactionId)).filter(Boolean)),kept=previousRows.filter(r=>!freshIds.has(asStr(r.transactionId)));
  const seen=new Set(),out=[];
  for(const r of [...kept,...freshRows]){
    if(r.transactionId){out.push(r);continue}
    const k=[r.date,r.postingNumber,r.article,r.sku,r.operation,r.rawAmount].join('|');if(!seen.has(k)){seen.add(k);out.push(r)}
  }
  out.sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.transactionId).localeCompare(asStr(b.transactionId)));return out;
}
function financeTotals(rows){
  const components={commission:0,acquiring:0,logistics:0,storage:0,ads:0,fines:0,returns:0,other:0};let grossRevenue=0,netAfterOzon=0;
  for(const r of rows||[]){grossRevenue+=asNum(r.grossRevenue,0);netAfterOzon+=asNum(r.rawAmount,0);for(const k of Object.keys(components))components[k]+=asNum(r[k],0)}
  return {grossRevenue,netAfterOzon,components};
}

/* ------------------------------- postings ----------------------------- */
async function fetchFboPostings(fromDate,toDate){
  const byNumber=new Map();
  for(const [from,to] of monthChunks(fromDate,toDate)){
    let cursor='';
    for(let guard=0;guard<1000;guard++){
      const r=await post('/v3/posting/fbo/list',{
        cursor,
        filter:{posting_number:[],order_number:[],since:from,to,status:[]},
        limit:1000,sort_dir:'asc',translit:false,
        with:{analytics_data:false,financial_data:false,legal_info:false}
      },{allowError:true,retries:2});
      if(r.__error)throw new Error(r.__error);
      const batch=Array.isArray(r.postings)?r.postings:(r?.result?.postings||[]);
      for(const p of batch)if(p?.posting_number)byNumber.set(asStr(p.posting_number),p);
      const next=asStr(first(r.cursor,r?.result?.cursor));
      const hasNext=Boolean(first(r.has_next,r?.result?.has_next));
      if(!batch.length||!hasNext||!next||next===cursor)break;
      cursor=next;
    }
  } return [...byNumber.values()];
}
async function fetchFbsPostings(fromDate,toDate){
  const byNumber=new Map();
  for(const [from,to] of monthChunks(fromDate,toDate)){
    let cursor='';
    for(let guard=0;guard<1000;guard++){
      const r=await post('/v4/posting/fbs/list',{
        sort_dir:'asc',
        filter:{
          order_numbers:[],delivery_method_id:[],last_changed_status_date:{},
          order_id:0,since:from,to,status:[],provider_ids:[],warehouse_ids:[]
        },
        limit:1000,cursor,
        with:{analytics_data:false,barcodes:false,financial_data:false,legal_info:false,translit:false}
      },{allowError:true,retries:2});
      if(r.__error)throw new Error(r.__error);
      const batch=Array.isArray(r.postings)?r.postings:(r?.result?.postings||[]);
      for(const p of batch)if(p?.posting_number)byNumber.set(asStr(p.posting_number),p);
      const next=asStr(first(r.cursor,r?.result?.cursor));
      const hasNext=Boolean(first(r.has_next,r?.result?.has_next));
      if(!batch.length||!hasNext||!next||next===cursor)break;
      cursor=next;
    }
  } return [...byNumber.values()];
}
function normalizePostingMap(postings){
  const out={};
  for(const p of postings||[]){
    const num=asStr(p.posting_number);if(!num)continue;
    out[num]={
      postingNumber:num,status:asStr(p.status),createdAt:asStr(first(p.created_at,p.in_process_at,p.shipment_date,p.delivering_date)),
      products:(p.products||[]).map(x=>({article:asStr(x.offer_id),sku:asStr(x.sku),name:asStr(x.name),quantity:Math.max(0,asNum(x.quantity,0)),price:asNum(x.price,NaN)})).filter(x=>x.article||x.sku)
    };
  } return out;
}
function mergePostingMaps(prevMap,freshMap){
  return {...(prevMap||{}),...(freshMap||{})};
}
async function fetchFbsReturns(fromDate,toDate){
  const out=[];let lastId=0;
  for(let guard=0;guard<1000;guard++){
    const r=await post('/v3/returns/company/fbs',{
      filter:{
        accepted_from_customer_moment:{time_from:`${fromDate}T00:00:00Z`,time_to:`${toDate}T23:59:59Z`},
        last_free_waiting_day:{},order_id:0,posting_number:[],product_name:'',product_offer_id:'',status:''
      },
      limit:1000,last_id:lastId
    },{allowError:true,retries:2});
    if(r.__error)throw new Error(r.__error);
    const batch=Array.isArray(r.returns)?r.returns:[];out.push(...batch);
    const next=asNum(r.last_id,0);
    if(!batch.length||batch.length<1000||!next||next===lastId)break;
    lastId=next;
  }
  return out;
}
async function fetchFboReturns(){
  // v3 FBO return method has no date filter; last_id is used for pagination.
  // The response is item-level (one return id + one SKU), so each row represents one returned unit.
  const out=[];let lastId=0;
  for(let guard=0;guard<1000;guard++){
    const r=await post('/v3/returns/company/fbo',{filter:{posting_number:'',status:[]},last_id:lastId,limit:1000},{allowError:true,retries:2});
    if(r.__error)throw new Error(r.__error);
    const batch=Array.isArray(r.returns)?r.returns:[];out.push(...batch);
    const next=asNum(r.last_id,0);
    if(!batch.length||batch.length<1000||!next||next===lastId)break;
    lastId=next;
  }
  return out;
}
function normalizeReturnRows(fbs,fbo,maps){
  const rows=[];
  for(const r of fbs||[]){
    const sku=asStr(r.sku),article=asStr(first(r.product_offer_id,maps.articleBySku.get(sku)));
    const date=asStr(first(r.accepted_from_customer_moment,r.return_date,r.returned_to_seller_date_time)).slice(0,10);
    const q=Math.max(0,asNum(r.quantity,0));
    if(!date||q<=0||(!article&&!sku))continue;
    rows.push({returnId:`fbs:${asStr(r.id)}`,date,article,sku,name:asStr(r.product_name),quantity:q,postingNumber:asStr(r.posting_number),schema:'FBS',reason:asStr(r.return_reason_name)});
  }
  for(const r of fbo||[]){
    const sku=asStr(r.sku),article=asStr(maps.articleBySku.get(sku));
    const date=asStr(first(r.accepted_from_customer_moment,r.returned_to_ozon_moment)).slice(0,10);
    if(!date||(!article&&!sku))continue;
    rows.push({returnId:`fbo:${asStr(r.id)}`,date,article,sku,name:maps.nameBySku.get(sku)||'',quantity:1,postingNumber:asStr(r.posting_number),schema:'FBO',reason:asStr(r.return_reason_name)});
  }
  return rows;
}
function mergeReturnRows(previousRows,freshRows){
  const map=new Map();
  for(const r of [...(previousRows||[]),...(freshRows||[])]) {
    const k=asStr(r.returnId)||[r.schema,r.date,r.postingNumber,r.sku,r.quantity].join('|');
    map.set(k,r);
  }
  return [...map.values()].sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.returnId).localeCompare(asStr(b.returnId)));
}
function buildRealizedRows(financeRows,postingMap,returnRows,maps){
  /*
    Realized quantity is anchored to Ozon API events:
      + positive sale accrual: exact product quantities from the matching FBO/FBS posting;
      - returns: exact FBS quantity from /v3/returns/company/fbs; FBO response is item-level,
        therefore one return row = one returned unit.

    If a sale posting cannot be resolved or a returns endpoint fails, diagnostics mark the
    quantity layer incomplete. The dashboard then labels the RRP−10% norm as provisional
    instead of silently inventing quantities.
  */
  const rows=[],seenSalePosting=new Set();let unresolvedSaleOps=0;
  for(const f of financeRows){
    const gross=asNum(f.grossRevenue,0),date=f.date;if(!date||gross<=0.00001)continue;
    const pn=asStr(f.postingNumber);if(!pn||seenSalePosting.has(pn))continue;seenSalePosting.add(pn);
    const posting=postingMap[pn];
    if(!posting?.products?.length){unresolvedSaleOps++;continue}
    for(const p of posting.products){
      const article=asStr(first(p.article,maps.articleBySku.get(p.sku))),q=Math.max(0,asNum(p.quantity,0));
      if((!article&&!p.sku)||q<=0)continue;
      rows.push({date,article,sku:p.sku,name:p.name||'',soldQty:q,returnedQty:0,netQty:q,postingNumber:pn,source:'posting+finance'});
    }
  }
  for(const r of returnRows||[]){
    rows.push({date:r.date,article:r.article,sku:r.sku,name:r.name||'',soldQty:0,returnedQty:r.quantity,netQty:-r.quantity,postingNumber:r.postingNumber,source:`returns-${String(r.schema||'').toLowerCase()}`});
  }
  return {rows,diagnostics:{unresolvedSaleOps,returnRows:(returnRows||[]).length,returnedUnits:(returnRows||[]).reduce((a,r)=>a+asNum(r.quantity,0),0)}};
}

/* ------------------------------- analytics ---------------------------- */
const ANALYTICS_METRICS=['revenue','ordered_units','delivered_units','returns','cancellations','hits_view','session_view_pdp','hits_tocart'];
async function fetchAnalyticsSegment(fromDate,toDate){
  const r=await post('/v1/analytics/data',{date_from:fromDate,date_to:toDate,dimension:['sku'],filters:[],metrics:ANALYTICS_METRICS,sort:[{key:'hits_view',order:'DESC'}],limit:1000,offset:0},{allowError:true,retries:1,analytics:true});
  if(r.__error)return {complete:false,error:r.__error,rows:[],totals:[]};
  const rows=r?.result?.data||[],totals=r?.result?.totals||[];
  console.log(`Analytics snapshot: ${fromDate}..${toDate}; skuRows=${rows.length}; topTrafficOnly=${rows.length>=1000}; oneRequest=true`);
  return {complete:true,rows,totals,truncated:rows.length>=1000};
}
function normalizeAnalyticsRows(rawRows,maps){
  const idx=Object.fromEntries(ANALYTICS_METRICS.map((m,i)=>[m,i]));
  return rawRows.map(r=>{const dim=r.dimensions?.[0]||{},sku=asStr(first(dim.id,dim.value,dim.name)),article=asStr(maps.articleBySku.get(sku)),m=r.metrics||[];return{
    name:asStr(first(maps.nameBySku.get(sku),dim.name)),category1:'',category2:'',category3:'',brand:'',scheme:'',sku,article,
    revenue:asNum(m[idx.revenue]),impressions:asNum(m[idx.hits_view]),visits:asNum(m[idx.session_view_pdp]),carts:asNum(m[idx.hits_tocart]),ordered:asNum(m[idx.ordered_units]),delivered:asNum(m[idx.delivered_units]),returns:asNum(m[idx.returns]),cancellations:asNum(m[idx.cancellations])
  }});
}
function aggregateSalesSegments(segments){
  const by=new Map();
  for(const seg of segments||[])for(const r of seg.rows||[]){const k=asStr(r.article)||`sku:${asStr(r.sku)}`;if(!k)continue;const o=by.get(k)||{name:'',category1:'',category2:'',category3:'',brand:'',scheme:'',sku:'',article:'',revenue:0,impressions:0,visits:0,carts:0,ordered:0,delivered:0,returns:0,cancellations:0};for(const f of ['name','category1','category2','category3','brand','scheme','sku','article'])if(!o[f]&&r[f])o[f]=r[f];for(const f of ['revenue','impressions','visits','carts','ordered','delivered','returns','cancellations'])o[f]+=asNum(r[f]);by.set(k,o)}return [...by.values()];
}
async function updateAnalyticsSegments(previousPayload,maps,warnings){
  let segments=Array.isArray(previousPayload?.history?.analyticsSegments)?previousPayload.history.analyticsSegments:[];
  if(SYNC_MODE!=='daily')return segments;
  const lastEnd=segments.map(s=>s.end).filter(Boolean).sort().at(-1)||null;
  let fromDate=lastEnd?addDays(lastEnd,1):HISTORY_START;
  if(fromDate>YESTERDAY){console.log(`Analytics already current through ${lastEnd}; no analytics call.`);return segments}
  // First clean API-only run: one aggregate top-1000 snapshot for the full historical interval.
  // Later daily runs append at most ANALYTICS_MAX_CATCHUP_DAYS.
  const toDate=segments.length?minDateStr(YESTERDAY,addDays(fromDate,ANALYTICS_MAX_CATCHUP_DAYS-1)):YESTERDAY;
  const result=await fetchAnalyticsSegment(fromDate,toDate);
  if(!result.complete){warnings.push(`Analytics ${fromDate}..${toDate}: ${result.error}`);return segments}
  return [...segments,{id:`api-${fromDate}_${toDate}`,start:fromDate,end:toDate,source:'Ozon Seller API top-traffic snapshot',rows:normalizeAnalyticsRows(result.rows,maps),totals:result.totals,metrics:ANALYTICS_METRICS,skuDetailTruncated:result.truncated,note:result.truncated?'SKU funnel detail = top 1000 by views; catalog accounting is sourced from Finance API.':'SKU funnel detail complete.'}];
}

/* -------------------------------- main -------------------------------- */
console.log(`Ozon API-only sync mode=${SYNC_MODE}; today=${TODAY}; historyStart=${HISTORY_START}`);
await testAuth();console.log('Auth OK');
const warnings=[];
const previous=await loadPreviousPayload();
const previousStock=datasetOf(previous,'stock');
const previousPrice=datasetOf(previous,'price');
const previousFinance=datasetOf(previous,'finance');
const previousPostingMap=previous?.history?.postingMap||{};
const previousReturnRows=Array.isArray(previous?.history?.returnRows)?previous.history.returnRows:[];

const products=await fetchProducts().catch(e=>{warnings.push(`Products: ${e}`);return[]});console.log(`Products: ${products.length}`);
const prices=await fetchPrices().catch(e=>{warnings.push(`Prices: ${e}`);return[]});console.log(`Prices: ${prices.length}`);
const stockResult=await fetchProductStocks().catch(e=>{warnings.push(`Stocks: ${e}`);return{rows:[],source:'error',complete:false}});console.log(`Stocks product rows: ${stockResult.rows.length}; complete=${stockResult.complete}`);
const productDetails=await fetchProductDetails(products).catch(e=>{warnings.push(`Product details: ${e}`);return[]});console.log(`Product details: ${productDetails.length}`);
const categoryTree=await fetchCategoryTree().catch(e=>{warnings.push(`Category tree: ${e}`);return[]});console.log(`Category tree roots: ${categoryTree.length}`);

const maps=buildMaps(products,stockResult.rows,previousStock?.rows||[],productDetails,categoryTree);
const priceByArticle=new Map(prices.map(p=>[asStr(first(p.offer_id,p.offerId)),p]).filter(x=>x[0]));
const freshStock=normalizeStock(stockResult.rows,maps,priceByArticle),freshPrice=normalizePrices(prices,maps);
const stockComplete=Boolean(stockResult.complete&&freshStock.length>1000&&(!products.length||freshStock.length>=Math.floor(products.length*.70)));
const stockRows=stockComplete?freshStock:(previousStock?.rows||[]);
const priceRows=freshPrice.length?freshPrice:(previousPrice?.rows||[]);
if(!stockComplete)warnings.push(`Stock refresh incomplete ${freshStock.length}/${products.length}; previous API stock kept.`);
if(!freshPrice.length)warnings.push('Price refresh empty; previous API price kept.');

/* Finance API-only history */
const prevFinanceRows=previousFinance?.rows||[];
const prevFinEnd=prevFinanceRows.map(r=>r.date).filter(Boolean).sort().at(-1)||null;
const financeFrom=previous?maxDateStr(HISTORY_START,addDays(prevFinEnd||TODAY,-(FINANCE_LOOKBACK_DAYS-1))):HISTORY_START;
console.log(`Finance API-only refresh ${financeFrom}..${TODAY}; previous rows=${prevFinanceRows.length}`);
const financeOps=await fetchFinance(financeFrom,TODAY).catch(e=>{warnings.push(`Finance: ${e}`);return[]});
const freshFinance=normalizeFinance(financeOps,maps);
const financeRows=financeOps.length?mergeFinanceRows(prevFinanceRows,freshFinance):prevFinanceRows;
const finTotals=financeTotals(financeRows);
console.log(`Finance fresh operations: ${financeOps.length}; merged rows=${financeRows.length}; gross=${finTotals.grossRevenue.toFixed(2)}; net=${finTotals.netAfterOzon.toFixed(2)}`);

/* Posting product quantities — used for COGS units and the RRP−10% corporate norm */
const postingFrom=previous?maxDateStr(HISTORY_START,addDays(TODAY,-POSTING_LOOKBACK_DAYS)):HISTORY_START;
console.log(`Posting quantity refresh ${postingFrom}..${TODAY}`);
let freshFbo=[],freshFbs=[];
try{freshFbo=await fetchFboPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBO postings: ${e}`)}
try{freshFbs=await fetchFbsPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBS postings: ${e}`)}
const postingMap=mergePostingMaps(previousPostingMap,normalizePostingMap([...freshFbo,...freshFbs]));

/* Exact return quantities */
const returnFrom=previous?maxDateStr(HISTORY_START,addDays(TODAY,-RETURN_LOOKBACK_DAYS)):HISTORY_START;
let freshFbsReturns=[],freshFboReturns=[],returnsComplete=true;
try{freshFbsReturns=await fetchFbsReturns(returnFrom,TODAY)}catch(e){returnsComplete=false;warnings.push(`FBS returns: ${e}`)}
try{freshFboReturns=await fetchFboReturns()}catch(e){returnsComplete=false;warnings.push(`FBO returns: ${e}`)}
const freshReturnRows=normalizeReturnRows(freshFbsReturns,freshFboReturns,maps).filter(r=>r.date>=HISTORY_START&&r.date<=TODAY);
const returnRows=returnsComplete?mergeReturnRows(previousReturnRows,freshReturnRows):previousReturnRows;
const realized=buildRealizedRows(financeRows,postingMap,returnRows,maps);
const realizedRange=datasetRange(realized.rows);
console.log(`Posting map: ${Object.keys(postingMap).length}; returns=${returnRows.length}; returnedUnits=${realized.diagnostics.returnedUnits}; realized rows=${realized.rows.length}; unresolved sale ops=${realized.diagnostics.unresolvedSaleOps}; returnsComplete=${returnsComplete}`);

/* Funnel analytics — one request only in daily mode */
const analyticsSegments=await updateAnalyticsSegments(previous,maps,warnings);
const salesRows=aggregateSalesSegments(analyticsSegments),salesStart=analyticsSegments.map(s=>s.start).filter(Boolean).sort()[0]||null,salesEnd=analyticsSegments.map(s=>s.end).filter(Boolean).sort().at(-1)||null;
const funnelRows=analyticsSegments.flatMap(seg=>(seg.rows||[]).map(r=>({...r,segmentStart:seg.start,segmentEnd:seg.end,segmentTruncated:Boolean(seg.skuDetailTruncated)})));
console.log(`Analytics segments=${analyticsSegments.length}; coverage=${salesStart||'none'}..${salesEnd||'none'}; aggregated SKU rows=${salesRows.length}; segment rows=${funnelRows.length}`);

const generatedAt=new Date().toISOString(),datasets=[];
if(funnelRows.length)datasets.push({id:`api-funnel-${salesStart}_${salesEnd}`,apiAuto:true,type:'funnel',label:'Воронка Ozon API',sheetName:'analytics/data',sourceName:'Ozon Seller API',start:salesStart,end:salesEnd,snapshot:null,importedAt:generatedAt,capabilities:{funnel:true,api:true,topTrafficDetail:true,periodSegmented:true,note:'Для SKU детализация до 1000 товаров с наибольшим трафиком на каждом сегменте.'},rows:funnelRows});
if(realized.rows.length)datasets.push({id:`api-realized-${realizedRange.start}_${realizedRange.end}`,apiAuto:true,type:'realized',label:'Реализованное количество Ozon API',sheetName:'posting fbo/fbs + finance',sourceName:'Ozon Seller API',start:realizedRange.start,end:realizedRange.end,snapshot:null,importedAt:generatedAt,capabilities:{realizedQty:true,api:true,returnsExact:true},rows:realized.rows});
if(stockRows.length)datasets.push({id:`api-stock-${TODAY}`,apiAuto:true,type:'stock',label:'Остатки Ozon API',sheetName:stockComplete?stockResult.source:(previousStock?.sheetName||'previous API snapshot'),sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{stock:true,prices:true,api:true,complete:stockComplete},rows:stockRows});
if(priceRows.length)datasets.push({id:`api-price-${TODAY}`,apiAuto:true,type:'price',label:'Цены Ozon API',sheetName:'product/info/prices',sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{prices:true,tariffEstimate:true,api:true,complete:Boolean(freshPrice.length)},rows:priceRows});
if(financeRows.length){
  const rr=datasetRange(financeRows);
  datasets.push({id:`api-finance-${rr.start}_${rr.end}`,apiAuto:true,type:'finance',label:'Финансы Ozon API',sheetName:'finance/transaction/list',sourceName:'Ozon Seller API',start:rr.start,end:rr.end,snapshot:null,importedAt:generatedAt,capabilities:{finance:true,accrualReport:true,grossRevenue:true,api:true,incremental:true,components:['commission','acquiring','logistics','storage','ads','fines','returns','other'],grossRevenueTotal:finTotals.grossRevenue,rawNetTotal:finTotals.netAfterOzon,componentTotals:finTotals.components,note:'Источник финансов — только Seller API.'},rows:financeRows});
}

const payload={
  version:4,sourcePolicy:'ozon-api-only',generatedAt,syncMode:SYNC_MODE,clientId:CLIENT_ID,datasets,
  history:{analyticsSegments,postingMap,returnRows},
  diagnostics:{
    mode:SYNC_MODE,sourcePolicy:'ozon-api-only',previousApiOnlyStateLoaded:Boolean(previous),historyStart:HISTORY_START,
    products:products.length,productDetails:productDetails.length,categoryTreeRoots:categoryTree.length,prices:prices.length,stockRows:stockRows.length,stockFreshComplete:stockComplete,
    financeRefreshFrom:financeFrom,financeFreshOperations:financeOps.length,financeRows:financeRows.length,financeGrossRevenueTotal:finTotals.grossRevenue,financeNetAfterOzonTotal:finTotals.netAfterOzon,
    postingRefreshFrom:postingFrom,postingMapSize:Object.keys(postingMap).length,fboPostingsFresh:freshFbo.length,fbsPostingsFresh:freshFbs.length,
    returnRefreshFrom:returnFrom,returnsComplete,fbsReturnsFresh:freshFbsReturns.length,fboReturnsFresh:freshFboReturns.length,returnRows:returnRows.length,returnedUnits:realized.diagnostics.returnedUnits,
    realizedRows:realized.rows.length,unresolvedSaleOps:realized.diagnostics.unresolvedSaleOps,
    analyticsSegments:analyticsSegments.length,analyticsCoverage:{from:salesStart,to:salesEnd},analyticsRows:salesRows.length,analyticsSegmentRows:funnelRows.length,analyticsLatestSkuDetailTruncated:Boolean(analyticsSegments.at(-1)?.skuDetailTruncated),
    warnings
  }
};

await fs.mkdir(path.join(process.cwd(),'data'),{recursive:true});
await fs.writeFile(path.join(process.cwd(),'data','ozon-data.enc.json'),JSON.stringify(encryptJson(payload,PASSWORD)));
await fs.writeFile(path.join(process.cwd(),'data','ozon-status.json'),JSON.stringify({ok:warnings.length===0,generatedAt,mode:SYNC_MODE,sourcePolicy:'ozon-api-only',counts:payload.diagnostics,note:'Public status contains no API key or detailed financial rows.'},null,2));
console.log(`Encrypted API-only dashboard state written. warnings=${warnings.length}`);
if(warnings.length)console.warn('Non-fatal sync warnings:',warnings);
