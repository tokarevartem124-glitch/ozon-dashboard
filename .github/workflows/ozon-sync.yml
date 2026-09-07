import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const DAYS = Number(process.env.OZON_HISTORY_DAYS || 120);

if (!CLIENT_ID || !API_KEY || !PASSWORD) {
  throw new Error('Missing OZON_CLIENT_ID, OZON_API_KEY or DASHBOARD_PASSWORD');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDate = d => d.toISOString().slice(0, 10);
const now = new Date();
const startDate = new Date(now.getTime() - (DAYS - 1) * 86400000);
const DATE_FROM = isoDate(startDate);
const DATE_TO = isoDate(now);

function asNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function asStr(v) { return v == null ? '' : String(v); }
function first(...xs) { return xs.find(v => v !== undefined && v !== null && v !== ''); }

async function post(endpoint, body, {allowError = false} = {}) {
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: {
      'Client-Id': CLIENT_ID,
      'Api-Key': API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body ?? {})
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { json = {raw: text}; }
  if (!res.ok) {
    const msg = `${endpoint}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 800)}`;
    if (allowError) return {__error: msg, __status: res.status};
    throw new Error(msg);
  }
  return json;
}

async function testAuth() {
  const r = await post('/v4/product/info/limit', {});
  return r;
}

async function fetchProducts() {
  const items = [];
  let lastId = '';
  for (let guard = 0; guard < 100; guard++) {
    let r = await post('/v3/product/list', {
      filter: {visibility: 'ALL'},
      last_id: lastId,
      limit: 1000
    }, {allowError: true});
    if (r.__error && guard === 0) {
      r = await post('/v2/product/list', {
        filter: {visibility: 'ALL'}, last_id: lastId, limit: 1000
      });
    } else if (r.__error) throw new Error(r.__error);
    const result = r.result || r;
    const batch = Array.isArray(result.items) ? result.items : [];
    items.push(...batch);
    const next = asStr(first(result.last_id, result.cursor));
    if (!batch.length || !next || next === lastId) break;
    lastId = next;
  }
  return items;
}

async function fetchPrices() {
  const items = [];
  let cursor = '';
  let endpoint = '/v5/product/info/prices';
  for (let guard = 0; guard < 100; guard++) {
    const body = {filter:{visibility:'ALL'}, limit:1000};
    if (cursor) body.cursor = cursor;
    let r = await post(endpoint, body, {allowError:true});
    if (r.__error && guard === 0) {
      endpoint = '/v4/product/info/prices';
      const body4 = {filter:{visibility:'ALL'}, limit:1000, last_id:''};
      r = await post(endpoint, body4);
    } else if (r.__error) throw new Error(r.__error);
    const result = r.result || r;
    const batch = Array.isArray(result.items) ? result.items : [];
    items.push(...batch);
    const next = asStr(first(result.cursor, result.last_id));
    if (!batch.length || !next || next === cursor) break;
    cursor = next;
  }
  return items;
}

async function fetchStocks() {
  // This endpoint includes item_code (seller article) + SKU and is convenient for joining.
  const rows = [];
  for (let offset = 0, guard = 0; guard < 100; guard++, offset += 1000) {
    const r = await post('/v2/analytics/stock_on_warehouses', {
      limit: 1000, offset, warehouse_type: 'ALL'
    }, {allowError:true});
    if (r.__error) {
      // Fall back to product stock API. Shape differs; handled later.
      const fallback = await fetchProductStocks();
      return {rows: fallback, source: 'v4/product/info/stocks'};
    }
    const batch = r?.result?.rows || [];
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return {rows, source: 'v2/analytics/stock_on_warehouses'};
}

async function fetchProductStocks() {
  const items = [];
  let lastId = '';
  for (let guard = 0; guard < 100; guard++) {
    const r = await post('/v4/product/info/stocks', {
      filter:{visibility:'ALL'}, last_id:lastId, limit:1000
    });
    const result = r.result || r;
    const batch = Array.isArray(result.items) ? result.items : [];
    items.push(...batch);
    const next = asStr(first(result.last_id, result.cursor));
    if (!batch.length || !next || next === lastId) break;
    lastId = next;
  }
  return items;
}

function monthChunks(fromStr, toStr) {
  const out = [];
  let cur = new Date(fromStr + 'T00:00:00Z');
  const end = new Date(toStr + 'T23:59:59.999Z');
  while (cur <= end) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const stop = monthEnd < end ? monthEnd : end;
    out.push([cur.toISOString(), stop.toISOString()]);
    cur = new Date(stop.getTime() + 1);
  }
  return out;
}

async function fetchFinance() {
  const operations = [];
  for (const [from, to] of monthChunks(DATE_FROM, DATE_TO)) {
    for (let page = 1; page < 1000; page++) {
      const r = await post('/v3/finance/transaction/list', {
        filter: {
          date: {from, to},
          operation_type: [],
          posting_number: '',
          transaction_type: 'ALL'
        },
        page,
        page_size: 1000
      });
      const result = r.result || {};
      const batch = result.operations || [];
      operations.push(...batch);
      const pageCount = asNum(result.page_count, page);
      if (!batch.length || page >= pageCount) break;
    }
  }
  return operations;
}

async function analyticsRequest(metrics, offset = 0) {
  return post('/v1/analytics/data', {
    date_from: DATE_FROM,
    date_to: DATE_TO,
    dimension: ['sku'],
    filters: [],
    metrics,
    sort: [{key: 'revenue', order: 'DESC'}],
    limit: 1000,
    offset
  }, {allowError:true});
}

async function fetchAnalytics() {
  const premiumMetrics = ['revenue','ordered_units','delivered_units','returns','cancellations','hits_view','session_view_pdp','hits_tocart'];
  const basicMetrics = ['revenue','ordered_units'];
  let metrics = premiumMetrics;
  let firstPage = await analyticsRequest(metrics, 0);
  if (firstPage.__error) {
    console.warn('Premium analytics metrics unavailable; using basic metrics only.');
    // Ozon documents a 1 request/minute limit for analytics/data.
    await sleep(65000);
    metrics = basicMetrics;
    firstPage = await analyticsRequest(metrics, 0);
    if (firstPage.__error) return {rows:[], metrics:[], error:firstPage.__error};
  }
  const data = [...(firstPage?.result?.data || [])];
  let offset = 1000;
  while ((firstPage?.result?.data || []).length === 1000 && offset < 50000) {
    await sleep(65000);
    const next = await analyticsRequest(metrics, offset);
    if (next.__error) return {rows:data, metrics, error:next.__error};
    const batch = next?.result?.data || [];
    data.push(...batch);
    if (batch.length < 1000) break;
    firstPage = next;
    offset += 1000;
  }
  return {rows:data, metrics};
}

function extractProductSkuCandidates(p) {
  const set = new Set();
  for (const v of [p.sku, p.fbo_sku, p.fbs_sku]) if (v) set.add(asStr(v));
  for (const s of p.sources || []) for (const v of [s.sku, s.source_sku]) if (v) set.add(asStr(v));
  return [...set];
}

function getPriceValue(p) {
  return asNum(first(
    p?.price?.marketing_seller_price,
    p?.price?.marketing_price,
    p?.price?.price,
    p?.marketing_seller_price,
    p?.marketing_price,
    p?.price,
    p?.min_ozon_price
  ), NaN);
}

function normalizeCommissions(p) {
  const arr = Array.isArray(p.commissions) ? p.commissions : (Array.isArray(p?.price?.commissions) ? p.price.commissions : []);
  let fbo = null, fbs = null;
  for (const c of arr) {
    const schema = String(first(c.sale_schema, c.saleSchema, c.delivery_schema, '')).toLowerCase();
    const pct = asNum(first(c.percent, c.commission_percent, c.value), NaN);
    if (!Number.isFinite(pct)) continue;
    if (schema.includes('fbo')) fbo = pct;
    if (schema.includes('fbs')) fbs = pct;
  }
  return {fbo, fbs};
}

function buildMaps(products, stockRaw) {
  const articleBySku = new Map();
  const nameBySku = new Map();
  const productByArticle = new Map();
  for (const p of products) {
    const article = asStr(first(p.offer_id, p.offerId));
    const productId = asStr(first(p.product_id, p.id));
    if (article) productByArticle.set(article, {article, productId, name:asStr(p.name)});
    for (const sku of extractProductSkuCandidates(p)) {
      if (article) articleBySku.set(sku, article);
      if (p.name) nameBySku.set(sku, asStr(p.name));
    }
  }
  for (const s of stockRaw) {
    const sku = asStr(first(s.sku, s.fbo_sku, s.fbs_sku));
    const article = asStr(first(s.item_code, s.offer_id, s.offerId));
    if (sku && article) articleBySku.set(sku, article);
    if (sku && first(s.item_name, s.name)) nameBySku.set(sku, asStr(first(s.item_name, s.name)));
  }
  return {articleBySku, nameBySku, productByArticle};
}

function normalizeStock(stockRaw, maps, priceByArticle) {
  const grouped = new Map();
  for (const r of stockRaw) {
    const sku = asStr(first(r.sku, r.fbo_sku, r.fbs_sku));
    const article = asStr(first(r.item_code, r.offer_id, r.offerId, maps.articleBySku.get(sku)));
    if (!sku && !article) continue;
    const key = `${article}|${sku}`;
    const o = grouped.get(key) || {
      article, sku, name:asStr(first(r.item_name, r.name, maps.nameBySku.get(sku))),
      category:'', type:'', brand:'', productId:'', volume:null, currentPrice:null,
      stockFbo:0, stockFbs:0, stockRealFbs:0
    };
    if ('free_to_sell_amount' in r) {
      o.stockFbo += asNum(r.free_to_sell_amount);
    } else if (Array.isArray(r.stocks)) {
      for (const st of r.stocks) {
        const type = String(first(st.type, st.stock_type, st.warehouse_type, '')).toLowerCase();
        const present = asNum(first(st.present, st.stock, st.free_to_sell_amount));
        if (type.includes('fbs')) o.stockFbs += present; else o.stockFbo += present;
      }
    } else {
      o.stockFbo += asNum(first(r.present, r.stock, r.free_to_sell_amount));
    }
    const pr = priceByArticle.get(article);
    if (pr) o.currentPrice = getPriceValue(pr);
    grouped.set(key, o);
  }
  return [...grouped.values()];
}

function normalizePrices(prices, maps) {
  return prices.map(p => {
    const article = asStr(first(p.offer_id, p.offerId));
    const productId = asStr(first(p.product_id, p.id));
    const comm = normalizeCommissions(p);
    return {
      article,
      sku:'',
      productId,
      name:asStr(first(p.name, maps.productByArticle.get(article)?.name)),
      currentPrice:getPriceValue(p),
      volume:asNum(first(p.volume_weight, p.volume), NaN),
      cost:null,
      costColumn:null,
      acquiring:null,
      commissionFbo:comm.fbo,
      commissionFbs:comm.fbs,
      logMaxFbo:null,lastMileFbo:null,nonstandardFbo:null,
      procMaxFbs:null,logMaxFbs:null,lastMileFbs:null,nonstandardFbs:null,
      orders7:null
    };
  }).filter(r => r.article);
}

function normalizeAnalytics(a, maps) {
  const idx = Object.fromEntries(a.metrics.map((m,i)=>[m,i]));
  const rows = [];
  for (const r of a.rows) {
    const dims = r.dimensions || [];
    const skuDim = dims[0] || {};
    const sku = asStr(first(skuDim.id, skuDim.value, skuDim.name));
    const article = asStr(maps.articleBySku.get(sku));
    const m = r.metrics || [];
    rows.push({
      name: asStr(first(maps.nameBySku.get(sku), skuDim.name)),
      category1:'',category2:'',category3:'',brand:'',scheme:'',sku,article,
      revenue: idx.revenue != null ? asNum(m[idx.revenue]) : 0,
      impressions: idx.hits_view != null ? asNum(m[idx.hits_view]) : 0,
      visits: idx.session_view_pdp != null ? asNum(m[idx.session_view_pdp]) : 0,
      carts: idx.hits_tocart != null ? asNum(m[idx.hits_tocart]) : 0,
      ordered: idx.ordered_units != null ? asNum(m[idx.ordered_units]) : 0,
      delivered: idx.delivered_units != null ? asNum(m[idx.delivered_units]) : 0
    });
  }
  return rows;
}

function signedExpenseFromServicePrice(price) {
  const n = asNum(price, 0);
  return -n; // Ozon service charges are normally negative; positive adjustments become negative expenses.
}

function classifyService(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('эквайр') || s.includes('acquir')) return 'acquiring';
  if (s.includes('хранен') || s.includes('storage')) return 'storage';
  if (s.includes('реклам') || s.includes('продвиж') || s.includes('advert')) return 'ads';
  if (s.includes('штраф') || s.includes('penalt')) return 'fines';
  if (s.includes('возврат') || s.includes('return')) return 'returns';
  if (s.includes('логист') || s.includes('достав') || s.includes('обработ') || s.includes('fulfillment') || s.includes('delivery')) return 'logistics';
  return 'other';
}

function normalizeFinance(ops, maps) {
  const rows = [];
  for (const op of ops) {
    const items = Array.isArray(op.items) ? op.items : [];
    const single = items.length === 1 ? items[0] : null;
    const sku = asStr(single?.sku);
    const article = asStr(maps.articleBySku.get(sku));
    const gross = asNum(op.accruals_for_sale, 0);
    const amount = asNum(op.amount, 0);
    const comp = {commission:0,acquiring:0,logistics:0,storage:0,ads:0,fines:0,returns:0,other:0};
    comp.commission += Math.abs(asNum(op.sale_commission, 0));
    comp.logistics += Math.abs(asNum(op.delivery_charge, 0));
    comp.returns += Math.abs(asNum(op.return_delivery_charge, 0));
    for (const s of op.services || []) comp[classifyService(s.name)] += signedExpenseFromServicePrice(s.price);
    const known = Object.values(comp).reduce((a,b)=>a+b,0);
    // Algebraic residual guarantees that gross revenue - classified expenses equals Ozon's operation amount.
    comp.other += gross - known - amount;
    rows.push({
      date: asStr(op.operation_date).slice(0,10),
      article, sku,
      group: asStr(op.type),
      operation: asStr(first(op.operation_type_name, op.operation_type)),
      transactionId: asStr(op.operation_id),
      grossRevenue: gross || null,
      soldQty:0, returnedQty:0,
      commission:comp.commission, acquiring:comp.acquiring, logistics:comp.logistics,
      storage:comp.storage, ads:comp.ads, fines:comp.fines, returns:comp.returns,
      other:comp.other, rawAmount:amount
    });
  }
  return rows;
}

function encryptJson(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 250000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const data = Buffer.concat([ciphertext, tag]);
  return {
    v:1,
    alg:'AES-256-GCM',
    kdf:'PBKDF2-SHA256',
    iterations,
    salt:salt.toString('base64'),
    iv:iv.toString('base64'),
    data:data.toString('base64'),
    generatedAt:obj.generatedAt
  };
}

console.log(`Ozon sync: ${DATE_FROM}..${DATE_TO}`);
await testAuth();
console.log('Auth OK');

const errors = [];
const products = await fetchProducts().catch(e => { errors.push(String(e)); return []; });
console.log(`Products: ${products.length}`);
const prices = await fetchPrices().catch(e => { errors.push(String(e)); return []; });
console.log(`Prices: ${prices.length}`);
const stockResult = await fetchStocks().catch(e => { errors.push(String(e)); return {rows:[],source:'error'}; });
console.log(`Stocks raw: ${stockResult.rows.length}`);

const maps = buildMaps(products, stockResult.rows);
const priceByArticle = new Map(prices.map(p => [asStr(first(p.offer_id,p.offerId)), p]).filter(x => x[0]));
const stockRows = normalizeStock(stockResult.rows, maps, priceByArticle);
const priceRows = normalizePrices(prices, maps);

const financeOps = await fetchFinance().catch(e => { errors.push(String(e)); return []; });
console.log(`Finance operations: ${financeOps.length}`);
const financeRows = normalizeFinance(financeOps, maps);

const analytics = await fetchAnalytics().catch(e => ({rows:[],metrics:[],error:String(e)}));
if (analytics.error) errors.push(analytics.error);
console.log(`Analytics rows: ${analytics.rows.length}; metrics: ${analytics.metrics.join(', ')}`);
const salesRows = normalizeAnalytics(analytics, maps);

const generatedAt = new Date().toISOString();
const datasets = [];
if (salesRows.length) datasets.push({
  id:`api-sales-${DATE_FROM}_${DATE_TO}`, apiAuto:true, type:'sales', label:'Продажи / аналитика Ozon API',
  sheetName:'Seller API / analytics/data', sourceName:'Ozon Seller API', start:DATE_FROM, end:DATE_TO, snapshot:null,
  importedAt:generatedAt, capabilities:{sales:true,funnel:analytics.metrics.includes('hits_view'),api:true}, rows:salesRows
});
if (stockRows.length) datasets.push({
  id:`api-stock-${DATE_TO}`, apiAuto:true, type:'stock', label:'Остатки Ozon API',
  sheetName:stockResult.source, sourceName:'Ozon Seller API', start:null,end:null,snapshot:DATE_TO,
  importedAt:generatedAt, capabilities:{stock:true,prices:true,api:true}, rows:stockRows
});
if (priceRows.length) datasets.push({
  id:`api-price-${DATE_TO}`, apiAuto:true, type:'price', label:'Цены / комиссии Ozon API',
  sheetName:'product/info/prices', sourceName:'Ozon Seller API', start:null,end:null,snapshot:DATE_TO,
  importedAt:generatedAt, capabilities:{prices:true,tariffEstimate:true,api:true}, rows:priceRows
});
if (financeRows.length) datasets.push({
  id:`api-finance-${DATE_FROM}_${DATE_TO}`, apiAuto:true, type:'finance', label:'Финансы Ozon API',
  sheetName:'finance/transaction/list', sourceName:'Ozon Seller API', start:DATE_FROM,end:DATE_TO,snapshot:null,
  importedAt:generatedAt,
  capabilities:{finance:true,accrualReport:true,grossRevenue:true,api:true,components:['commission','acquiring','logistics','storage','ads','fines','returns','other'],rawNetTotal:financeOps.reduce((s,o)=>s+asNum(o.amount),0)},
  rows:financeRows
});

const payload = {
  version:1,
  generatedAt,
  range:{from:DATE_FROM,to:DATE_TO},
  clientId:CLIENT_ID,
  datasets,
  diagnostics:{
    products:products.length,
    prices:prices.length,
    stockRows:stockRows.length,
    financeOperations:financeOps.length,
    analyticsRows:salesRows.length,
    analyticsMetrics:analytics.metrics,
    errors
  }
};

await fs.mkdir(path.join(process.cwd(),'data'), {recursive:true});
await fs.writeFile(path.join(process.cwd(),'data','ozon-data.enc.json'), JSON.stringify(encryptJson(payload, PASSWORD)));
await fs.writeFile(path.join(process.cwd(),'data','ozon-status.json'), JSON.stringify({
  ok:true, generatedAt, range:payload.range,
  counts:payload.diagnostics,
  note:'This status file contains no API key and no detailed financial data.'
}, null, 2));
console.log('Encrypted dashboard data written to data/ozon-data.enc.json');
if (errors.length) console.warn('Non-fatal sync warnings:', errors);
