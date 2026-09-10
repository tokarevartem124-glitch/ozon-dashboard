import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
  Ozon Seller Analytics — API-only sync (v8.5 unmatched-return diagnostics)

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
const BUSINESS_START = String(process.env.OZON_BUSINESS_START || '2026-06-01').slice(0,10);
const DAILY_QTY_VERSION = 6;
const QUANTITY_ENGINE_VERSION = 9;
const DELIVERY_STATUS_DATE_VERSION = 3;
const DELIVERY_STATUS_SCAN_PAUSE_MS = Math.max(900, Number(process.env.DELIVERY_STATUS_SCAN_PAUSE_MS || 1150));
const DELIVERY_STATUS_REFRESH_DAYS = Math.max(2, Number(process.env.DELIVERY_STATUS_REFRESH_DAYS || 3));
const PREMIUM_DAILY_LOOKBACK_DAYS = Math.max(7, Math.min(31, Number(process.env.PREMIUM_DAILY_LOOKBACK_DAYS || 31)));
const ACCRUAL_POSTING_BATCH = 100;
const ACCRUAL_POSTING_PAUSE_MS = Math.max(300, Number(process.env.ACCRUAL_POSTING_PAUSE_MS || 1100));
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
// The dashboard must retain every day from the business baseline, even after the rolling lookback moves forward.
const HISTORY_START = minDateStr(BUSINESS_START, addDays(TODAY,-(HISTORY_DAYS-1)));
const rfc3339Start = d => `${String(d).slice(0,10)}T00:00:00.000Z`;
const rfc3339End = d => `${String(d).slice(0,10)}T23:59:59.999Z`;
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
  const r=await post('/v1/finance/accrual/types',{}, {allowError:true,retries:4});
  if(r.__error){accrualTypeNamesCache=new Map();return accrualTypeNamesCache}
  const rows=r.accrual_types||r.types||r.result?.accrual_types||[];
  accrualTypeNamesCache=new Map(rows.map(x=>[asNum(first(x.id,x.type_id),NaN),asStr(first(x.description,x.name))]).filter(x=>Number.isFinite(x[0])));
  return accrualTypeNamesCache;
}
function classifyService(name){
  const s=asStr(name).toLowerCase();
  if(s.includes('комисс')||s.includes('commission')||s.includes('вознагражден'))return'commission';
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
function emptyFinanceComponents(){
  return {commission:0,acquiring:0,logistics:0,storage:0,ads:0,fines:0,returns:0,other:0};
}
function normalizeAccrualFinance(accruals,maps,typeNames,postingMap){
  /*
    Business ledger from /v1/finance/accrual/by-day.

    IMPORTANT (v5.8): in /v1/finance/accrual/by-day, commission.sale_amount is already
    the seller economic gross for the SKU line. bonus and coinvestment are included
    inside that economic amount and are retained only as audit breakdown fields.
    Therefore they MUST NOT be added to sale_amount again. seller_price is also
    retained only for audit/fallback. Quantity remains a separate realization layer
    for COGS/RRP. /v1/finance/accrual/postings is deliberately not used for bulk history.
  */
  const rows=[];
  for(const acc of accruals||[]){
    const products=Array.isArray(acc?.posting?.products)?acc.posting.products:[];
    const feeGroups=Array.isArray(acc?.item_fees?.fees)?acc.item_fees.fees:[];
    const date=asStr(acc.date).slice(0,10);
    const postingNumber=asStr(first(acc?.posting?.posting_number,acc.unit_number));
    const stable=crypto.createHash('sha1').update(JSON.stringify(acc)).digest('hex').slice(0,16);
    const operation=asStr(typeNames.get(asNum(first(acc.accrual_id,acc.type_id),NaN))||`Accrual ${first(acc.accrual_id,acc.type_id)}`);
    const group=asStr(acc.accrued_category);
    const bySku=new Map();

    const ensureSku=(sku)=>{
      sku=asStr(sku);
      if(!sku)return null;
      if(!bySku.has(sku))bySku.set(sku,{
        date,
        article:asStr(maps.articleBySku.get(sku)),
        sku,
        postingNumber,
        orderId:asStr(postingMap?.[postingNumber]?.orderId),orderNumber:asStr(postingMap?.[postingNumber]?.orderNumber),orderDate:asStr(postingMap?.[postingNumber]?.orderDate),orderDateSource:asStr(postingMap?.[postingNumber]?.orderDateSource),orderSchema:asStr(postingMap?.[postingNumber]?.orderSchema),
        itemSkus:[sku],
        group,
        operation,
        transactionId:`accrual:${date}:${asStr(acc.unit_number)}:${asStr(first(acc.accrual_id,acc.type_id))}:${stable}:sku:${sku}`,
        grossRevenue:0,
        sellerPriceRaw:0,salePriceRaw:0,saleAmount:0,bonus:0,coinvestment:0,
        soldQty:0,returnedQty:0,financeQtyResolved:0,financeQtyUnresolved:0,
        ...emptyFinanceComponents(),
        rawAmount:0,
        financeSource:'accrual/by-day',
        financeAttribution:'direct_sku',
        parentAccrualId:`${date}:${asStr(acc.unit_number)}:${asStr(first(acc.accrual_id,acc.type_id))}:${stable}`
      });
      return bySku.get(sku);
    };

    for(const prod of products){
      const sku=asStr(prod?.sku),row=ensureSku(sku);
      if(!row)continue;
      const comm=prod?.commission||{};
      const sellerPrice=money(comm.seller_price);
      const salePrice=money(comm.sale_price);
      const saleAmount=money(comm.sale_amount);
      const bonus=money(comm.bonus);
      const coinvestment=money(comm.coinvestment);
      row.sellerPriceRaw+=sellerPrice;
      row.salePriceRaw+=salePrice;
      row.saleAmount+=saleAmount;
      row.bonus+=bonus;
      row.coinvestment+=coinvestment;
      const economicGross=saleAmount;
      row.grossRevenue+=Math.abs(economicGross)>0.0005?economicGross:sellerPrice;

      // Legacy diagnostic only. v7.0 DOES NOT treat sale_amount/seller_price as an
      // authoritative quantity source. Official quantity comes from realization reports.
      // The ratio is retained in persisted finance rows only for audit/backward compatibility.
      if(saleAmount>0.0005){
        let qty=null;
        for(const unit of [Math.abs(sellerPrice),Math.abs(salePrice)]){
          if(unit<=0.0005)continue;
          const rawQty=Math.abs(saleAmount)/unit,rounded=Math.round(rawQty);
          if(rounded>0&&Math.abs(rawQty-rounded)<=0.01){qty=rounded;break}
        }
        if(qty!=null){row.soldQty+=qty;row.financeQtyResolved++}
        else row.financeQtyUnresolved++;
      } else if(saleAmount<-0.0005){
        // Legacy diagnostic only; v7.0 return quantity comes from official realization
        // reports, not from monetary-ratio inference.
        let qty=null;
        for(const unit of [Math.abs(sellerPrice),Math.abs(salePrice)]){
          if(unit<=0.0005)continue;
          const rawQty=Math.abs(saleAmount)/unit,rounded=Math.round(rawQty);
          if(rounded>0&&Math.abs(rawQty-rounded)<=0.01){qty=rounded;break}
        }
        if(qty!=null){row.returnedQty+=qty;row.financeQtyResolved++}
        else row.financeQtyUnresolved++;
      }
      row.commission+=-money(comm.sale_commission);

      const delivery=prod?.delivery||{};
      let serviceCount=0;
      for(const srv of delivery.services||[]){
        if(srv?.accrued==null)continue;
        const a=money(srv.accrued);serviceCount++;
        const tid=asNum(first(srv.accrual_id,srv.type_id),NaN);
        const name=typeNames.get(tid)||`type ${tid}`;
        row[classifyService(name)]+=-a;
      }
      if(!serviceCount){
        const a=money(delivery.total_accrued);
        if(a)row.logistics+=-a;
      }
    }

    for(const grp of feeGroups){
      const row=ensureSku(grp?.sku);
      if(!row)continue;
      for(const fee of grp.fees||[]){
        const a=money(fee.accrued);
        const tid=asNum(first(fee.accrual_id,fee.type_id),NaN);
        const name=typeNames.get(tid)||`type ${tid}`;
        row[classifyService(name)]+=-a;
      }
    }

    const unallocated={
      date,article:'',sku:'',postingNumber,
      itemSkus:[...bySku.keys()],
      group,operation,
      transactionId:`accrual:${date}:${asStr(acc.unit_number)}:${asStr(first(acc.accrual_id,acc.type_id))}:${stable}:unallocated`,
      grossRevenue:0,sellerPriceRaw:0,salePriceRaw:0,saleAmount:0,bonus:0,coinvestment:0,soldQty:0,returnedQty:0,financeQtyResolved:0,financeQtyUnresolved:0,
      ...emptyFinanceComponents(),
      rawAmount:0,financeSource:'accrual/by-day',
      financeAttribution:'unallocated',
      parentAccrualId:`${date}:${asStr(acc.unit_number)}:${asStr(first(acc.accrual_id,acc.type_id))}:${stable}`
    };
    let hasUnallocated=false;
    const nif=acc.non_item_fee;
    if(nif){
      const a=money(nif.accrued);
      const tid=asNum(first(nif.accrual_id,nif.type_id),NaN);
      const name=typeNames.get(tid)||`type ${tid}`;
      unallocated[classifyService(name)]+=-a;
      hasUnallocated=true;
    }
    // container_fees (introduced in July 2026) are seller/container-level.
    for(const fee of acc?.container_fees?.fees||[]){
      const a=money(fee.accrued);
      const tid=asNum(first(fee.accrual_id,fee.type_id),NaN);
      const name=typeNames.get(tid)||`type ${tid}`;
      unallocated[classifyService(name)]+=-a;
      hasUnallocated=true;
    }

    const compKeys=['commission','acquiring','logistics','storage','ads','fines','returns','other'];
    for(const row of bySku.values()){
      const costs=compKeys.reduce((sum,k)=>sum+asNum(row[k],0),0);
      row.rawAmount=asNum(row.grossRevenue,0)-costs;
    }
    {
      const costs=compKeys.reduce((sum,k)=>sum+asNum(unallocated[k],0),0);
      unallocated.rawAmount=-costs;
    }

    const amount=money(acc.total_amount);
    const currentNet=[...bySku.values()].reduce((sum,r)=>sum+asNum(r.rawAmount,0),0)+asNum(unallocated.rawAmount,0);
    const delta=amount-currentNet;
    if(Math.abs(delta)>0.005){
      unallocated.other-=delta;
      unallocated.rawAmount+=delta;
      hasUnallocated=true;
    }

    for(const row of bySku.values()){
      if(Math.abs(row.grossRevenue)<0.0005)row.grossRevenue=null;
      rows.push(row);
    }
    if(hasUnallocated||Math.abs(unallocated.rawAmount)>0.005)rows.push(unallocated);
  }
  return rows;
}

async function fetchFinanceAccrual(fromDate,toDate,maps,postingMap){
  const typeNames=await fetchAccrualTypeNames(),rows=[];
  for(const d of dateRange(fromDate,toDate)){
    const acc=await fetchAccrualsDay(d);rows.push(...normalizeAccrualFinance(acc,maps,typeNames,postingMap));
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
async function fetchFinanceNormalized(fromDate,toDate,maps,postingMap){
  try{
    const rows=await fetchFinanceAccrual(fromDate,toDate,maps,postingMap);
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


/* Direct SKU finance is derived from /v1/finance/accrual/by-day above.
   The separate /v1/finance/accrual/postings endpoint is intentionally avoided
   for bulk sync because it is heavily rate-limited and intended for spot checks. */

/* ------------------------------- postings ----------------------------- */
async function fetchPostingPages(endpoint,bodyFactory,fromDate,toDate,label){
  const byNumber=new Map();
  let totalPages=0;
  for(const [from,to] of monthChunks(fromDate,toDate)){
    let cursor='',pages=0,chunkRows=0;
    for(let guard=0;guard<5000;guard++){
      const body=bodyFactory(from,to,cursor);
      const r=await post(endpoint,body,{allowError:true,retries:2});
      if(r.__error)throw new Error(r.__error);
      const root=(r?.result&&typeof r.result==='object')?r.result:r;
      const batch=Array.isArray(root?.postings)?root.postings:[];
      pages++;totalPages++;chunkRows+=batch.length;
      for(const p of batch)if(p?.posting_number)byNumber.set(asStr(p.posting_number),p);

      // Diagnostic only: if a supposedly historical interval is empty, print the
      // actual response shape. This lets us distinguish an API filter issue from
      // a parser/pagination issue without exposing order/product data.
      if(pages===1&&batch.length===0){
        console.log(`${label} empty first page ${from.slice(0,10)}..${to.slice(0,10)}; responseKeys=${Object.keys(r||{}).join(',')}; rootKeys=${Object.keys(root||{}).join(',')}; cursorPresent=${Boolean(root?.cursor)}; hasNext=${String(root?.has_next)}`);
      }

      const next=asStr(root?.cursor);
      const hasNextRaw=root?.has_next;
      const hasNext=hasNextRaw===undefined||hasNextRaw===null ? batch.length===100 : Boolean(hasNextRaw);
      if(!batch.length||!next||next===cursor||!hasNext)break;
      cursor=next;
      await sleep(700);
    }
    console.log(`${label} postings chunk ${from.slice(0,10)}..${to.slice(0,10)}: pages=${pages}; rows=${chunkRows}; cumulative unique=${byNumber.size}`);
  }
  console.log(`${label} postings complete ${fromDate}..${toDate}: pages=${totalPages}; unique=${byNumber.size}`);
  return [...byNumber.values()];
}
async function fetchFboPostings(fromDate,toDate){
  // Keep the request minimal. Optional empty arrays (posting_number/order_number/status)
  // are intentionally omitted: some live API revisions treat an explicitly empty
  // filter differently from an absent filter and can return an empty set.
  return fetchPostingPages('/v3/posting/fbo/list',(from,to,cursor)=>({
    cursor,
    filter:{since:rfc3339Start(from),to:rfc3339End(to)},
    limit:100,
    sort_dir:'asc',
    translit:false,
    with:{analytics_data:false,financial_data:false,legal_info:false}
  }),fromDate,toDate,'FBO');
}
async function fetchFbsPostings(fromDate,toDate){
  // Same rule for FBS v4: only the required date window is sent in filter.
  // Do not send order_id:0, empty status/provider/warehouse arrays or an empty
  // last_changed_status_date object during historical backfill.
  return fetchPostingPages('/v4/posting/fbs/list',(from,to,cursor)=>({
    sort_dir:'asc',
    filter:{since:rfc3339Start(from),to:rfc3339End(to)},
    limit:100,
    cursor,
    translit:false,
    with:{analytics_data:false,barcodes:false,financial_data:false,legal_info:false,translit:false}
  }),fromDate,toDate,'FBS');
}

async function fetchFbsDeliveredStatusDay(date){
  const out=[];let cursor='',pages=0;
  for(let guard=0;guard<500;guard++){
    const r=await post('/v4/posting/fbs/list',{
      sort_dir:'asc',
      filter:{
        // Ozon v4 requires the base `since`/`to` window even when
        // `last_changed_status_date` is supplied.  Use a wide (<= 1 year)
        // posting window so orders created before the delivery day are not
        // accidentally excluded; the one-day status-change filter remains
        // the exact delivery-day selector.
        since:rfc3339Start(addDays(date,-364)),
        to:rfc3339End(date),
        last_changed_status_date:{from:rfc3339Start(date),to:rfc3339End(date)},
        status:['delivered']
      },
      limit:100,cursor,translit:false,
      with:{analytics_data:false,barcodes:false,financial_data:false,legal_info:false,translit:false}
    },{allowError:true,retries:4});
    if(r.__error)throw new Error(r.__error);
    const root=(r?.result&&typeof r.result==='object')?r.result:r;
    const batch=Array.isArray(root?.postings)?root.postings:[];pages++;
    for(const row of batch)out.push({...row,__exactDeliveredDate:date});
    const next=asStr(root?.cursor),hasNext=Boolean(root?.has_next);
    if(!batch.length||!hasNext||!next||next===cursor)break;
    cursor=next;await sleep(DELIVERY_STATUS_SCAN_PAUSE_MS);
  }
  return {rows:out,pages};
}
async function updateFbsDeliveredDateHistory(previous,warnings){
  const previousDays=new Set(Array.isArray(previous?.history?.fbsDeliveredDays)?previous.history.fbsDeliveredDays:[]);
  // Keep a short pre-business delivery history as return-matching context. A return
  // inside the reporting horizon can legitimately belong to an order delivered before
  // BUSINESS_START; knowing that delivery date lets us classify it as a pre-period
  // return instead of treating it as a broken unmatched return.
  const deliveryHistoryStart=HISTORY_START;
  const required=YESTERDAY>=deliveryHistoryStart?dateRange(deliveryHistoryStart,YESTERDAY):[];
  const versionMismatch=previous?.diagnostics?.deliveryStatusDateVersion!==DELIVERY_STATUS_DATE_VERSION;
  const recentFrom=maxDateStr(deliveryHistoryStart,addDays(YESTERDAY,-(DELIVERY_STATUS_REFRESH_DAYS-1)));
  const recent=(recentFrom&&recentFrom<=YESTERDAY)?dateRange(recentFrom,YESTERDAY):[];
  const missingBefore=required.filter(d=>!previousDays.has(d));
  const fullBackfill=versionMismatch||!previousDays.size;
  const days=fullBackfill?required:[...new Set([...missingBefore,...recent])].sort();
  const rows=[];let fetchedDays=0,totalPages=0;
  const scanned=new Set(previousDays);
  if(days.length){
    console.log(`FBS exact delivery-date ${fullBackfill?'backfill':'refresh'} ${days[0]}..${days.at(-1)}; requests=${days.length}; missingBefore=${missingBefore.length}`);
    for(let i=0;i<days.length;i++){
      const date=days[i];
      try{
        const r=await fetchFbsDeliveredStatusDay(date);rows.push(...r.rows);totalPages+=r.pages;fetchedDays++;scanned.add(date);
        if(fullBackfill||r.rows.length)console.log(`FBS delivered-status ${date}: rows=${r.rows.length}; pages=${r.pages}`);
      }catch(e){warnings.push(`FBS delivered-status ${date}: ${e}`)}
      if(i<days.length-1)await sleep(DELIVERY_STATUS_SCAN_PAUSE_MS);
    }
  }
  const missing=required.filter(d=>!scanned.has(d));
  console.log(`FBS exact delivery-date history: exactPostings=${rows.length}; scannedDays=${scanned.size}; missingDays=${missing.length}; complete=${missing.length===0}`);
  return {rows,scannedDays:[...scanned].sort(),missingDays:missing,complete:missing.length===0,fullBackfill,fetchedDays,totalPages};
}
function normalizePostingMap(postings,previousMap={}){
  const out={};
  for(const p of postings||[]){
    const num=asStr(p.posting_number);if(!num)continue;
    const prev=previousMap?.[num]||{};
    const status=asStr(first(p.status,p.status_alias));
    // v8.4 recovers the exact FBS delivery day historically by querying v4/list
    // with status=delivered + last_changed_status_date for one calendar day. For
    // future transitions we still retain the first hourly observation as a fallback.
    const exactDeliveredDate=asStr(p.__exactDeliveredDate).slice(0,10);
    const observedDeliveredDate=exactDeliveredDate||asStr(prev.observedDeliveredDate)||(status.toLowerCase()==='delivered'&&prev.status&&asStr(prev.status).toLowerCase()!=='delivered'?TODAY:'');
    const observedDeliveredDateSource=exactDeliveredDate?'fbs-last-changed-status-date':(asStr(prev.observedDeliveredDateSource)||(observedDeliveredDate?'posting-status-transition':''));
    out[num]={
      ...prev,postingNumber:num,status,
      orderId:asStr(first(p.order_id,prev.orderId)),
      orderNumber:asStr(first(p.order_number,p.external_order?.number,prev.orderNumber)),
      orderDate:asStr(first(p.created_at,prev.orderDate)).slice(0,10),
      orderDateSource:first(p.created_at,prev.orderDate)?'posting-created-at':asStr(prev.orderDateSource),
      orderSchema:asStr(first(p.delivery_schema,p.scheme,p.tpl_integration_type,prev.orderSchema)),
      observedDeliveredDate,observedDeliveredDateSource,
      createdAt:asStr(first(p.created_at,prev.createdAt,p.in_process_at,p.delivering_date,p.shipment_date)),
      products:(p.products||[]).map(x=>({
        article:asStr(first(x.offer_id,x.product_offer_id)),
        sku:asStr(first(x.sku,x.product_id)),
        name:asStr(first(x.name,x.product_name)),
        quantity:Math.max(0,asNum(x.quantity,0)),price:money(x.price)
      })).filter(x=>x.article||x.sku)
    };
  } return out;
}
function mergePostingMaps(prevMap,freshMap){
  const out={...(prevMap||{})};
  for(const [k,v] of Object.entries(freshMap||{}))out[k]={...(out[k]||{}),...v};
  return out;
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
    v6.5 daily realized quantity:
      SALES   -> explicit FBO/FBS posting quantity first; Finance ratio only as fallback.
      RETURNS -> negative Finance sale_amount / unit price.

    IMPORTANT: /v1/returns/list is a logistics-return feed, not a one-to-one realization
    feed. Counting every row there as a realized return overcounted June-August heavily
    (e.g. 123 logistics return units vs 8 official realization returns in June). It is
    retained in history/audit, but is no longer subtracted from realized quantity.
  */
  const rows=[];
  let unresolvedSaleOps=0,unresolvedReturnOps=0,financeQtyRows=0,postingQtyRows=0,financeReturnRows=0;
  const seenPostingQty=new Set();
  const seenFinanceReturn=new Set();
  const unresolvedExamples=[];
  const unresolvedReturnExamples=[];

  for(const f of financeRows||[]){
    const sale=asNum(first(f.saleAmount,f.grossRevenue),0),date=f.date;
    if(!date||Math.abs(sale)<=0.00001)continue;
    const article=asStr(first(f.article,maps.articleBySku.get(asStr(f.sku)))),sku=asStr(f.sku);
    const pn=asStr(f.postingNumber),posting=pn?postingMap[pn]:null;

    if(sale>0){
      // Sales: count posting+SKU once even if several accrual rows refer to it.
      if(posting?.products?.length){
        const matches=posting.products.filter(p=>(sku&&asStr(p.sku)===sku)||(article&&asStr(p.article)===article));
        if(matches.length){
          const key=[date,pn,sku||article].join('|');
          if(!seenPostingQty.has(key)){
            seenPostingQty.add(key);
            let pushed=false;
            for(const p of matches){
              const a=asStr(first(article,p.article,maps.articleBySku.get(p.sku))),q=Math.max(0,asNum(p.quantity,0));
              if((!a&&!p.sku)||q<=0)continue;
              rows.push({date,article:a,sku:asStr(first(sku,p.sku)),name:p.name||'',soldQty:q,returnedQty:0,netQty:q,postingNumber:pn,source:'posting-quantity'});
              postingQtyRows++;pushed=true;
            }
            if(pushed)continue;
          } else continue;
        }
      }
      const directQty=Math.max(0,asNum(f.soldQty,0));
      if(directQty>0&&(article||sku)){
        rows.push({date,article,sku,name:asStr(first(maps.nameBySku.get(sku),'')),soldQty:directQty,returnedQty:0,netQty:directQty,postingNumber:pn,source:'finance-ratio-fallback'});
        financeQtyRows++;continue;
      }
      unresolvedSaleOps++;
      if(unresolvedExamples.length<20)unresolvedExamples.push({date,postingNumber:pn,sku,article,saleAmount:sale});
      continue;
    }

    // Returns/reversals: never use total shipment quantity. Use the quantity inferred
    // from the negative finance line, which represents the actual reversed amount.
    const q=Math.max(0,asNum(f.returnedQty,0));
    if(q>0&&(article||sku)){
      // A finance accrual object can yield more than one normalized row; transactionId
      // keeps genuinely distinct reversal rows while preventing accidental duplicates.
      const key=asStr(f.transactionId)||[date,pn,sku||article,sale].join('|');
      if(!seenFinanceReturn.has(key)){
        seenFinanceReturn.add(key);
        rows.push({date,article,sku,name:asStr(first(maps.nameBySku.get(sku),'')),soldQty:0,returnedQty:q,netQty:-q,postingNumber:pn,source:'finance-return-quantity'});
        financeReturnRows++;
      }
    }else{
      unresolvedReturnOps++;
      if(unresolvedReturnExamples.length<20)unresolvedReturnExamples.push({date,postingNumber:pn,sku,article,saleAmount:sale,sellerPrice:asNum(f.sellerPriceRaw,0),salePrice:asNum(f.salePriceRaw,0)});
    }
  }

  return {rows,diagnostics:{
    unresolvedSaleOps,unresolvedReturnOps,financeQtyRows,postingQtyRows,financeReturnRows,
    unresolvedExamples,unresolvedReturnExamples,
    logisticsReturnRows:(returnRows||[]).length,
    logisticsReturnedUnits:(returnRows||[]).reduce((a,r)=>a+asNum(r.quantity,0),0)
  }};
}

function aggregateRealizedBySku(rows,start,end){
  const by=new Map();
  for(const r of rows||[]){
    if(start&&r.date<start)continue;if(end&&r.date>end)continue;
    const k=[asStr(r.article),asStr(r.sku)].join('|');
    const o=by.get(k)||{article:asStr(r.article),sku:asStr(r.sku),soldQty:0,returnedQty:0,netQty:0};
    o.soldQty+=asNum(r.soldQty,0);o.returnedQty+=asNum(r.returnedQty,0);o.netQty+=asNum(r.netQty,0);by.set(k,o);
  }
  return by;
}
function validateDailyAgainstMonthly(dailyRows,officialSegments){
  const months=[];let totalAbsSkuDelta=0,totalNetDelta=0,ok=true;
  for(const seg of (officialSegments||[]).filter(s=>s.kind==='monthly'&&s.official!==false)){
    const a=aggregateRealizedBySku(dailyRows,seg.start,seg.end),b=aggregateRealizedBySku(seg.rows||[]);
    const keys=new Set([...a.keys(),...b.keys()]);let absSkuDelta=0;
    for(const k of keys)absSkuDelta+=Math.abs(asNum(a.get(k)?.netQty,0)-asNum(b.get(k)?.netQty,0));
    const dailyVals=[...a.values()],officialVals=[...b.values()];
    const dailySold=dailyVals.reduce((z,r)=>z+r.soldQty,0),officialSold=officialVals.reduce((z,r)=>z+r.soldQty,0);
    const dailyReturned=dailyVals.reduce((z,r)=>z+r.returnedQty,0),officialReturned=officialVals.reduce((z,r)=>z+r.returnedQty,0);
    const dailyNet=dailyVals.reduce((z,r)=>z+r.netQty,0),officialNet=officialVals.reduce((z,r)=>z+r.netQty,0);
    const soldDelta=dailySold-officialSold,returnDelta=dailyReturned-officialReturned,netDelta=dailyNet-officialNet;totalAbsSkuDelta+=absSkuDelta;totalNetDelta+=netDelta;
    const monthOk=Math.abs(soldDelta)<0.001&&Math.abs(returnDelta)<0.001&&Math.abs(netDelta)<0.001&&absSkuDelta<0.001;ok=ok&&monthOk;
    months.push({month:monthKey(seg.start),dailySold,officialSold,soldDelta,dailyReturned,officialReturned,returnDelta,dailyNet,officialNet,netDelta,absSkuDelta,ok:monthOk});
  }
  return {ok:months.length>0&&ok,months,totalAbsSkuDelta,totalNetDelta};
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
async function fetchPostingRealization(ym){
  const {y,m}=ymd(`${ym}-01`);
  const r=await post('/v1/finance/realization/posting',{month:m,year:y},{allowError:true,retries:3});
  if(r.__error){
    const e=new Error(r.__error);e.status=r.__status;throw e;
  }
  const result=r.result||r;
  return {header:result.header||{},rows:Array.isArray(result.rows)?result.rows:[]};
}
function normalizePostingRealizationRows(rawRows,ym,maps){
  const by=new Map();
  for(const r of rawRows||[]){
    const item=r.item||{},sku=asStr(item.sku),article=asStr(first(item.offer_id,maps.articleBySku.get(sku))),pn=asStr(r?.order?.posting_number);
    const sold=Math.max(0,asNum(r?.delivery_commission?.quantity,0));
    const returned=Math.max(0,asNum(r?.return_commission?.quantity,0));
    if((!pn)||(!article&&!sku)||(!sold&&!returned))continue;
    const key=[pn,sku||article].join('|');
    const o=by.get(key)||{
      month:ym,postingNumber:pn,article,sku,name:asStr(first(item.name,maps.nameBySku.get(sku))),
      soldQty:0,returnedQty:0,
      saleUnitPrice:asNum(first(r?.delivery_commission?.price_per_instance,r?.seller_price_per_instance),NaN),
      returnUnitPrice:asNum(first(r?.return_commission?.price_per_instance,r?.seller_price_per_instance),NaN),
      orderId:asStr(first(r?.order?.order_id,r?.order?.id)),
      orderNumber:asStr(first(r?.order?.order_number,r?.order?.number)),
      orderCreatedDate:asStr(first(r?.order?.created_date,r?.order?.created_at)).slice(0,10),
      legalSaleDate:asStr(r?.legal_entity_document?.sale_date).slice(0,10)
    };
    o.soldQty+=sold;o.returnedQty+=returned;
    if(!Number.isFinite(o.saleUnitPrice))o.saleUnitPrice=asNum(first(r?.delivery_commission?.price_per_instance,r?.seller_price_per_instance),NaN);
    if(!Number.isFinite(o.returnUnitPrice))o.returnUnitPrice=asNum(first(r?.return_commission?.price_per_instance,r?.seller_price_per_instance),NaN);
    by.set(key,o);
  }
  return [...by.values()];
}
function validationBetweenRealizedRows(aRows,bRows,start,end){
  const a=aggregateRealizedBySku(aRows,start,end),b=aggregateRealizedBySku(bRows,start,end);
  const keys=new Set([...a.keys(),...b.keys()]);
  let absSkuSoldDelta=0,absSkuReturnDelta=0,absSkuNetDelta=0;
  for(const k of keys){
    absSkuSoldDelta+=Math.abs(asNum(a.get(k)?.soldQty,0)-asNum(b.get(k)?.soldQty,0));
    absSkuReturnDelta+=Math.abs(asNum(a.get(k)?.returnedQty,0)-asNum(b.get(k)?.returnedQty,0));
    absSkuNetDelta+=Math.abs(asNum(a.get(k)?.netQty,0)-asNum(b.get(k)?.netQty,0));
  }
  const av=[...a.values()],bv=[...b.values()];
  const aSold=av.reduce((z,r)=>z+r.soldQty,0),bSold=bv.reduce((z,r)=>z+r.soldQty,0);
  const aReturned=av.reduce((z,r)=>z+r.returnedQty,0),bReturned=bv.reduce((z,r)=>z+r.returnedQty,0);
  const aNet=av.reduce((z,r)=>z+r.netQty,0),bNet=bv.reduce((z,r)=>z+r.netQty,0);
  return {aSold,bSold,soldDelta:aSold-bSold,aReturned,bReturned,returnDelta:aReturned-bReturned,aNet,bNet,netDelta:aNet-bNet,absSkuSoldDelta,absSkuReturnDelta,absSkuNetDelta,ok:absSkuSoldDelta<0.001&&absSkuReturnDelta<0.001&&absSkuNetDelta<0.001};
}
function postingTargetsAsRows(targets,ym){
  const end=monthEnd(`${ym}-01`);
  return (targets||[]).map(t=>({date:end,article:t.article,sku:t.sku,soldQty:t.soldQty,returnedQty:t.returnedQty,netQty:t.soldQty-t.returnedQty}));
}
function validatePostingTargetsAgainstMonthly(targets,monthlySeg,ym){
  return validationBetweenRealizedRows(postingTargetsAsRows(targets,ym),monthlySeg?.rows||[],monthlySeg?.start,monthlySeg?.end);
}
async function fetchAccrualPostingsBatched(postingNumbers,typeNames,warnings){
  const nums=[...new Set((postingNumbers||[]).map(asStr).filter(Boolean))];
  const rows=[];let batches=0,failedBatches=0;
  for(let i=0;i<nums.length;i+=ACCRUAL_POSTING_BATCH){
    const batch=nums.slice(i,i+ACCRUAL_POSTING_BATCH);batches++;
    const r=await post('/v1/finance/accrual/postings',{posting_numbers:batch},{allowError:true,retries:4});
    if(r.__error){
      failedBatches++;warnings.push(`Accrual postings batch ${batches}: ${r.__error}`);
    }else{
      for(const p of r.posting_accruals||r.result?.posting_accruals||[]){
        const pn=asStr(p.posting_number);
        for(const a of p.accruals||[]){
          const sku=asStr(a.sku),tid=asNum(a.type_id,NaN);
          rows.push({postingNumber:pn,sku,date:asStr(a.accrual_date).slice(0,10),quantity:asNum(a.quantity,0),sellerPrice:money(a.seller_price),accrued:money(a.accrued),typeId:tid,typeName:asStr(typeNames.get(tid)||'')});
        }
      }
    }
    if(i+ACCRUAL_POSTING_BATCH<nums.length)await sleep(ACCRUAL_POSTING_PAUSE_MS);
  }
  console.log(`Accrual postings v7: requested=${nums.length}; batches=${batches}; failedBatches=${failedBatches}; accrualRows=${rows.length}`);
  return {rows,batches,failedBatches};
}
function buildFinanceEventIndex(financeRows){
  const idx=new Map();
  for(const f of financeRows||[]){
    const pn=asStr(f.postingNumber),sku=asStr(f.sku),date=asStr(f.date).slice(0,10);
    if(!pn||!sku||!date)continue;
    const key=`${pn}|${sku}`,arr=idx.get(key)||[];
    arr.push({date,saleAmount:asNum(first(f.saleAmount,f.grossRevenue),0),sellerPrice:asNum(f.sellerPriceRaw,0),salePrice:asNum(f.salePriceRaw,0),transactionId:asStr(f.transactionId)});idx.set(key,arr);
  }
  return idx;
}
function buildAccrualEventIndex(accrualRows){
  const idx=new Map();
  for(const a of accrualRows||[]){
    const key=`${asStr(a.postingNumber)}|${asStr(a.sku)}`,arr=idx.get(key)||[];arr.push(a);idx.set(key,arr);
  }
  return idx;
}
function financePositiveRevenueIndex(financeRows){
  const idx=new Map();
  for(const f of financeRows||[]){
    if(f.financeAttribution!=='direct_sku'&&!(f.sku||f.article))continue;
    const pn=asStr(f.postingNumber),sku=asStr(f.sku),article=asStr(f.article);
    if(!pn||(!sku&&!article))continue;
    const v=asNum(first(f.saleAmount,f.grossRevenue),0);if(v<=0.00001)continue;
    const key=`${pn}|${sku||article}`,o=idx.get(key)||{gross:0,dates:new Set()};o.gross+=v;if(f.date)o.dates.add(asStr(f.date));idx.set(key,o);
  }
  return idx;
}
function buildOpenMonthSalesFromPostings(postingMap,start,end,financeRows,maps){
  const revenueIdx=financePositiveRevenueIndex(financeRows),rows=[];
  for(const pm of Object.values(postingMap||{})){
    const date=asStr(pm.observedDeliveredDate).slice(0,10);
    if(!date||date<start||date>end||asStr(pm.status).toLowerCase()!=='delivered')continue;
    for(const prod of pm.products||[]){
      const q=Math.max(0,asNum(prod.quantity,0));if(q<=0)continue;
      const sku=asStr(prod.sku),article=asStr(first(prod.article,maps.articleBySku.get(sku)));if(!sku&&!article)continue;
      const fin=revenueIdx.get(`${asStr(pm.postingNumber)}|${sku||article}`);
      const postingUnit=asNum(prod.price,NaN);
      const unit=fin&&fin.gross>0?fin.gross/q:(Number.isFinite(postingUnit)&&postingUnit>0?postingUnit:NaN);
      rows.push({
        date,deliveryDate:date,deliveryDateExact:true,deliveryDateSource:asStr(pm.observedDeliveredDateSource)||'fbs-last-changed-status-date',returnDate:'',
        article,sku,name:asStr(first(prod.name,maps.nameBySku.get(sku))),soldQty:q,returnedQty:0,netQty:q,
        postingNumber:asStr(pm.postingNumber),orderId:asStr(pm.orderId),orderNumber:asStr(pm.orderNumber),orderDate:asStr(pm.orderDate).slice(0,10),orderDateSource:asStr(pm.orderDateSource),orderSchema:asStr(pm.orderSchema),
        unitPrice:Number.isFinite(unit)?unit:null,source:fin?'open-month-delivered-posting+finance-revenue':'open-month-delivered-posting+posting-price',officialQuantity:false,dateAttribution:'fbs-last-changed-status-date',provisional:!fin
      });
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||asStr(a.postingNumber).localeCompare(asStr(b.postingNumber))||asStr(a.sku).localeCompare(asStr(b.sku)));
  return rows;
}
function dayDistance(a,b){return Math.abs(Math.round((new Date(`${a}T00:00:00Z`)-new Date(`${b}T00:00:00Z`))/86400000))}
function buildOpenMonthReturnsFromDaily(officialDaily,start,end,financeRows,returnRows,postingMap,maps){
  const neg=(financeRows||[]).filter(f=>f.date>=start&&f.date<=end&&asNum(first(f.saleAmount,f.grossRevenue),0)<-0.00001&&asStr(f.postingNumber)&&(f.sku||f.article));
  const logistics=(returnRows||[]).filter(r=>r.date>=addDays(start,-7)&&r.date<=addDays(end,7)&&asStr(r.postingNumber)&&(r.sku||r.article));
  const rows=[],unresolved=[];
  const controls=(officialDaily||[]).filter(s=>s.kind==='daily'&&s.official!==false&&s.start>=start&&s.end<=end);
  for(const seg of controls)for(const ctl of seg.rows||[]){
    const q=Math.max(0,asNum(ctl.returnedQty,0));if(q<=0)continue;
    const sku=asStr(ctl.sku),article=asStr(ctl.article),date=seg.start;
    let candidates=neg.filter(f=>(sku&&asStr(f.sku)===sku)||(!sku&&article&&asStr(f.article)===article)).filter(f=>f.date===date);
    let identitySource='finance-return-same-day';
    if(!candidates.length){candidates=neg.filter(f=>((sku&&asStr(f.sku)===sku)||(!sku&&article&&asStr(f.article)===article))&&dayDistance(f.date,date)<=3);identitySource='finance-return-near-day'}
    const groups=new Map();
    for(const f of candidates){const pn=asStr(f.postingNumber),k=`${pn}|${sku||article}`,o=groups.get(k)||{postingNumber:pn,hint:0};o.hint=Math.max(o.hint,Math.max(0,asNum(f.returnedQty,0)));groups.set(k,o)}
    if(!groups.size){
      const lc=logistics.filter(r=>((sku&&asStr(r.sku)===sku)||(!sku&&article&&asStr(r.article)===article))&&dayDistance(r.date,date)<=7);
      for(const r of lc){const pn=asStr(r.postingNumber),k=`${pn}|${sku||article}`,o=groups.get(k)||{postingNumber:pn,hint:0};o.hint=Math.max(o.hint,Math.max(0,asNum(r.quantity,0)));groups.set(k,o)}
      identitySource='returns-list-identity';
    }
    let alloc=[];const gs=[...groups.values()];
    if(gs.length===1)alloc=[{...gs[0],qty:q}];
    else if(gs.length){
      const hintSum=gs.reduce((z,g)=>z+g.hint,0);
      if(hintSum===q&&gs.every(g=>g.hint>0))alloc=gs.map(g=>({...g,qty:g.hint}));
      else if(Number.isInteger(q)&&q===gs.length)alloc=gs.map(g=>({...g,qty:1}));
    }
    if(!alloc.length){unresolved.push({date,sku,article,qty:q,candidates:gs.length});continue}
    for(const a of alloc){
      const pm=postingMap?.[a.postingNumber]||{};
      rows.push({date,deliveryDate:'',deliveryDateExact:null,deliveryDateSource:'',returnDate:date,article:asStr(first(article,maps.articleBySku.get(sku))),sku,name:asStr(first(ctl.name,maps.nameBySku.get(sku))),soldQty:0,returnedQty:a.qty,netQty:-a.qty,postingNumber:a.postingNumber,orderId:asStr(pm.orderId),orderNumber:asStr(pm.orderNumber),orderDate:asStr(pm.orderDate).slice(0,10),orderDateSource:asStr(pm.orderDateSource),orderSchema:asStr(pm.orderSchema),unitPrice:null,source:`official-daily-return+${identitySource}`,officialQuantity:true,dateAttribution:'official-daily-return'});
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||asStr(a.postingNumber).localeCompare(asStr(b.postingNumber))||asStr(a.sku).localeCompare(asStr(b.sku)));
  return {rows,unresolved};
}

function strongAccrualKind(a){
  /*
    /v1/finance/accrual/postings contains MANY accrual types for the same SKU and
    posting.  seller_price/accrued sign is not a safe event classifier on its own:
    commissions/services can also be negative.  Only the accrual-type dictionary is
    allowed to classify a row when Finance by-day did not already give us candidate
    event dates.
  */
  const text=asStr(a.typeName).toLowerCase();
  const isReturn=/возврат|return|refund|сторно|reverse/.test(text);
  const isSale=/реализ|реализац|продаж|sale|выкуп/.test(text)&&!isReturn;
  return isReturn?'return':isSale?'sale':'';
}
function accrualDateAllocation(accrualEvents,kind,targetQty,ym,financeDates=[]){
  const monthStartDate=`${ym}-01`,monthEndDate=monthEnd(monthStartDate);
  const finSet=new Set(financeDates||[]);
  let candidates=(accrualEvents||[]).filter(a=>a.date>=monthStartDate&&a.date<=monthEndDate&&Math.abs(asNum(a.quantity,0))>0);

  // If Finance by-day already told us which dates belong to this economic event,
  // use accrual/postings only to split the official posting quantity among those dates.
  // This avoids interpreting logistics/service accruals as extra sales/returns.
  if(finSet.size)candidates=candidates.filter(a=>finSet.has(a.date));
  else candidates=candidates.filter(a=>strongAccrualKind(a)===kind);
  if(!candidates.length)return null;

  const byDate=new Map();
  for(const a of candidates){
    const q=Math.abs(Math.trunc(asNum(a.quantity,0)));if(q<=0)continue;
    const o=byDate.get(a.date)||{date:a.date,q:0};
    // Several accrual types can repeat the same item quantity on the same date.
    // Max, not sum, prevents double counting commission + logistics rows.
    o.q=Math.max(o.q,q);byDate.set(a.date,o);
  }
  const ds=[...byDate.values()].filter(x=>x.q>0).sort((a,b)=>a.date.localeCompare(b.date));
  if(!ds.length)return null;
  if(ds.length===1)return [{date:ds[0].date,qty:targetQty,source:finSet.size?'finance+accrual-date':'accrual-type-date'}];

  const qsum=ds.reduce((z,x)=>z+x.q,0);
  if(qsum===targetQty)return ds.map(x=>({date:x.date,qty:x.q,source:finSet.size?'finance+accrual-split':'accrual-type-split'}));

  // If the official posting quantity equals the number of distinct Finance event
  // dates, one unit per date is an exact integer allocation even if service accrual
  // quantities are duplicated/dirty.
  if(finSet.size&&targetQty===ds.length)return ds.map(x=>({date:x.date,qty:1,source:'finance-date-count'}));
  return null;
}
function resolveTargetPart(target,kind,financeIndex,accrualIndex){
  const qty=kind==='sale'?asNum(target.soldQty,0):asNum(target.returnedQty,0);
  if(qty<=0)return {events:[],resolved:true,reason:'zero'};
  const key=`${target.postingNumber}|${target.sku}`;
  const fin=(financeIndex.get(key)||[]).filter(e=>kind==='sale'?e.saleAmount>0.00001:e.saleAmount<-0.00001);
  const uniqueDates=[...new Set(fin.map(e=>e.date).filter(d=>monthKey(d)===target.month))].sort();
  if(uniqueDates.length===1)return {events:[{date:uniqueDates[0],qty,source:'finance-event-date'}],resolved:true,reason:'unique-finance-date'};

  const accAlloc=accrualDateAllocation(accrualIndex.get(key)||[],kind,qty,target.month,uniqueDates);
  if(accAlloc)return {events:accAlloc,resolved:true,reason:'accrual-postings'};

  if(uniqueDates.length>1&&qty===uniqueDates.length)return {events:uniqueDates.map(date=>({date,qty:1,source:'finance-date-count'})),resolved:true,reason:'finance-date-count'};

  // Deliberately DO NOT fall back to order.created_date or legal_entity_document.sale_date.
  // The former is the order date; the latter belongs to the legal-entity document and is
  // not documented as the universal realization date. Exactness is more important than
  // filling a row with an unsupported date.
  return {events:[],resolved:false,reason:uniqueDates.length?`ambiguous-finance-dates:${uniqueDates.join(',')}`:'no-event-date'};
}
function postingsNeedingAccrual(targetGroups,financeIndex){
  const need=new Set();let parts=0;
  const emptyAccrual=new Map();
  for(const g of targetGroups||[])for(const t of g.targets||[])for(const kind of ['sale','return']){
    const qty=kind==='sale'?asNum(t.soldQty,0):asNum(t.returnedQty,0);if(qty<=0)continue;
    const r=resolveTargetPart(t,kind,financeIndex,emptyAccrual);
    if(!r.resolved){need.add(asStr(t.postingNumber));parts++}
  }
  return {postingNumbers:[...need].filter(Boolean),parts};
}
function buildClosedMonthRows(ym,targets,monthlySeg,financeIndex,accrualIndex,maps,postingMap){
  const rows=[],unresolved=[];let resolvedParts=0;const reasonCounts={};
  for(const t of targets||[]){
    for(const kind of ['sale','return']){
      const qty=kind==='sale'?asNum(t.soldQty,0):asNum(t.returnedQty,0);if(qty<=0)continue;
      const r=resolveTargetPart(t,kind,financeIndex,accrualIndex);
      reasonCounts[r.reason]=(reasonCounts[r.reason]||0)+1;
      if(!r.resolved){unresolved.push({month:ym,kind,postingNumber:t.postingNumber,sku:t.sku,article:t.article,qty,reason:r.reason});continue}
      resolvedParts++;
      const pm=postingMap?.[t.postingNumber]||{};
      for(const ev of r.events){
        const q=asNum(ev.qty,0);if(q<=0)continue;
        const observed=asStr(pm.observedDeliveredDate);
        const deliveryDate=(kind==='sale'&&observed&&monthKey(observed)===ym)?observed:ev.date;
        const exact=kind==='sale'&&Boolean(observed&&monthKey(observed)===ym);
        const unit=kind==='sale'?asNum(t.saleUnitPrice,NaN):asNum(t.returnUnitPrice,NaN);
        rows.push({
          date:deliveryDate,
          deliveryDate:kind==='sale'?deliveryDate:'',
          deliveryDateExact:kind==='sale'?exact:null,
          deliveryDateSource:kind==='sale'?(exact?'posting-status-transition':`historical-${ev.source}`):'',
          returnDate:kind==='return'?ev.date:'',
          article:t.article,sku:t.sku,name:t.name||asStr(maps.nameBySku.get(t.sku)),
          soldQty:kind==='sale'?q:0,returnedQty:kind==='return'?q:0,netQty:kind==='sale'?q:-q,
          postingNumber:t.postingNumber,
          orderId:asStr(first(pm.orderId,t.orderId)),orderNumber:asStr(first(pm.orderNumber,t.orderNumber)),
          orderDate:asStr(first(pm.orderDate,t.orderCreatedDate)).slice(0,10),orderDateSource:pm.orderDate?'posting-created-at':(t.orderCreatedDate?'realization-posting-created-date':''),
          orderSchema:asStr(pm.orderSchema),unitPrice:Number.isFinite(unit)?unit:null,
          source:`realization-posting+${ev.source}`,officialQuantity:true,dateAttribution:ev.source
        });
      }
    }
  }
  rows.sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.article).localeCompare(asStr(b.article))||asStr(a.postingNumber).localeCompare(asStr(b.postingNumber)));
  const validation=monthlySeg?validationBetweenRealizedRows(rows,monthlySeg?.rows||[],monthlySeg?.start,monthlySeg?.end):null;
  return {rows,unresolved,resolvedParts,reasonCounts,validation};
}
function applyExactPostingDeliveryDates(eventRows,postingMap){
  return (eventRows||[]).map(r=>{
    if(asNum(r.soldQty,0)<=0)return {...r};
    const pm=postingMap?.[asStr(r.postingNumber)]||{};
    const exact=asStr(pm.observedDeliveredDate).slice(0,10);
    if(exact){
      return {...r,date:exact,deliveryDate:exact,deliveryDateExact:true,deliveryDateSource:asStr(pm.observedDeliveredDateSource)||'posting-status-transition'};
    }
    const fallback=asStr(r.deliveryDate||r.date).slice(0,10);
    return {...r,date:fallback,deliveryDate:fallback,deliveryDateExact:false,deliveryDateSource:asStr(r.deliveryDateSource)||`historical-${asStr(r.dateAttribution)||'event-date'}`};
  });
}

function orphanReturnDiagnosticRows(orphanReturns,sourceRows,financeRows,returnRows,postingMap){
  const out=[];
  for(const r of orphanReturns||[]){
    const pn=asStr(r.postingNumber),sku=asStr(r.sku),article=asStr(r.article),retDate=asStr(r.returnDate||r.date).slice(0,10);
    const sameProduct=(x)=>{
      const xs=asStr(x?.sku),xa=asStr(x?.article);
      if(sku&&xs)return xs===sku;
      if(article&&xa)return xa===article;
      return Boolean((sku&&xa===sku)||(article&&xs===article));
    };
    const samePosting=(x)=>asStr(x?.postingNumber)===pn;
    const compactSource=(x)=>({date:asStr(x.date),deliveryDate:asStr(x.deliveryDate),returnDate:asStr(x.returnDate),postingNumber:asStr(x.postingNumber),sku:asStr(x.sku),article:asStr(x.article),soldQty:asNum(x.soldQty,0),returnedQty:asNum(x.returnedQty,0),source:asStr(x.source),dateAttribution:asStr(x.dateAttribution)});
    const compactFinance=(x)=>({date:asStr(x.date),postingNumber:asStr(x.postingNumber),sku:asStr(x.sku),article:asStr(x.article),saleAmount:asNum(x.saleAmount,0),grossRevenue:asNum(x.grossRevenue,0),sellerPriceRaw:asNum(x.sellerPriceRaw,0),salePriceRaw:asNum(x.salePriceRaw,0),soldQty:asNum(x.soldQty,0),returnedQty:asNum(x.returnedQty,0),operation:asStr(x.operation),group:asStr(x.group),transactionId:asStr(x.transactionId)});
    const compactReturn=(x)=>({returnId:asStr(x.returnId),date:asStr(x.date),postingNumber:asStr(x.postingNumber),sku:asStr(x.sku),article:asStr(x.article),quantity:asNum(x.quantity,0),schema:asStr(x.schema),reason:asStr(x.reason)});

    const exactSource=(sourceRows||[]).filter(x=>samePosting(x)&&sameProduct(x));
    const samePostingOther=(sourceRows||[]).filter(x=>samePosting(x)&&!sameProduct(x));
    const finExact=(financeRows||[]).filter(x=>samePosting(x)&&sameProduct(x));
    const finNeg=finExact.filter(x=>asNum(first(x.saleAmount,x.grossRevenue),0)<-0.00001);
    const finPos=finExact.filter(x=>asNum(first(x.saleAmount,x.grossRevenue),0)>0.00001);
    const productPrior=(financeRows||[]).filter(x=>sameProduct(x)&&asNum(first(x.saleAmount,x.grossRevenue),0)>0.00001&&asStr(x.date)<=retDate)
      .sort((a,b)=>asStr(b.date).localeCompare(asStr(a.date))).slice(0,12);
    const retExact=(returnRows||[]).filter(x=>samePosting(x)&&sameProduct(x));
    const pm=postingMap?.[pn]||null;
    const pmProducts=(pm?.products||[]).filter(x=>sameProduct(x)).map(x=>({sku:asStr(x.sku),article:asStr(x.article),name:asStr(x.name),quantity:asNum(x.quantity,0),price:asNum(x.price,0)}));

    out.push({
      returnEvent:{date:retDate,qty:asNum(r.returnedQty,0),postingNumber:pn,sku,article,name:asStr(r.name),orderNumber:asStr(r.orderNumber),orderId:asStr(r.orderId),orderDate:asStr(r.orderDate),source:asStr(r.source),dateAttribution:asStr(r.dateAttribution)},
      posting:pm?{found:true,status:asStr(pm.status),orderNumber:asStr(pm.orderNumber),orderId:asStr(pm.orderId),orderDate:asStr(pm.orderDate),orderSchema:asStr(pm.orderSchema),observedDeliveredDate:asStr(pm.observedDeliveredDate),observedDeliveredDateSource:asStr(pm.observedDeliveredDateSource),matchingProducts:pmProducts}:{found:false},
      sourceRowsExact:exactSource.slice(0,12).map(compactSource),
      sourceRowsSamePostingOtherProduct:samePostingOther.slice(0,12).map(compactSource),
      financeExactNegative:finNeg.slice(0,12).map(compactFinance),
      financeExactPositive:finPos.slice(0,12).map(compactFinance),
      financePriorSameProduct:productPrior.map(compactFinance),
      returnsListExact:retExact.slice(0,12).map(compactReturn)
    });
  }
  return out;
}
function logOrphanReturnDiagnostics(diags){
  for(let i=0;i<(diags||[]).length;i++){
    const d=diags[i],n=i+1;
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: return=${JSON.stringify(d.returnEvent)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: posting=${JSON.stringify(d.posting)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: sourceRowsExact=${JSON.stringify(d.sourceRowsExact)}`);
    if(d.sourceRowsSamePostingOtherProduct?.length)console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: sourceRowsSamePostingOtherProduct=${JSON.stringify(d.sourceRowsSamePostingOtherProduct)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: financeExactNegative=${JSON.stringify(d.financeExactNegative)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: financeExactPositive=${JSON.stringify(d.financeExactPositive)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: financePriorSameProduct=${JSON.stringify(d.financePriorSameProduct)}`);
    console.log(`UNMATCHED RETURN DIAGNOSTIC v8.5 #${n}: returnsListExact=${JSON.stringify(d.returnsListExact)}`);
  }
}
function applyRetroactiveReturns(eventRows,postingMap={},businessStart=BUSINESS_START){
  const sales=new Map(),returns=new Map();
  for(const r of eventRows||[]){
    const key=`${asStr(r.postingNumber)}|${asStr(r.sku)||asStr(r.article)}`;
    if(asNum(r.soldQty,0)>0){const a=sales.get(key)||[];a.push({...r});sales.set(key,a)}
    if(asNum(r.returnedQty,0)>0){const a=returns.get(key)||[];a.push({...r});returns.set(key,a)}
  }
  const out=[];let retroReturnedUnits=0,retroReturnedRevenue=0,inexactDeliveryRows=0;
  for(const [key,arr] of sales){
    arr.sort((a,b)=>asStr(a.deliveryDate||a.date).localeCompare(asStr(b.deliveryDate||b.date)));
    const rr=(returns.get(key)||[]).sort((a,b)=>asStr(a.returnDate||a.date).localeCompare(asStr(b.returnDate||b.date)));
    let retQty=rr.reduce((z,x)=>z+asNum(x.returnedQty,0),0);
    const returnDates=[...new Set(rr.map(x=>asStr(x.returnDate||x.date)).filter(Boolean))].sort();
    for(const s of arr){
      const sold=asNum(s.soldQty,0),applied=Math.min(sold,Math.max(0,retQty));retQty-=applied;
      const unit=asNum(s.unitPrice,NaN);const originalRevenue=Number.isFinite(unit)?sold*unit:0;const removedRevenue=Number.isFinite(unit)?applied*unit:0;
      retroReturnedUnits+=applied;retroReturnedRevenue+=removedRevenue;if(s.deliveryDateExact===false)inexactDeliveryRows++;
      out.push({...s,returnedQty:applied,netQty:sold-applied,originalRevenue,revenue:originalRevenue-removedRevenue,retroReturnedRevenue:removedRevenue,returnDates,returnDate:returnDates.at(-1)||'',returnStatus:applied<=0?'none':applied>=sold?'full':'partial'});
    }
  }

  // Returns whose source sale is outside the dashboard horizon are not an error and
  // must not reduce revenue a second time inside the reporting period. When the FBS
  // status-history backfill proves that the posting was delivered before BUSINESS_START,
  // classify it explicitly as pre-period context. Only genuinely unclassified returns
  // remain diagnostic orphans.
  const orphanReturns=[],prePeriodReturns=[];
  for(const [key,rr] of returns)if(!sales.has(key)){
    for(const r of rr){
      const delivered=asStr(postingMap?.[asStr(r.postingNumber)]?.observedDeliveredDate).slice(0,10);
      if(delivered&&delivered<businessStart)prePeriodReturns.push({...r,sourceDeliveryDate:delivered});
      else orphanReturns.push(r);
    }
  }
  out.sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.article).localeCompare(asStr(b.article))||asStr(a.postingNumber).localeCompare(asStr(b.postingNumber)));
  return {rows:out,retroReturnedUnits,retroReturnedRevenue,inexactDeliveryRows,orphanReturns,prePeriodReturns};
}
function overlayOfficialDailyRows(rows,dailySegments,start,end){
  const controls=(dailySegments||[]).filter(s=>s.kind==='daily'&&s.official!==false&&s.start>=start&&s.end<=end);
  if(!controls.length)return {rows:[...(rows||[])],days:0};
  const dates=new Set(controls.map(s=>s.start));
  const out=(rows||[]).filter(r=>!dates.has(r.date));
  for(const seg of controls)for(const r of seg.rows||[])out.push({...r,date:seg.start,periodStart:seg.start,periodEnd:seg.end,source:'finance-realization-by-day',official:true,officialQuantity:true,dateAttribution:'official-daily'});
  out.sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.article).localeCompare(asStr(b.article))||asStr(a.sku).localeCompare(asStr(b.sku)));
  return {rows:out,days:controls.length};
}
function dailyControlValidation(rows,dailySegments,start,end){
  const controls=(dailySegments||[]).filter(s=>s.kind==='daily'&&s.official!==false&&s.start>=start&&s.end<=end);
  if(!controls.length)return {available:false,days:0,ok:null,absSkuNetDelta:null,dayMismatches:[]};
  const mismatches=[];let totalAbs=0;
  for(const seg of controls){
    const v=validationBetweenRealizedRows(rows,seg.rows||[],seg.start,seg.end);totalAbs+=v.absSkuNetDelta;
    if(!v.ok&&mismatches.length<12)mismatches.push({date:seg.start,soldDelta:v.soldDelta,returnDelta:v.returnDelta,netDelta:v.netDelta,absSkuNetDelta:v.absSkuNetDelta});
  }
  return {available:true,days:controls.length,ok:mismatches.length===0&&totalAbs<0.001,absSkuNetDelta:totalAbs,dayMismatches:mismatches};
}
async function updateOfficialRealizationControls(previous,maps,warnings){
  const map=segmentMap(previous?.history?.realizationSegments||[]);
  const closed=closedMonthKeys(BUSINESS_START,TODAY);let monthlyLoaded=0,dailyLoaded=0,dailyPremiumAvailable=true,dailyErrors=0;
  for(const ym of closed){
    const key=`M:${ym}`,existing=map.get(key);
    if(existing?.official&&existing?.rows?.length)continue;
    try{const seg=await fetchMonthlyRealization(ym);map.set(key,seg);monthlyLoaded++}
    catch(e){warnings.push(`Monthly realization ${ym}: ${e}`)}
  }

  // Premium daily report is authoritative for an individual day but Ozon only exposes
  // a rolling recent window. Persist every successful day forever; refresh last 3 days.
  const dailyStart=maxDateStr(BUSINESS_START,addDays(TODAY,-PREMIUM_DAILY_LOOKBACK_DAYS));
  const dailyEnd=YESTERDAY,refreshCut=addDays(dailyEnd,-2);
  if(dailyStart<=dailyEnd){
    for(const date of dateRange(dailyStart,dailyEnd)){
      const key=`D:${date}`;if(map.has(key)&&date<refreshCut)continue;
      try{const seg=await fetchDailyRealization(date);map.set(key,seg);dailyLoaded++;await sleep(350)}
      catch(e){
        dailyErrors++;
        if(e.status===403){dailyPremiumAvailable=false;break}
        // An oldest boundary date can be outside Ozon's rolling window. Keep going so
        // newer dates are still captured.
        if(e.status!==400)warnings.push(`Realization by day ${date}: ${e}`);
      }
    }
  }
  const segments=[...map.values()].filter(s=>s.start&&s.end&&s.end>=BUSINESS_START&&s.start<=YESTERDAY).sort((a,b)=>a.start.localeCompare(b.start)||a.key.localeCompare(b.key));
  return {segments,diagnostics:{monthlyLoaded,dailyLoaded,dailyPremiumAvailable,dailyErrors,dailyStart,dailyEnd}};
}
async function buildDailyBusinessRealization(previous,maps,financeRows,postingMap,returnRows,returnsComplete,warnings){
  const controls=await updateOfficialRealizationControls(previous,maps,warnings);
  const closed=closedMonthKeys(BUSINESS_START,TODAY);
  const currentYm=monthKey(TODAY),targetEnd=YESTERDAY;
  const monthlyMap=new Map(controls.segments.filter(s=>s.kind==='monthly'&&s.official!==false).map(s=>[monthKey(s.start),s]));
  const officialDaily=controls.segments.filter(s=>s.kind==='daily'&&s.official!==false);
  const previousQtyMap=new Map((previous?.history?.quantityMonthSegments||[]).filter(s=>s.engineVersion===QUANTITY_ENGINE_VERSION&&s.complete).map(s=>[s.month,s]));
  const quantityMonthSegments=[];const monthDiagnostics=[];const freshGroups=[];

  // Closed months are rebuilt once for engine v8, then persisted. The stored rows are
  // source events (sales + returns on their Ozon event dates). Later-return retroactivity
  // is applied globally at publish time, so a return from the current month can modify a
  // cached delivery from an older month without rewriting Finance expenses.
  for(const ym of closed){
    const cached=previousQtyMap.get(ym),monthly=monthlyMap.get(ym);
    if(cached&&monthly){quantityMonthSegments.push(cached);monthDiagnostics.push({month:ym,reused:true,complete:true,postingValidation:cached.postingValidation,sourceMonthlyValidation:cached.sourceMonthlyValidation||cached.monthlyValidation,unresolved:0});continue}
    if(!monthly){monthDiagnostics.push({month:ym,reused:false,complete:false,error:'monthly-realization-missing'});continue}
    try{
      const report=await fetchPostingRealization(ym),targets=normalizePostingRealizationRows(report.rows,ym,maps),postingValidation=validatePostingTargetsAgainstMonthly(targets,monthly,ym);
      console.log(`Realization posting ${ym}: rawRows=${report.rows.length}; targets=${targets.length}; sold=${postingValidation.aSold}/${postingValidation.bSold}; returns=${postingValidation.aReturned}/${postingValidation.bReturned}; absSkuNetDelta=${postingValidation.absSkuNetDelta}; ok=${postingValidation.ok}`);
      if(!postingValidation.ok)warnings.push(`Posting realization ${ym} does not reconcile to monthly report: sold Δ ${postingValidation.soldDelta}, returns Δ ${postingValidation.returnDelta}, SKU net |Δ| ${postingValidation.absSkuNetDelta}`);
      freshGroups.push({ym,monthly,targets,postingValidation,closed:true});
    }catch(e){warnings.push(`Posting realization ${ym}: ${e}`);monthDiagnostics.push({month:ym,reused:false,complete:false,error:String(e)})}
  }

  // Open month: realization/posting gives delivered/returned quantities and order identity.
  // It is refreshed every run so a September return can retroactively reduce an August sale.
  let currentRealizationPostingAvailable=false,currentPostingError='';
  try{
    const report=await fetchPostingRealization(currentYm),targets=normalizePostingRealizationRows(report.rows,currentYm,maps);
    freshGroups.push({ym:currentYm,monthly:null,targets,postingValidation:null,closed:false});
    currentRealizationPostingAvailable=true;
    console.log(`Realization posting ${currentYm} (open): rawRows=${report.rows.length}; targets=${targets.length}`);
  }catch(e){
    currentPostingError=String(e);
    console.log(`Realization posting ${currentYm} (open) unavailable; using exact delivered-status + official daily fallback: ${currentPostingError}`);
  }

  const financeIndex=buildFinanceEventIndex(financeRows);
  const accrualNeed=postingsNeedingAccrual(freshGroups,financeIndex);
  let accrualFetch={rows:[],batches:0,failedBatches:0};
  if(accrualNeed.postingNumbers.length){const typeNames=await fetchAccrualTypeNames();accrualFetch=await fetchAccrualPostingsBatched(accrualNeed.postingNumbers,typeNames,warnings)}
  const accrualIndex=buildAccrualEventIndex(accrualFetch.rows);
  console.log(`Quantity v8 date attribution: financeEventKeys=${financeIndex.size}; ambiguousPartsBeforeAccrual=${accrualNeed.parts}; accrualPostingsRequested=${accrualNeed.postingNumbers.length}`);

  let currentEventRows=[],currentUnresolved=0,currentFallbackValidation=null,currentOfficialCoverage=null,currentFallbackReturnUnresolved=0,currentFallbackPriceMissing=0;
  for(const x of freshGroups){
    const built=buildClosedMonthRows(x.ym,x.targets,x.monthly,financeIndex,accrualIndex,maps,postingMap);
    const bounds=realizationMonthBounds(x.ym);
    if(x.closed){
      const sourceValidation=validationBetweenRealizedRows(built.rows,x.monthly.rows,bounds.start,bounds.end);
      const dailyCalibration=dailyControlValidation(built.rows,officialDaily,bounds.start,bounds.end);
      const complete=Boolean(x.postingValidation?.ok&&built.unresolved.length===0&&sourceValidation.ok&&(dailyCalibration.available?dailyCalibration.ok:true));
      if(built.unresolved.length)warnings.push(`Delivered quantity ${x.ym}: ${built.unresolved.length} posting quantity parts have no unambiguous event date.`);
      if(dailyCalibration.available&&!dailyCalibration.ok)warnings.push(`Delivered quantity ${x.ym}: event dates disagree with ${dailyCalibration.days} official daily control days; SKU net |Δ| ${dailyCalibration.absSkuNetDelta}.`);
      console.log(`Quantity month v8 ${x.ym}: eventRows=${built.rows.length}; unresolved=${built.unresolved.length}; sourceMonthly=${sourceValidation.ok}; dailyControlDays=${dailyCalibration.days}; dailyControlOk=${dailyCalibration.ok}; complete=${complete}; reasons=${JSON.stringify(built.reasonCounts)}`);
      const seg={key:`Q8:${x.ym}`,kind:'quantity-month',month:x.ym,engineVersion:QUANTITY_ENGINE_VERSION,start:bounds.start,end:bounds.end,complete,officialQuantity:true,source:'v8 realization/posting source events + event-date attribution',rows:built.rows,postingValidation:x.postingValidation,sourceMonthlyValidation:sourceValidation,dailyCalibration,reasonCounts:built.reasonCounts};
      quantityMonthSegments.push(seg);monthDiagnostics.push({month:x.ym,reused:false,complete,postingValidation:x.postingValidation,sourceMonthlyValidation:sourceValidation,dailyCalibration,reasonCounts:built.reasonCounts,unresolved:built.unresolved.length});
    }else{
      currentEventRows=built.rows.filter(r=>r.date>=monthStart(TODAY)&&r.date<=targetEnd);currentUnresolved=built.unresolved.length;
      if(currentUnresolved)warnings.push(`Delivered quantity ${x.ym}: ${currentUnresolved} open-month posting parts have no unambiguous event date.`);
      console.log(`Quantity month v8 ${x.ym} open: eventRows=${currentEventRows.length}; unresolved=${currentUnresolved}; reasons=${JSON.stringify(built.reasonCounts)}`);
    }
  }
  quantityMonthSegments.sort((a,b)=>a.start.localeCompare(b.start));

  if(!currentRealizationPostingAvailable){
    const currentStart=monthStart(TODAY);
    const openSales=buildOpenMonthSalesFromPostings(postingMap,currentStart,targetEnd,financeRows,maps);
    const openReturns=buildOpenMonthReturnsFromDaily(officialDaily,currentStart,targetEnd,financeRows,returnRows,postingMap,maps);
    currentEventRows=[...openSales,...openReturns.rows].sort((a,b)=>asStr(a.date).localeCompare(asStr(b.date))||asStr(a.postingNumber).localeCompare(asStr(b.postingNumber))||asStr(a.sku).localeCompare(asStr(b.sku)));
    currentFallbackReturnUnresolved=openReturns.unresolved.length;
    const currentDays=officialDaily.filter(s=>s.start>=currentStart&&s.end<=targetEnd);
    const requiredDays=targetEnd>=currentStart?dateRange(currentStart,targetEnd):[];
    const haveDays=new Set(currentDays.map(s=>s.start));
    const missingDays=requiredDays.filter(d=>!haveDays.has(d));
    currentOfficialCoverage={requiredDays:requiredDays.length,availableDays:haveDays.size,missingDays};
    currentFallbackValidation=dailyControlValidation(currentEventRows,officialDaily,currentStart,targetEnd);
    currentFallbackPriceMissing=openSales.filter(r=>!Number.isFinite(asNum(r.unitPrice,NaN))).length;
    // The daily realization report and the delivered-status timestamp answer different
    // business questions. v8 P&L is intentionally timed by the day the posting became
    // `delivered`; /finance/realization/by-day is retained as a timing audit and as the
    // source of current-month RETURN quantities. A day/SKU mismatch is therefore not a
    // delivery-date completeness failure.
    currentUnresolved=currentFallbackReturnUnresolved+(missingDays.length?missingDays.length:0)+currentFallbackPriceMissing;
    console.log(`Open-month delivered fallback ${currentStart}..${targetEnd}: salesRows=${openSales.length}; returnRows=${openReturns.rows.length}; unresolvedReturns=${openReturns.unresolved.length}; officialDays=${haveDays.size}/${requiredDays.length}; dailyTimingAuditOk=${currentFallbackValidation.ok}; provisionalSales=${openSales.filter(r=>r.provisional).length}; missingSalePrices=${currentFallbackPriceMissing}`);
    if(missingDays.length)warnings.push(`Open-month delivered P&L: official daily realization missing ${missingDays.length} day(s): ${missingDays.slice(0,8).join(', ')}`);
    if(openReturns.unresolved.length)warnings.push(`Open-month delivered P&L: ${openReturns.unresolved.length} official return row(s) could not be tied to a posting.`);
    if(currentFallbackPriceMissing)warnings.push(`Open-month delivered P&L: ${currentFallbackPriceMissing} delivered sale row(s) have no usable Finance or posting price.`);
    if(currentFallbackValidation.available&&!currentFallbackValidation.ok)console.log(`Open-month timing audit: delivery-status P&L differs from /finance/realization/by-day on ${currentFallbackValidation.dayMismatches.length} day(s); SKU |Δ| ${currentFallbackValidation.absSkuNetDelta}. This is informational because P&L is timed by actual delivered status.`);
  }

  const sourceRows=quantityMonthSegments.flatMap(s=>s.rows||[]).filter(r=>r.date>=BUSINESS_START&&r.date<=targetEnd);
  sourceRows.push(...currentEventRows);
  // Source quantity still reconciles on Ozon realization months BEFORE we move sales
  // onto the actual delivered day. This keeps source completeness separate from P&L timing.
  const sourceMonthlyValidation=validateDailyAgainstMonthly(sourceRows,controls.segments);
  const deliveryDatedRows=applyExactPostingDeliveryDates(sourceRows,postingMap);
  const retro=applyRetroactiveReturns(deliveryDatedRows,postingMap,BUSINESS_START);
  let rows=retro.rows.filter(r=>r.deliveryDate&&r.deliveryDate>=BUSINESS_START&&r.deliveryDate<=targetEnd);

  // Recent Premium daily report is an independent control of the final delivered-date
  // allocation. A remaining fallback date can be promoted only when that whole day/SKU
  // distribution exactly agrees with the official daily report.
  const verifiedDates=new Set();
  for(const seg of officialDaily){
    const v=validationBetweenRealizedRows(deliveryDatedRows,seg.rows||[],seg.start,seg.end);
    if(v.ok)verifiedDates.add(seg.start);
  }
  for(const r of rows)if(r.deliveryDateExact!==true&&verifiedDates.has(r.deliveryDate)){r.deliveryDateExact=true;r.deliveryDateSource='official-daily-verified'}

  const closedComplete=closed.every(ym=>quantityMonthSegments.some(s=>s.month===ym&&s.complete));
  const currentStart=monthStart(TODAY);
  const finalCurrentDailyValidation=dailyControlValidation(deliveryDatedRows,officialDaily,currentStart,targetEnd);
  const fallbackCurrentComplete=Boolean(currentOfficialCoverage&&currentOfficialCoverage.missingDays.length===0&&currentFallbackReturnUnresolved===0&&currentFallbackPriceMissing===0);
  const currentComplete=currentRealizationPostingAvailable?Boolean(currentUnresolved===0):fallbackCurrentComplete;
  const inexactDeliveryRows=rows.filter(r=>r.deliveryDateExact===false).length;
  const unresolvedDeliveryDates=rows.filter(r=>!r.deliveryDate).length;
  const sourceMonthlyOk=closed.length?sourceMonthlyValidation.ok:true;
  const complete=closedComplete&&currentComplete&&sourceMonthlyOk&&inexactDeliveryRows===0&&unresolvedDeliveryDates===0;
  const orphanReturnUnits=retro.orphanReturns.reduce((z,r)=>z+asNum(r.returnedQty,0),0);
  const prePeriodReturnUnits=retro.prePeriodReturns.reduce((z,r)=>z+asNum(r.returnedQty,0),0);
  const orphanReturnDiagnostics=orphanReturnDiagnosticRows(retro.orphanReturns,deliveryDatedRows,financeRows,returnRows,postingMap);
  if(orphanReturnDiagnostics.length)logOrphanReturnDiagnostics(orphanReturnDiagnostics);
  if(retro.orphanReturns.length)warnings.push(`Delivered P&L: ${retro.orphanReturns.length} return event rows (${orphanReturnUnits} units) cannot be matched to a delivered sale or proven to be pre-period; principal is not double-counted. See UNMATCHED RETURN DIAGNOSTIC v8.5 lines above.`);
  if(prePeriodReturnUnits)console.log(`Delivered P&L pre-period return context: ${retro.prePeriodReturns.length} row(s), ${prePeriodReturnUnits} unit(s); original delivery is before ${BUSINESS_START}, so current-period revenue is not reduced again.`);
  console.log(`Delivered-order engine v8.5 ${BUSINESS_START}..${targetEnd}: rows=${rows.length}; closedComplete=${closedComplete}; currentPosting=${currentRealizationPostingAvailable}; currentFallback=${!currentRealizationPostingAvailable}; currentUnresolved=${currentUnresolved}; sourceMonthlyReconcile=${sourceMonthlyOk}; currentDailyTimingAudit=${finalCurrentDailyValidation.ok}; retroReturnedUnits=${retro.retroReturnedUnits}; prePeriodReturnUnits=${prePeriodReturnUnits}; inexactDeliveryRows=${inexactDeliveryRows}; complete=${complete}`);
  for(const m of sourceMonthlyValidation.months)console.log(`Source quantity reconcile ${m.month}: sold=${m.dailySold}/${m.officialSold}; returns=${m.dailyReturned}/${m.officialReturned}; net=${m.dailyNet}/${m.officialNet}; absSkuDelta=${m.absSkuDelta}; ok=${m.ok}`);

  return {
    rows,
    segments:[{key:`Q8:${BUSINESS_START}_${targetEnd}`,kind:'daily',start:BUSINESS_START,end:targetEnd,complete,official:false,source:'v8 delivered orders; future returns applied retroactively; Ozon expenses stay on Finance accrual dates',rows}],
    officialSegments:controls.segments,quantityMonthSegments,
    coverage:{start:BUSINESS_START,end:targetEnd,complete,gaps:[]},
    diagnostics:{monthlyLoaded:controls.diagnostics.monthlyLoaded,dailyLoaded:controls.diagnostics.dailyLoaded,dailyPremiumAvailable:controls.diagnostics.dailyPremiumAvailable,dailyErrors:controls.diagnostics.dailyErrors,quantityEngineVersion:QUANTITY_ENGINE_VERSION,quantityMonths:monthDiagnostics,ambiguousPartsBeforeAccrual:accrualNeed.parts,accrualPostingsRequested:accrualNeed.postingNumbers.length,accrualPostingBatches:accrualFetch.batches,accrualPostingFailedBatches:accrualFetch.failedBatches,currentOfficialDays:officialDaily.filter(s=>monthKey(s.start)===currentYm).length,currentMissingDays:currentOfficialCoverage?.missingDays?.length||0,fallbackUnresolvedSaleOps:currentUnresolved,fallbackUnresolvedReturnOps:currentFallbackReturnUnresolved,currentFallbackPriceMissing,retroReturnedUnits:retro.retroReturnedUnits,retroReturnedRevenue:retro.retroReturnedRevenue,inexactDeliveryRows,unresolvedDeliveryDates,orphanReturnRows:retro.orphanReturns.length,orphanReturnUnits,orphanReturnDiagnostics,prePeriodReturnRows:retro.prePeriodReturns.length,prePeriodReturnUnits,currentRealizationPostingAvailable,currentPostingError,currentFallbackValidation,currentOfficialCoverage,finalCurrentDailyValidation,monthlyValidation:sourceMonthlyValidation}
  };
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

/* v7.0: FBO/FBS shipment lists are no longer the historical quantity authority.
   Keep only a recent posting cache for open-month provisional fallback/audit. Closed
   months use official realization/posting quantities. */
const financeAttributionUpgrade=previous?.financeAttributionVersion!==7;
const dailyQuantityUpgrade=previous?.diagnostics?.dailyQuantityVersion!==DAILY_QTY_VERSION||previous?.diagnostics?.quantityEngineVersion!==QUANTITY_ENGINE_VERSION;
const previousDailyComplete=Boolean(previous?.diagnostics?.realizationCoverage?.complete);
const needsPostingBackfill=false;
const postingFrom=maxDateStr(addDays(BUSINESS_START,-7),addDays(TODAY,-POSTING_LOOKBACK_DAYS));
console.log(`Posting recent audit refresh ${postingFrom}..${TODAY}; quantityEngineUpgrade=${dailyQuantityUpgrade}; historicalPostingBackfill=false`);
let freshFbo=[],freshFbs=[];
try{freshFbo=await fetchFboPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBO postings: ${e}`)}
try{freshFbs=await fetchFbsPostings(postingFrom,TODAY)}catch(e){warnings.push(`FBS postings: ${e}`)}
let postingMap=mergePostingMaps(previousPostingMap,normalizePostingMap([...freshFbo,...freshFbs],previousPostingMap));
const fbsDeliveryHistory=await updateFbsDeliveredDateHistory(previous,warnings);
if(fbsDeliveryHistory.rows.length)postingMap=mergePostingMaps(postingMap,normalizePostingMap(fbsDeliveryHistory.rows,postingMap));
console.log(`Posting map entries=${Object.keys(postingMap).length}; fresh FBO=${freshFbo.length}; fresh FBS=${freshFbs.length}; exact FBS delivery postings refreshed=${fbsDeliveryHistory.rows.length}`);

/* Exact business ledger from /finance/accrual/by-day. */
const prevFinanceRows=previous?.history?.financeRowsAll||previousFinance?.rows||[];
const prevFinEnd=prevFinanceRows.map(r=>r.date).filter(Boolean).sort().at(-1)||null;
// Finance money architecture remains unchanged. Quantity v7 reads dates/signs from this
// ledger but gets authoritative units from realization endpoints.
const financeFrom=financeAttributionUpgrade?HISTORY_START:(previous?maxDateStr(HISTORY_START,addDays(prevFinEnd||TODAY,-(FINANCE_LOOKBACK_DAYS-1))):HISTORY_START);
console.log(`Finance API-only refresh ${financeFrom}..${TODAY}; previous rows=${prevFinanceRows.length}; attributionUpgrade=${financeAttributionUpgrade}; quantityEngine=v9`);
let financeRefresh={rows:[],source:'none'};
try{financeRefresh=await fetchFinanceNormalized(financeFrom,TODAY,maps,postingMap)}catch(e){warnings.push(`Finance: ${e}`)}
const financeRows=financeRefresh.rows.length?replaceFinanceWindow(prevFinanceRows,financeRefresh.rows,financeFrom,TODAY):prevFinanceRows;
for(const r of financeRows){const pm=postingMap?.[asStr(r.postingNumber)]||{};if(!r.orderNumber)r.orderNumber=asStr(pm.orderNumber);if(!r.orderId)r.orderId=asStr(pm.orderId);if(!r.orderDate)r.orderDate=asStr(pm.orderDate);if(!r.orderDateSource)r.orderDateSource=asStr(pm.orderDateSource);if(!r.orderSchema)r.orderSchema=asStr(pm.orderSchema)}
const finTotalsAll=financeTotals(financeRows);
console.log(`Finance fresh rows: ${financeRefresh.rows.length}; source=${financeRefresh.source}; merged rows=${financeRows.length}; gross(all)=${finTotalsAll.grossRevenue.toFixed(2)}; net(all)=${finTotalsAll.netAfterOzon.toFixed(2)}`);

/* Direct SKU economics from the SAME /v1/finance/accrual/by-day ledger.
   The by-day payload already contains SKU-specific sale_amount (with bonus/coinvestment included),
   sale commission, delivery accruals and item_fees. This is the recommended bulk source.
   /v1/finance/accrual/postings is intentionally NOT used for full-history sync
   because Ozon rate-limits it heavily and it is better suited for spot checks. */
const skuFinanceFrom=financeFrom;
const skuFinanceRows=financeRows.filter(r=>r.financeAttribution==='direct_sku'&&(r.sku||r.article));
console.log(`SKU finance by-day direct v8.5: rows=${skuFinanceRows.length}; source=/v1/finance/accrual/by-day; gross=sale_amount; no postings endpoint used`);

/* Logistics-return API is retained ONLY as an audit feed. It is not the realization-return quantity source in v7. */
const returnFrom=previous?maxDateStr(BUSINESS_START,addDays(TODAY,-RETURN_LOOKBACK_DAYS)):BUSINESS_START;
let freshReturns=[],returnsComplete=true;
try{freshReturns=await fetchUnifiedReturns(returnFrom,TODAY)}catch(e){returnsComplete=false;warnings.push(`Returns: ${e}`)}
const freshReturnRows=normalizeReturnRows(freshReturns,maps).filter(r=>r.date>=BUSINESS_START&&r.date<=TODAY);
const returnRows=returnsComplete?mergeReturnRows(previousReturnRows,freshReturnRows):previousReturnRows;
const realization=await buildDailyBusinessRealization(previous,maps,financeRows,postingMap,returnRows,returnsComplete,warnings);
const realizedRange={start:realization.coverage.start,end:realization.coverage.end};
console.log(`Daily realization rows=${realization.rows.length}; coverage=${realizedRange.start||'none'}..${realizedRange.end||'none'}; complete=${realization.coverage.complete}; monthlyLoaded=${realization.diagnostics.monthlyLoaded}; dailyOfficialLoaded=${realization.diagnostics.dailyLoaded}; dailyPremium=${realization.diagnostics.dailyPremiumAvailable}`);

// Publish finance and exact SKU accruals on exactly the same date range as quantity realization.
const financeRowsPublished=(realizedRange.start&&realizedRange.end)?financeRows.filter(r=>r.date>=realizedRange.start&&r.date<=realizedRange.end):financeRows;
const skuFinanceRowsPublished=(realizedRange.start&&realizedRange.end)?skuFinanceRows.filter(r=>r.date>=realizedRange.start&&r.date<=realizedRange.end):skuFinanceRows;
const finTotals=financeTotals(financeRowsPublished);
const financeDirectRows=financeRowsPublished.filter(r=>r.financeAttribution==='direct_sku'||r.article||r.sku);
const financeUnallocatedRows=financeRowsPublished.filter(r=>!(r.article||r.sku));
const financeDirectGross=financeDirectRows.reduce((sum,r)=>sum+asNum(r.grossRevenue,0),0);
const financeDirectNet=financeDirectRows.reduce((sum,r)=>sum+asNum(r.rawAmount,0),0);
const financeUnallocatedNet=financeUnallocatedRows.reduce((sum,r)=>sum+asNum(r.rawAmount,0),0);
const financeReconcileDelta=finTotals.netAfterOzon-(financeDirectNet+financeUnallocatedNet);
const skuFinanceNet=skuFinanceRowsPublished.reduce((sum,r)=>sum+asNum(r.rawAmount,0),0);
const skuFinanceGross=skuFinanceRowsPublished.reduce((sum,r)=>sum+asNum(r.grossRevenue,0),0);
const skuFinanceReconcileDelta=financeDirectNet-skuFinanceNet;
const skuFinanceRevenueDelta=finTotals.grossRevenue-skuFinanceGross;
// Coverage is complete when the direct SKU projection exactly matches the direct
// portion of the business ledger. Non-item Ozon charges without SKU are expected
// to remain unallocated and are NOT a data-quality failure.
const skuFinanceCoverageComplete=Math.abs(skuFinanceReconcileDelta)<0.01&&Math.abs(skuFinanceRevenueDelta)<0.01&&financeDirectRows.length>0;
console.log(`Aligned business period ${realizedRange.start||'finance-start'}..${realizedRange.end||'finance-end'}; finance rows published=${financeRowsPublished.length}; gross=${finTotals.grossRevenue.toFixed(2)}; net=${finTotals.netAfterOzon.toFixed(2)}`);
console.log(`Finance ledger: direct SKU rows=${financeDirectRows.length}; unallocated rows=${financeUnallocatedRows.length}; direct gross=${financeDirectGross.toFixed(2)}; direct net=${financeDirectNet.toFixed(2)}; unallocated net=${financeUnallocatedNet.toFixed(2)}; ledger delta=${financeReconcileDelta.toFixed(6)}`);
console.log(`SKU by-day direct: rows=${skuFinanceRowsPublished.length}; gross=${skuFinanceGross.toFixed(2)}; net=${skuFinanceNet.toFixed(2)}; revenue delta=${skuFinanceRevenueDelta.toFixed(6)}; direct-net delta=${skuFinanceReconcileDelta.toFixed(6)}; coverageComplete=${skuFinanceCoverageComplete}`);
{
  const audit5657=skuFinanceRowsPublished.filter(r=>String(r.article)==='5657');
  if(audit5657.length){
    const sm=k=>audit5657.reduce((a,r)=>a+asNum(r[k],0),0);
    console.log(`SKU 5657 finance audit: rows=${audit5657.length}; seller_price=${sm('sellerPriceRaw').toFixed(2)}; sale_amount=${sm('saleAmount').toFixed(2)}; bonus=${sm('bonus').toFixed(2)}; coinvestment=${sm('coinvestment').toFixed(2)}; economic_gross=${sm('grossRevenue').toFixed(2)}; commission=${sm('commission').toFixed(2)}; logistics=${sm('logistics').toFixed(2)}; acquiring=${sm('acquiring').toFixed(2)}; direct_net=${sm('rawAmount').toFixed(2)}`);
  }
}

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
if(realization.rows.length)datasets.push({id:`api-realized-${realizedRange.start}_${realizedRange.end}`,apiAuto:true,type:'realized',label:'Доставленные продажи Ozon API',sheetName:'delivered orders v8.5: exact FBS delivered-status dates + realization quantities + retro returns',sourceName:'Ozon Seller API',start:realizedRange.start,end:realizedRange.end,snapshot:null,importedAt:generatedAt,capabilities:{realizedQty:true,api:true,returnsExact:true,officialMonthlyValidation:true,officialPostingQuantities:true,dailyArbitrary:true,quantityEngineVersion:QUANTITY_ENGINE_VERSION,coverageComplete:realization.coverage.complete,coverageGaps:realization.coverage.gaps,dailyCoverageStart:realizedRange.start,dailyCoverageEnd:realizedRange.end,monthlyValidation:realization.diagnostics.monthlyValidation},rows:realization.rows});
if(stockRows.length)datasets.push({id:`api-stock-${TODAY}`,apiAuto:true,type:'stock',label:'Остатки Ozon API',sheetName:stockComplete?stockResult.source:(previousStock?.sheetName||'previous API snapshot'),sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{stock:true,prices:true,api:true,complete:stockComplete},rows:stockRows});
if(priceRows.length)datasets.push({id:`api-price-${TODAY}`,apiAuto:true,type:'price',label:'Цены Ozon API',sheetName:'product/info/prices',sourceName:'Ozon Seller API',start:null,end:null,snapshot:TODAY,importedAt:generatedAt,capabilities:{prices:true,tariffEstimate:true,api:true,complete:Boolean(freshPrice.length)},rows:priceRows});
if(financeRowsPublished.length){
  const rr=datasetRange(financeRowsPublished);
  datasets.push({id:`api-finance-${rr.start}_${rr.end}`,apiAuto:true,type:'finance',label:'Финансы Ozon API',sheetName:financeRefresh.source||'finance API',sourceName:'Ozon Seller API',start:rr.start,end:rr.end,snapshot:null,importedAt:generatedAt,capabilities:{finance:true,accrualReport:true,grossRevenue:true,api:true,incremental:true,components:['commission','acquiring','logistics','storage','ads','fines','returns','other'],grossRevenueTotal:finTotals.grossRevenue,rawNetTotal:finTotals.netAfterOzon,componentTotals:finTotals.components,note:'v8: Finance API задаёт даты расходов Ozon. Finance gross/sale_amount хранится для аудита и не задаёт период выручки P&L.'},rows:financeRowsPublished});
}
if(skuFinanceRowsPublished.length){
  const rr=datasetRange(skuFinanceRowsPublished);
  datasets.push({id:`api-sku-finance-${rr.start}_${rr.end}`,apiAuto:true,type:'skuFinance',label:'Товарные начисления Ozon API',sheetName:'finance/accrual/by-day · direct SKU',sourceName:'Ozon Seller API',start:rr.start,end:rr.end,snapshot:null,importedAt:generatedAt,capabilities:{skuFinance:true,api:true,directSkuByDay:true,coverageComplete:skuFinanceCoverageComplete,note:'v8: SKU Finance используется как слой прямых расходов по датам начисления Ozon. sale_amount/seller_price остаются аудитом; выручка берётся из доставленных заказов.'},rows:skuFinanceRowsPublished});
}

const persistedDailyQuantityVersion=realization.coverage.complete?DAILY_QTY_VERSION:(previous?.diagnostics?.dailyQuantityVersion||0);

const payload={
  version:4,sourcePolicy:'ozon-api-only',financeAttributionVersion:7,generatedAt,syncMode:SYNC_MODE,clientId:CLIENT_ID,datasets,
  history:{analyticsSegments,postingMap,returnRows,fbsDeliveredDays:fbsDeliveryHistory.scannedDays,realizationSegments:realization.officialSegments,quantityMonthSegments:realization.quantityMonthSegments,financeRowsAll:financeRows,skuFinanceRowsAll:skuFinanceRows},
  diagnostics:{
    mode:SYNC_MODE,sourcePolicy:'ozon-api-only',previousApiOnlyStateLoaded:Boolean(previous),historyStart:HISTORY_START,businessStart:BUSINESS_START,dailyQuantityVersion:persistedDailyQuantityVersion,dailyQuantityUpgrade,quantityEngineVersion:QUANTITY_ENGINE_VERSION,needsPostingBackfill,
    products:products.length,productDetails:productDetails.length,categoryTreeRoots:categoryTree.length,prices:prices.length,stockRows:stockRows.length,stockFreshComplete:stockComplete,
    financeRefreshFrom:financeFrom,financeFreshRows:financeRefresh.rows.length,financeSource:financeRefresh.source,financeRowsAll:financeRows.length,financeRowsPublished:financeRowsPublished.length,financeGrossRevenueTotal:finTotals.grossRevenue,financeNetAfterOzonTotal:finTotals.netAfterOzon,financePublishedRange:{from:realizedRange.start,to:realizedRange.end},financeAttributionVersion:7,financeAttributionUpgrade,financeDirectSkuRows:financeDirectRows.length,financeUnallocatedRows:financeUnallocatedRows.length,financeDirectGross,financeDirectNet,financeUnallocatedNet,financeReconcileDelta,
    skuFinanceRefreshFrom:skuFinanceFrom,skuFinanceSource:'finance/accrual/by-day direct SKU',skuFinanceDirectRows:skuFinanceRowsPublished.length,skuFinanceRowsAll:skuFinanceRows.length,skuFinanceRowsPublished:skuFinanceRowsPublished.length,skuFinanceGross,skuFinanceNet,skuFinanceRevenueDelta,skuFinanceReconcileDelta,skuFinanceCoverageComplete,
    postingRefreshFrom:postingFrom,postingFullBackfill:needsPostingBackfill,postingMapSize:Object.keys(postingMap).length,fboPostingsFresh:freshFbo.length,fbsPostingsFresh:freshFbs.length,
    orderMetaVersion:2,orderSalePostings:Object.values(postingMap).filter(p=>p.status==='delivered').length,orderNumberResolved:Object.values(postingMap).filter(p=>p.orderNumber).length,orderDateResolved:Object.values(postingMap).filter(p=>p.orderDate).length,deliveryEngineVersion:10,deliveryStatusDateVersion:DELIVERY_STATUS_DATE_VERSION,fbsDeliveryComplete:fbsDeliveryHistory.complete,fbsDeliveryMissingDays:fbsDeliveryHistory.missingDays.length,fbsDeliveryScannedDays:fbsDeliveryHistory.scannedDays.length,fbsDeliveryBackfill:fbsDeliveryHistory.fullBackfill,fbsExactDeliveryPostingsRefresh:fbsDeliveryHistory.rows.length,deliveryDateExactCoverage:realization.rows.length?100*realization.rows.filter(r=>r.deliveryDateExact===true).length/realization.rows.length:null,unresolvedDeliveryDates:realization.rows.filter(r=>!r.deliveryDate).length,inexactDeliveryRows:realization.diagnostics.inexactDeliveryRows||0,retroReturnedUnits:realization.diagnostics.retroReturnedUnits||0,retroReturnedRevenue:realization.diagnostics.retroReturnedRevenue||0,provisionalDeliveredSales:realization.rows.filter(r=>r.provisional).reduce((z,r)=>z+asNum(r.soldQty,0),0),provisionalDeliveredRevenue:realization.rows.filter(r=>r.provisional).reduce((z,r)=>z+asNum(r.revenue,0),0),currentRealizationPostingAvailable:realization.diagnostics.currentRealizationPostingAvailable,currentPostingError:realization.diagnostics.currentPostingError||'',currentFallbackValidation:realization.diagnostics.currentFallbackValidation||null,currentOfficialCoverage:realization.diagnostics.currentOfficialCoverage||null,currentFallbackPriceMissing:realization.diagnostics.currentFallbackPriceMissing||0,deliveryGrossMonthlyValidation:realization.diagnostics.monthlyValidation,unmatchedReturnUnits:realization.diagnostics.orphanReturnUnits||0,prePeriodReturnUnits:realization.diagnostics.prePeriodReturnUnits||0,
    returnRefreshFrom:returnFrom,returnsApiComplete:returnsComplete,returnsComplete:realization.coverage.complete,returnsFresh:freshReturnRows.length,fbsReturnsFresh:freshReturnRows.filter(r=>r.schema==='FBS').length,fboReturnsFresh:freshReturnRows.filter(r=>r.schema==='FBO').length,returnRows:returnRows.length,
    realizedRows:realization.rows.length,unresolvedSaleOps:realization.diagnostics.fallbackUnresolvedSaleOps,unresolvedReturnOps:realization.diagnostics.fallbackUnresolvedReturnOps,realizationSegments:realization.segments.length,realizationCoverage:{from:realizedRange.start,to:realizedRange.end,complete:realization.coverage.complete,gaps:realization.coverage.gaps},realizationMonthlyLoaded:realization.diagnostics.monthlyLoaded,realizationDailyLoaded:realization.diagnostics.dailyLoaded,realizationDailyPremiumAvailable:realization.diagnostics.dailyPremiumAvailable,quantityMonths:realization.diagnostics.quantityMonths,accrualPostingBatches:realization.diagnostics.accrualPostingBatches,accrualPostingFailedBatches:realization.diagnostics.accrualPostingFailedBatches,currentOfficialDays:realization.diagnostics.currentOfficialDays,currentMissingDays:realization.diagnostics.currentMissingDays,dailyQuantityMonthlyValidation:realization.diagnostics.monthlyValidation,
    analyticsSegments:analyticsSegments.length,analyticsCoverage:{from:salesStart,to:salesEnd},analyticsRows:salesRows.length,analyticsSegmentRows:funnelRows.length,analyticsLatestSkuDetailTruncated:Boolean(analyticsSegments.at(-1)?.skuDetailTruncated),
    warnings
  }
};

await fs.mkdir(path.join(process.cwd(),'data'),{recursive:true});
await fs.writeFile(path.join(process.cwd(),'data','ozon-data.enc.json'),JSON.stringify(encryptJson(payload,DASHBOARD_KEY)));
await fs.writeFile(path.join(process.cwd(),'data','ozon-status.json'),JSON.stringify({ok:warnings.length===0,generatedAt,mode:SYNC_MODE,sourcePolicy:'ozon-api-only',counts:payload.diagnostics,note:'Public status contains no API key or detailed financial rows. Product finance uses direct SKU attribution from /v1/finance/accrual/by-day. v8.5 P&L revenue is timed by the FBS delivered-status transition; /finance/realization/by-day is an independent timing audit and current-return quantity source, not a same-day delivery constraint. Later returns retroactively reduce the original delivery. Ozon expenses remain on Finance API accrual dates. A pre-business FBS delivery-history window is retained to classify returns whose source sale predates the dashboard horizon.'},null,2));
console.log(`Encrypted API-only dashboard state written. warnings=${warnings.length}`);
if(warnings.length)console.warn('Non-fatal sync warnings:',warnings);
