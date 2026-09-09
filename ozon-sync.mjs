import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
  Ozon Seller Analytics — API-only sync (schema v4.6)

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
const DASHBOARD_KEY = String(process.env.DASHBOARD_KEY ?? '').trim().toLowerCase();
// Deterministic 256-bit raw key. Using a 64-hex key removes all passphrase/KDF/Unicode ambiguity.
if (!/^[0-9a-f]{64}$/.test(DASHBOARD_KEY)) throw new Error('DASHBOARD_KEY must be exactly 64 hex characters (32 random bytes)');
const SYNC_MODE = String(process.env.SYNC_MODE || 'fast').toLowerCase();
const PREVIOUS_DATA_URL = process.env.PREVIOUS_DATA_URL || '';
const FINANCE_LOOKBACK_DAYS = Math.max(1, Number(process.env.FINANCE_LOOKBACK_DAYS || 3));
const POSTING_LOOKBACK_DAYS = Math.max(7, Number(process.env.POSTING_LOOKBACK_DAYS || 35));
const RETURN_LOOKBACK_DAYS = Math.max(7, Number(process.env.RETURN_LOOKBACK_DAYS || 35));
const HISTORY_DAYS = Math.max(30, Number(process.env.OZON_HISTORY_DAYS || 120));
const ANALYTICS_MAX_CATCHUP_DAYS = Math.max(1, Number(process.env.ANALYTICS_MAX_CATCHUP_DAYS || 7));

if (!CLIENT_ID || !API_KEY) throw new Error('Missing OZON_CLIENT_ID or OZON_API_KEY');
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
const ymd = s => { const [y,m,d]=String(s).slice(0,10).split('-').map(Number); return {y,m,d}; };
const monthStart = s => `${String(s).slice(0,7)}-01`;
const monthEnd = s => { const {y,m}=ymd(s); return isoDate(new Date(Date.UTC(y,m,0))); };
const nextMonthStart = s => { const {y,m}=ymd(s); return isoDate(new Date(Date.UTC(y,m,1))); };
const firstFullMonthStart = s => String(s).slice(8,10)==='01' ? s : nextMonthStart(s);
const monthKey = s => String(s).slice(0,7);
const dateRange = (fromDate,toDate) => { const out=[]; for(let d=fromDate; d<=toDate; d=addDays(d,1)) out.push(d); return out; };

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
function keyFromHex(hex){
  if(!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('Invalid DASHBOARD_KEY');
  return Buffer.from(hex,'hex');
}
function encryptJson(obj,keyHex){
  const iv=crypto.randomBytes(12);
  const key=keyFromHex(keyHex);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const plain=Buffer.from(JSON.stringify(obj),'utf8');
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  const tag=cipher.getAuthTag();
  return {v:2,alg:'AES-256-GCM',keyMode:'RAW-HEX-256',iv:iv.toString('base64'),data:Buffer.concat([ciphertext,tag]).toString('base64'),generatedAt:obj.generatedAt};
}
function decryptJson(env,keyHex){
  if(env?.keyMode!=='RAW-HEX-256') throw new Error('Previous encrypted state uses legacy password format; clean API-only backfill required');
  const iv=Buffer.from(env.iv,'base64'),data=Buffer.from(env.data,'base64');
  const ciphertext=data.subarray(0,data.length-16),tag=data.subarray(data.length-16);
  const decipher=crypto.createDecipheriv('aes-256-gcm',keyFromHex(keyHex),iv); decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString('utf8'));
}
async function loadPreviousPayload(){
  if(!PREVIOUS_DATA_URL)return null;
  try{
    const sep=PREVIOUS_DATA_URL.includes('?')?'&':'?';
    const res=await fetch(`${PREVIOUS_DATA_URL}${sep}t=${Date.now()}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw new Error(`HTTP ${res.status}`);
    const payload=decryptJson(await res.json(),DASHBOARD_KEY);
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
/*
  Ozon is migrating finance reads from /v3/finance/transaction/list to
  /v1/finance/accrual/by-day.  The sync uses the new daily accrual ledger first
  and keeps the old endpoint only as a temporary fallback.  A refresh window is
  REPLACED by date, not merged by operation id, so migration between endpoint
  formats cannot duplicate the same days.
*/
function money(v){
  if(v&&typeof v==='object'&&'amount' in v)return asNum(v.amount,0);
  return asNum(v,0);
}
let accrualTypeNamesCache=null;
async function fetchAccrualTypeNames(){
  if(accrualTypeNamesCache)return accrualTypeNamesCache;
  const r=await post('/v1/finance/accrual/types',{}, {allowError:true,retries:2});
  if(r.__error){accrualTypeNamesCache=new Map();return accrualTypeNamesCache}
  const rows=r.accrual_types||r.types||r.result?.accrual_types||[];
  accrualTypeNamesCache=new Map(rows.map(x=>[asNum(first(x.id,x.type_id),NaN),asStr(first(x.description,x.name))]).filter(x=>Number.isFinite(x[0])));
  return accrualTypeNamesCache;
}
function classifyService(name){
  const s=asStr(name).toLowerCase();
  if(s.includes('эквайр')||s.includes('acquir'))return'acquiring';
  if(s.includes('хранен')||s.includes('storage')||s.includes('placement'))return'storage';
  if(s.includes('реклам')||s.includes('продвиж')||s.includes('advert')||s.includes('promotion')||s.includes('review'))return'ads';
  if(s.includes('штраф')||s.includes('penalt'))return'fines';
  if(s.includes('возврат')||s.includes('return')||s.includes('cancel'))return'returns';
  if(s.includes('логист')||s.includes('достав')||s.includes('обработ')||s.includes('fulfillment')||s.includes('delivery')||s.includes('packing')||s.includes('crossdock'))return'logistics';
  return'other';
}
async function fetchAccrualsDay(date){
  const out=[];let lastId='';
  for(let guard=0;guard<500;guard++){
    const r=await post('/v1/finance/accrual/by-day',{date,last_id:lastId},{allowError:true,retries:3});
    if(r.__error)throw new Error(r.__error);
    const batch=Array.isArray(r.accruals)?r.accruals:[];out.push(...batch);
    const next=asStr(r.last_id);
    if(!batch.length||!next||next===lastId)break;
    lastId=next;
  }
  return out;
}
function normalizeAccrualFinance(accruals,maps,typeNames){
  const rows=[];
  for(const acc of accruals||[]){
    const products=acc?.posting?.products||[];
    const feeGroups=acc?.item_fees?.fees||[];
    const skus=[...new Set([...products.map(p=>asStr(p.sku)),...feeGroups.map(g=>asStr(g.sku))].filter(Boolean))];
    const singleSku=skus.length===1?skus[0]:'';
    const article=singleSku?asStr(maps.articleBySku.get(singleSku)):'';
    let gross=0;
    const comp={commission:0,acquiring:0,logistics:0,storage:0,ads:0,fines:0,returns:0,other:0};
    for(const prod of products){
      const comm=prod.commission||{};
      gross+=money(comm.seller_price);
      comp.commission+=-money(comm.sale_commission);
      const delivery=prod.delivery||{};
      let serviceSum=0,serviceCount=0;
      for(const srv of delivery.services||[]){
        if(srv?.accrued==null)continue;
        const a=money(srv.accrued);serviceSum+=a;serviceCount++;
        const name=typeNames.get(asNum(srv.type_id,NaN))||`type ${srv.type_id}`;
        comp[classifyService(name)]+=-a;
      }
      if(!serviceCount){const a=money(delivery.total_accrued);if(a)comp.logistics+=-a}
    }
    for(const grp of feeGroups)for(const fee of grp.fees||[]){
      const a=money(fee.accrued),name=typeNames.get(asNum(fee.type_id,NaN))||`type ${fee.type_id}`;
      comp[classifyService(name)]+=-a;
    }
    const nif=acc.non_item_fee;
    if(nif){const a=money(nif.accrued),name=typeNames.get(asNum(nif.type_id,NaN))||`type ${nif.type_id}`;comp[classifyService(name)]+=-a}
    const amount=money(acc.total_amount);
    const known=Object.values(comp).reduce((a,b)=>a+b,0);
    comp.other+=gross-known-amount;
    const date=asStr(acc.date).slice(0,10);
    const stable=crypto.createHash('sha1').update(JSON.stringify(acc)).digest('hex').slice(0,16);
    rows.push({
      date,article,sku:singleSku,postingNumber:asStr(first(acc?.posting?.posting_number,acc.unit_number)),itemSkus:skus,
      group:asStr(acc.accrued_category),operation:asStr(typeNames.get(asNum(acc.type_id,NaN))||`Accrual ${acc.type_id}`),
      transactionId:`accrual:${date}:${asStr(acc.unit_number)}:${asStr(acc.type_id)}:${stable}`,grossRevenue:gross||null,
      soldQty:0,returnedQty:0,commission:comp.commission,acquiring:comp.acquiring,logistics:comp.logistics,storage:comp.storage,
      ads:comp.ads,fines:comp.fines,returns:comp.returns,other:comp.other,rawAmount:amount,financeSource:'accrual/by-day'
    });
  }
  return rows;
}
async function fetchFinanceAccrual(fromDate,toDate,maps){
  const typeNames=await fetchAccrualTypeNames(),rows=[];
  for(const d of dateRange(fromDate,toDate)){
    const acc=await fetchAccrualsDay(d);rows.push(...normalizeAccrualFinance(acc,maps,typeNames));
  }
  return rows;
}
async function fetchFinanceLegacy(fromDate,toDate){
  const operations=[];
  for(const [from,to] of monthChunks(fromDate,toDate)){
    for(let page=1;page<1000;page++){
      const r=await post('/v3/finance/transaction/list',{filter:{date:{from,to},operation_type:[],posting_number:'',transaction_type:'ALL'},page,page_size:1000},{allowError:true,retries:2});
      if(r.__error)throw new Error(r.__error);
      const result=r.result||{},batch=result.operations||[];operations.push(...batch);
      if(!batch.length||page>=asNum(result.page_count,page))break;
    }
  } return operations;
}
function normalizeLegacyFinance(ops,maps){
  const rows=[];
  for(const op of ops){
    const items=Array.isArray(op.items)?op.items:[],single=items.length===1?items[0]:null,sku=asStr(single?.sku),article=asStr(maps.articleBySku.get(sku));
    const gross=asNum(op.accruals_for_sale,0),amount=asNum(op.amount,0);
    const comp={commission:Math.abs(asNum(op.sale_commission,0)),acquiring:0,logistics:Math.abs(asNum(op.delivery_charge,0)),storage:0,ads:0,fines:0,returns:Math.abs(asNum(op.return_delivery_charge,0)),other:0};
    for(const srv of op.services||[])comp[classifyService(srv.name)]+=-asNum(srv.price,0);
    const known=Object.values(comp).reduce((a,b)=>a+b,0);comp.other+=gross-known-amount;
    rows.push({date:asStr(op.operation_date).slice(0,10),article,sku,postingNumber:asStr(op?.posting?.posting_number),itemSkus:items.map(it=>asStr(it?.sku)).filter(Boolean),
      group:asStr(op.type),operation:asStr(first(op.operation_type_name,op.operation_type)),transactionId:asStr(op.operation_id),grossRevenue:gross||null,
      soldQty:0,returnedQty:0,commission:comp.commission,acquiring:comp.acquiring,logistics:comp.logistics,storage:comp.storage,ads:comp.ads,fines:comp.fines,returns:comp.returns,other:comp.other,rawAmount:amount,financeSource:'transaction/list'});
  } return rows;
}
async function fetchFinanceNormalized(fromDate,toDate,maps){
  try{
    const rows=await fetchFinanceAccrual(fromDate,toDate,maps);
    return {rows,source:'finance/accrual/by-day'};
  }catch(e){
    console.warn(`New finance/accrual API failed, trying legacy transaction/list: ${e}`);
    const ops=await fetchFinanceLegacy(fromDate,toDate);
    return {rows:normalizeLegacyFinance(ops,maps),source:'finance/transaction/list (legacy fallback)'};
  }
}
function replaceFinanceWindow(previousRows,freshRows,fromDate,toDate){
  const kept=(previousRows||[]).filter(r=>!r.date||r.date<fromDate||r.date>toDate);
  const out=[...kept,...freshRows];
  out.sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.transactionId).localeCompare(asStr(b.transactionId)));
  return out;
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
        limit:100,sort_dir:'asc',translit:false,
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
        limit:100,cursor,
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
async function fetchUnifiedReturns(fromDate,toDate){
  // Current Ozon endpoint for both FBO and FBS returns.  The legacy
  // /v3/returns/company/fbo and /v3/returns/company/fbs methods are obsolete.
  // /v1/returns/list allows at most 500 rows per page and cursoring by last_id.
  const out=[];let lastId=0;
  for(let guard=0;guard<2000;guard++){
    const r=await post('/v1/returns/list',{
      filter:{logistic_return_date:{time_from:`${fromDate}T00:00:00Z`,time_to:`${toDate}T23:59:59Z`}},
      limit:500,last_id:lastId
    },{allowError:true,retries:2});
    if(r.__error)throw new Error(r.__error);
    const batch=Array.isArray(r.returns)?r.returns:[];out.push(...batch);
    if(!r.has_next||!batch.length)break;
    const next=Math.max(...batch.map(x=>asNum(x.id,0)),0);
    if(!next||next===lastId)break;
    lastId=next;
  }
  return out;
}
function normalizeReturnRows(unified,maps){
  const rows=[];
  for(const r of unified||[]){
    const p=r.product||{},sku=asStr(p.sku),article=asStr(first(p.offer_id,maps.articleBySku.get(sku)));
    const date=asStr(first(r?.logistic?.return_date,r?.logistic?.final_moment,r?.logistic?.technical_return_moment,r?.visual?.change_moment)).slice(0,10);
    const q=Math.max(0,asNum(p.quantity,0));
    if(!date||q<=0||(!article&&!sku))continue;
    const schemaRaw=asStr(r.schema).toUpperCase();
    const schema=schemaRaw.includes('FBS')?'FBS':schemaRaw.includes('FBO')?'FBO':schemaRaw||'UNKNOWN';
    rows.push({
      returnId:`return:${asStr(r.id)}`,date,article,sku,name:asStr(first(p.name,maps.nameBySku.get(sku))),quantity:q,
      postingNumber:asStr(r.posting_number),schema,reason:asStr(r.return_reason_name)
    });
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
function buildPostingFallbackRealizedRows(financeRows,postingMap,returnRows,maps){
  /*
    Realized quantity is anchored to Ozon API events:
      + positive sale accrual: exact product quantities from the matching FBO/FBS posting;
      - returns: exact FBO/FBS quantity from the current /v1/returns/list endpoint.

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


/* -------------------------- official realization ---------------------- */
function realizationMonthBounds(ym){
  const start=`${ym}-01`,end=monthEnd(start);return {start,end};
}
function closedMonthKeys(fromDate,toDate){
  const out=[];let cur=firstFullMonthStart(fromDate),stop=monthStart(toDate);
  while(cur<stop){out.push(monthKey(cur));cur=nextMonthStart(cur)}
  return out;
}
function normalizeRealizationRows(rawRows,start,end,source,granularity){
  const by=new Map();
  for(const r of rawRows||[]){
    const item=r.item||{},article=asStr(item.offer_id),sku=asStr(item.sku),name=asStr(item.name);
    const sold=Math.max(0,asNum(r?.delivery_commission?.quantity,0));
    const returned=Math.max(0,asNum(r?.return_commission?.quantity,0));
    if(!article&&!sku)continue;
    const key=[article,sku].join('|'),o=by.get(key)||{date:end,periodStart:start,periodEnd:end,article,sku,name,soldQty:0,returnedQty:0,netQty:0,source,granularity,official:true};
    o.soldQty+=sold;o.returnedQty+=returned;o.netQty+=sold-returned;by.set(key,o);
  }
  return [...by.values()].filter(r=>r.soldQty||r.returnedQty);
}
async function fetchMonthlyRealization(ym){
  const {y,m}=ymd(`${ym}-01`);
  const r=await post('/v2/finance/realization',{month:m,year:y},{allowError:true,retries:2});
  if(r.__error)throw new Error(r.__error);
  const result=r.result||r,header=result.header||{},b=realizationMonthBounds(ym);
  const start=asStr(header.start_date).slice(0,10)||b.start,end=asStr(header.stop_date).slice(0,10)||b.end;
  return {key:`M:${ym}`,kind:'monthly',start,end,complete:true,official:true,source:'finance/realization',rows:normalizeRealizationRows(result.rows||[],start,end,'finance-realization-monthly','month')};
}
async function fetchDailyRealization(date){
  const {y,m,d}=ymd(date);
  const r=await post('/v1/finance/realization/by-day',{day:d,month:m,year:y},{allowError:true,retries:1});
  if(r.__error){const e=new Error(r.__error);e.status=r.__status;throw e}
  const rows=r.rows||r.result?.rows||[];
  return {key:`D:${date}`,kind:'daily',start:date,end:date,complete:true,official:true,source:'finance/realization/by-day',rows:normalizeRealizationRows(rows,date,date,'finance-realization-by-day','day')};
}
function segmentMap(segments){return new Map((segments||[]).map(s=>[s.key,s]))}
function stripMonthSegments(map,ym){
  for(const [k,s] of [...map])if(monthKey(s.start)===ym&&monthKey(s.end)===ym)map.delete(k);
}
function realizationCoverage(segments){
  const ss=[...(segments||[])].filter(s=>s.start&&s.end).sort((a,b)=>a.start.localeCompare(b.start)||a.end.localeCompare(b.end));
  if(!ss.length)return {start:null,end:null,complete:false,gaps:[]};
  let start=ss[0].start,end=ss[0].end,complete=ss[0].complete!==false;const gaps=[];
  for(let i=1;i<ss.length;i++){
    const s=ss[i],expected=addDays(end,1);
    if(s.start>expected){gaps.push(`${expected}..${addDays(s.start,-1)}`);break}
    if(s.end>end)end=s.end;complete=complete&&s.complete!==false;
  }
  return {start,end,complete:complete&&gaps.length===0,gaps};
}
async function updateRealizationSegments(previous,maps,financeRows,postingMap,returnRows,returnsComplete,warnings){
  const map=segmentMap(previous?.history?.realizationSegments||[]);
  const closed=closedMonthKeys(HISTORY_START,TODAY);
  let monthlyLoaded=0,dailyLoaded=0,dailyPremiumAvailable=true,fallbackDiag={unresolvedSaleOps:0};
  // Closed months: official monthly report is authoritative and replaces any provisional rows.
  for(const ym of closed){
    const key=`M:${ym}`,existing=map.get(key);
    if(existing?.official)continue;
    try{const seg=await fetchMonthlyRealization(ym);stripMonthSegments(map,ym);map.set(seg.key,seg);monthlyLoaded++}
    catch(e){warnings.push(`Realization ${ym}: ${e}`)}
  }
  const currentStart=maxDateStr(monthStart(TODAY),HISTORY_START),currentEnd=YESTERDAY;
  if(currentStart<=currentEnd){
    const currentYm=monthKey(currentStart),needRefresh=SYNC_MODE==='daily'||![...map.values()].some(s=>s.start>=currentStart&&s.end<=currentEnd);
    if(needRefresh){
      // Premium daily realization: first choice for the open month. Refresh missing dates and last 3 days for corrections.
      const dates=dateRange(currentStart,currentEnd),refreshCut=addDays(currentEnd,-2);
      for(const date of dates){
        const key=`D:${date}`;if(map.has(key)&&date<refreshCut)continue;
        try{const seg=await fetchDailyRealization(date);map.set(key,seg);dailyLoaded++}
        catch(e){
          if(e.status===403){dailyPremiumAvailable=false;break}
          warnings.push(`Realization by day ${date}: ${e}`);dailyPremiumAvailable=false;break;
        }
      }
      if(!dailyPremiumAvailable){
        // Fallback only for the currently open month. Closed months remain official monthly reports.
        for(const [k,s] of [...map])if(s.kind==='daily'&&monthKey(s.start)===currentYm)map.delete(k);
        const fRows=(financeRows||[]).filter(r=>r.date>=currentStart&&r.date<=currentEnd);
        const fReturns=(returnRows||[]).filter(r=>r.date>=currentStart&&r.date<=currentEnd);
        const fb=buildPostingFallbackRealizedRows(fRows,postingMap,fReturns,maps);fallbackDiag=fb.diagnostics;
        map.set(`F:${currentYm}`,{key:`F:${currentYm}`,kind:'fallback',start:currentStart,end:currentEnd,complete:returnsComplete&&fb.diagnostics.unresolvedSaleOps===0,official:false,source:'posting+finance fallback',rows:fb.rows.filter(r=>r.date>=currentStart&&r.date<=currentEnd)});
      }
    }
  }
  // If an official monthly report exists, never keep daily/fallback rows for the same closed month.
  for(const ym of closed)if(map.has(`M:${ym}`))for(const [k,s] of [...map])if(k!==`M:${ym}`&&monthKey(s.start)===ym&&monthKey(s.end)===ym)map.delete(k);
  const segments=[...map.values()].filter(s=>s.end>=firstFullMonthStart(HISTORY_START)&&s.start<=YESTERDAY).sort((a,b)=>a.start.localeCompare(b.start)||a.key.localeCompare(b.key));
  const coverage=realizationCoverage(segments);
  const rows=segments.flatMap(s=>(s.rows||[]).map(r=>({...r,segmentKey:s.key,segmentSource:s.source,segmentOfficial:s.official!==false})));
  return {segments,rows,coverage,diagnostics:{monthlyLoaded,dailyLoaded,dailyPremiumAvailable,fallbackUnresolvedSaleOps:fallbackDiag.unresolvedSaleOps||0}};
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
const prevFinanceRows=previous?.history?.financeRowsAll||previousFinance?.rows||[];
const prevFinEnd=prevFinanceRows.map(r=>r.date).filter(Boolean).sort().at(-1)||null;
const financeFrom=previous?maxDateStr(HISTORY_START,addDays(prevFinEnd||TODAY,-(FINANCE_LOOKBACK_DAYS-1))):HISTORY_START;
console.log(`Finance API-only refresh ${financeFrom}..${TODAY}; previous rows=${prevFinanceRows.length}`);
let financeRefresh={rows:[],source:'none'};
try{financeRefresh=await fetchFinanceNormalized(financeFrom,TODAY,maps)}catch(e){warnings.push(`Finance: ${e}`)}
const financeRows=financeRefresh.rows.length?replaceFinanceWindow(prevFinanceRows,financeRefresh.rows,financeFrom,TODAY):prevFinanceRows;
const finTotalsAll=financeTotals(financeRows);
console.log(`Finance fresh rows: ${financeRefresh.rows.length}; source=${financeRefresh.source}; merged rows=${financeRows.length}; gross(all)=${finTotalsAll.grossRevenue.toFixed(2)}; net(all)=${finTotalsAll.netAfterOzon.toFixed(2)}`);

/* Posting product quantities — used for COGS units and the RRP−10% corporate norm */
const postingFrom=previous?maxDateStr(HISTORY_START,addDays(TODAY,-POSTING_LOOKBACK_DAYS)):HISTORY_START;
console.log(`Posting quantity refresh ${postingFrom}..${TODAY}`);
let freshFbo=[],freshFbs=[];
try{freshFbo=await fetchFboPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBO postings: ${e}`)}
try{freshFbs=await fetchFbsPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBS postings: ${e}`)}
const postingMap=mergePostingMaps(previousPostingMap,normalizePostingMap([...freshFbo,...freshFbs]));

/* Exact return quantities */
const returnFrom=previous?maxDateStr(HISTORY_START,addDays(TODAY,-RETURN_LOOKBACK_DAYS)):HISTORY_START;
let freshReturns=[],returnsComplete=true;
try{freshReturns=await fetchUnifiedReturns(returnFrom,TODAY)}catch(e){returnsComplete=false;warnings.push(`Returns: ${e}`)}
const freshReturnRows=normalizeReturnRows(freshReturns,maps).filter(r=>r.date>=HISTORY_START&&r.date<=TODAY);
const returnRows=returnsComplete?mergeReturnRows(previousReturnRows,freshReturnRows):previousReturnRows;
const realization=await updateRealizationSegments(previous,maps,financeRows,postingMap,returnRows,returnsComplete,warnings);
const realizedRange={start:realization.coverage.start,end:realization.coverage.end};
console.log(`Realization segments=${realization.segments.length}; rows=${realization.rows.length}; coverage=${realizedRange.start||'none'}..${realizedRange.end||'none'}; complete=${realization.coverage.complete}; monthlyLoaded=${realization.diagnostics.monthlyLoaded}; dailyLoaded=${realization.diagnostics.dailyLoaded}; dailyPremium=${realization.diagnostics.dailyPremiumAvailable}`);

// Publish finance on exactly the same date range as quantity realization.  This prevents
// the dashboard from mixing a newer finance day with an older quantity/RRP denominator.
const financeRowsPublished=(realizedRange.start&&realizedRange.end)?financeRows.filter(r=>r.date>=realizedRange.start&&r.date<=realizedRange.end):financeRows;
const finTotals=financeTotals(financeRowsPublished);
console.log(`Aligned business period ${realizedRange.start||'finance-start'}..${realizedRange.end||'finance-end'}; finance rows published=${financeRowsPublished.length}; gross=${finTotals.grossRevenue.toFixed(2)}; net=${finTotals.netAfterOzon.toFixed(2)}`);

/* Funnel analytics — one request only in daily mode */
const analyticsSegments=await updateAnalyticsSegments(previous,maps,warnings);
const salesRows=aggregateSalesSegments(analyticsSegments),salesStart=analyticsSegments.map(s=>s.start).filter(Boolean).sort()[0]||null,salesEnd=analyticsSegments.map(s=>s.end).filter(Boolean).sort().at(-1)||null;
const funnelRows=analyticsSegments.flatMap(seg=>(seg.rows||[]).map(r=>({...r,segmentStart:seg.start,segmentEnd:seg.end,segmentTruncated:Boolean(seg.skuDetailTruncated)})));
console.log(`Analytics segments=${analyticsSegments.length}; coverage=${salesStart||'none'}..${salesEnd||'none'}; aggregated SKU rows=${salesRows.length}; segment rows=${funnelRows.length}`);

const generatedAt=new Date().toISOString(),datasets=[];
const dailyRealizationSegments=realization.segments.filter(s=>s.kind==='daily'&&s.complete!==false);
const dailyRealizationStart=dailyRealizationSegments.map(s=>s.start).filter(Boolean).sort()[0]||null;
const dailyRealizationEnd=dailyRealizationSegments.map(s=>s.end).filter(Boolean).sort().at(-1)||null;
if(funnelRows.length)datasets.push({id:`api-funnel-${salesStart}_${salesEnd}`,apiAuto:true,type:'funnel',label:'Воронка Ozon API',sheetName:'analytics/data',sourceName:'Ozon Seller API',start:salesStart,end:salesEnd,snapshot:null,importedAt:generatedAt,capabilities:{funnel:true,api:true,topTrafficDetail:true,periodSegmented:true,note:'Для SKU детализация до 1000 товаров с наибольшим трафиком на каждом сегменте.'},rows:funnelRows});
if(realization.rows.length)datasets.push({id:`api-realized-${realizedRange.start}_${realizedRange.end}`,apiAuto:true,type:'realized',label:'Реализованное количество Ozon API',sheetName:'posting fbo/fbs + finance',sourceName:'Ozon Seller API',start:realizedRange.start,end:realizedRange.end,snapshot:null,importedAt:generatedAt,capabilities:{realizedQty:true,api:true,returnsExact:true,officialMonthly:true,dailyCurrent:true,coverageComplete:realization.coverage.complete,coverageGaps:realization.coverage.gaps,dailyCoverageStart:dailyRealizationStart,dailyCoverageEnd:dailyRealizationEnd},rows:realization.rows});
if(stockRows.length)datasets.push({id:`api-stock-${TODAY}`,apiAuto:true,type:'stock',label:'Остатки Ozon API',sheetName:stockComplete?stockResult.source:(previousStock?.sheetName||'previous API snapshot'),sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{stock:true,prices:true,api:true,complete:stockComplete},rows:stockRows});
if(priceRows.length)datasets.push({id:`api-price-${TODAY}`,apiAuto:true,type:'price',label:'Цены Ozon API',sheetName:'product/info/prices',sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{prices:true,tariffEstimate:true,api:true,complete:Boolean(freshPrice.length)},rows:priceRows});
if(financeRowsPublished.length){
  const rr=datasetRange(financeRowsPublished);
  datasets.push({id:`api-finance-${rr.start}_${rr.end}`,apiAuto:true,type:'finance',label:'Финансы Ozon API',sheetName:financeRefresh.source||'finance API',sourceName:'Ozon Seller API',start:rr.start,end:rr.end,snapshot:null,importedAt:generatedAt,capabilities:{finance:true,accrualReport:true,grossRevenue:true,api:true,incremental:true,components:['commission','acquiring','logistics','storage','ads','fines','returns','other'],grossRevenueTotal:finTotals.grossRevenue,rawNetTotal:finTotals.netAfterOzon,componentTotals:finTotals.components,note:'Источник финансов — только Seller API.'},rows:financeRowsPublished});
}

const payload={
  version:4,sourcePolicy:'ozon-api-only',generatedAt,syncMode:SYNC_MODE,clientId:CLIENT_ID,datasets,
  history:{analyticsSegments,postingMap,returnRows,realizationSegments:realization.segments,financeRowsAll:financeRows},
  diagnostics:{
    mode:SYNC_MODE,sourcePolicy:'ozon-api-only',previousApiOnlyStateLoaded:Boolean(previous),historyStart:HISTORY_START,
    products:products.length,productDetails:productDetails.length,categoryTreeRoots:categoryTree.length,prices:prices.length,stockRows:stockRows.length,stockFreshComplete:stockComplete,
    financeRefreshFrom:financeFrom,financeFreshRows:financeRefresh.rows.length,financeSource:financeRefresh.source,financeRowsAll:financeRows.length,financeRowsPublished:financeRowsPublished.length,financeGrossRevenueTotal:finTotals.grossRevenue,financeNetAfterOzonTotal:finTotals.netAfterOzon,financePublishedRange:{from:realizedRange.start,to:realizedRange.end},
    postingRefreshFrom:postingFrom,postingMapSize:Object.keys(postingMap).length,fboPostingsFresh:freshFbo.length,fbsPostingsFresh:freshFbs.length,
    returnRefreshFrom:returnFrom,returnsApiComplete:returnsComplete,returnsComplete:realization.coverage.complete,returnsFresh:freshReturnRows.length,fbsReturnsFresh:freshReturnRows.filter(r=>r.schema==='FBS').length,fboReturnsFresh:freshReturnRows.filter(r=>r.schema==='FBO').length,returnRows:returnRows.length,
    realizedRows:realization.rows.length,unresolvedSaleOps:realization.coverage.complete?0:realization.diagnostics.fallbackUnresolvedSaleOps,realizationSegments:realization.segments.length,realizationCoverage:{from:realizedRange.start,to:realizedRange.end,complete:realization.coverage.complete,gaps:realization.coverage.gaps},realizationMonthlyLoaded:realization.diagnostics.monthlyLoaded,realizationDailyLoaded:realization.diagnostics.dailyLoaded,realizationDailyPremiumAvailable:realization.diagnostics.dailyPremiumAvailable,
    analyticsSegments:analyticsSegments.length,analyticsCoverage:{from:salesStart,to:salesEnd},analyticsRows:salesRows.length,analyticsSegmentRows:funnelRows.length,analyticsLatestSkuDetailTruncated:Boolean(analyticsSegments.at(-1)?.skuDetailTruncated),
    warnings
  }
};

await fs.mkdir(path.join(process.cwd(),'data'),{recursive:true});
await fs.writeFile(path.join(process.cwd(),'data','ozon-data.enc.json'),JSON.stringify(encryptJson(payload,DASHBOARD_KEY)));
await fs.writeFile(path.join(process.cwd(),'data','ozon-status.json'),JSON.stringify({ok:warnings.length===0,generatedAt,mode:SYNC_MODE,sourcePolicy:'ozon-api-only',counts:payload.diagnostics,note:'Public status contains no API key or detailed financial rows. Realization v4.6 uses official monthly reports + daily current month when available.'},null,2));
console.log(`Encrypted API-only dashboard state written. warnings=${warnings.length}`);
if(warnings.length)console.warn('Non-fatal sync warnings:',warnings);
