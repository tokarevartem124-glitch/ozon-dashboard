import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/*
  Ozon dashboard incremental sync.

  Modes:
    fast  - hourly: products, prices, stocks, only recent finance operations.
    daily - once a day: everything from fast + only the NEW analytics date range.

  State persistence:
    The previous encrypted payload is downloaded from the already deployed
    GitHub Pages site, decrypted inside GitHub Actions with DASHBOARD_PASSWORD,
    merged with fresh API data, and encrypted again. This avoids downloading
    120 days from Ozon on every run and keeps sensitive data encrypted at rest.
*/

const BASE = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const SYNC_MODE = String(process.env.SYNC_MODE || 'fast').toLowerCase();
const PREVIOUS_DATA_URL = process.env.PREVIOUS_DATA_URL || '';
const FINANCE_LOOKBACK_DAYS = Math.max(1, Number(process.env.FINANCE_LOOKBACK_DAYS || 3));
const ANALYTICS_MAX_CATCHUP_DAYS = Math.max(1, Number(process.env.ANALYTICS_MAX_CATCHUP_DAYS || 7));
const ANALYTICS_PAGE_DELAY_MS = Math.max(61000, Number(process.env.ANALYTICS_PAGE_DELAY_MS || 65000));

if (!CLIENT_ID || !API_KEY || !PASSWORD) {
  throw new Error('Missing OZON_CLIENT_ID, OZON_API_KEY or DASHBOARD_PASSWORD');
}
if (!['fast', 'daily'].includes(SYNC_MODE)) {
  throw new Error(`Unknown SYNC_MODE=${SYNC_MODE}; expected fast or daily`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDate = d => d.toISOString().slice(0, 10);
const asNum = (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const asStr = v => v == null ? '' : String(v);
const first = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '');
const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};
const maxDateStr = (...vals) => vals.filter(Boolean).sort().at(-1) || null;
const minDateStr = (...vals) => vals.filter(Boolean).sort().at(0) || null;

const now = new Date();
const TODAY = isoDate(now);
const YESTERDAY = isoDate(new Date(now.getTime() - 86400000));

async function post(endpoint, body, { allowError = false, retries = 3, analytics = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    let json;
    try { json = text ? JSON.parse(text) : {}; }
    catch { json = { raw: text }; }

    if (res.ok) return json;

    const msg = `${endpoint}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 800)}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : analytics
          ? 90000
          : Math.min(20000, 2500 * (attempt + 1));
      console.warn(`${msg} — retry ${attempt + 1}/${retries} after ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
      continue;
    }

    if (allowError) return { __error: msg, __status: res.status };
    throw new Error(msg);
  }
}

async function testAuth() {
  return post('/v4/product/info/limit', {});
}

/* ----------------------------- encryption ----------------------------- */
function encryptJson(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const iterations = 250000;
  const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    data: Buffer.concat([ciphertext, tag]).toString('base64'),
    generatedAt: obj.generatedAt
  };
}

function decryptJson(env, password) {
  const salt = Buffer.from(env.salt, 'base64');
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.data, 'base64');
  if (data.length < 17) throw new Error('Encrypted payload is too short');
  const ciphertext = data.subarray(0, data.length - 16);
  const tag = data.subarray(data.length - 16);
  const key = crypto.pbkdf2Sync(password, salt, Number(env.iterations || 250000), 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
}

async function loadPreviousPayload() {
  if (!PREVIOUS_DATA_URL) return null;
  try {
    const sep = PREVIOUS_DATA_URL.includes('?') ? '&' : '?';
    const res = await fetch(`${PREVIOUS_DATA_URL}${sep}t=${Date.now()}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const env = await res.json();
    const payload = decryptJson(env, PASSWORD);
    console.log(`Previous encrypted state loaded: version=${payload.version}; generatedAt=${payload.generatedAt}`);
    return payload;
  } catch (e) {
    console.warn(`Previous state unavailable; using embedded baseline. ${e}`);
    return null;
  }
}

/* -------------------------- embedded baseline -------------------------- */
async function loadEmbeddedBaseline() {
  try {
    const html = await fs.readFile(path.join(process.cwd(), 'index.html'), 'utf8');
    const packMatch = html.match(/const EMBEDDED_PACK = (\{.*?\});\nconst EMBEDDED_META/s);
    const metaMatch = html.match(/const EMBEDDED_META = (\{.*?\});\nconst EMBEDDED_IDS/s);
    if (!packMatch || !metaMatch) throw new Error('EMBEDDED_PACK/EMBEDDED_META not found in index.html');
    const pack = JSON.parse(packMatch[1]);
    const meta = Function(`"use strict";return (${metaMatch[1]})`)();
    const unpack = p => p.rows.map(a => Object.fromEntries(p.fields.map((f, i) => [f, a[i]])));
    const datasets = {};
    for (const k of ['sales', 'stock', 'price', 'finance', 'cost']) {
      if (pack[k] && meta[k]) datasets[k] = { ...meta[k], rows: unpack(pack[k]) };
    }
    console.log(`Embedded baseline loaded: sales=${datasets.sales?.rows?.length || 0}; finance=${datasets.finance?.rows?.length || 0}`);
    return datasets;
  } catch (e) {
    console.warn(`Could not read embedded baseline: ${e}`);
    return {};
  }
}

function datasetOf(payload, type) {
  return payload?.datasets?.find(d => d.type === type) || null;
}

/* ------------------------------- products ------------------------------ */
async function fetchProducts() {
  const items = [];
  let lastId = '';
  for (let guard = 0; guard < 100; guard++) {
    let r = await post('/v3/product/list', {
      filter: { visibility: 'ALL' },
      last_id: lastId,
      limit: 1000
    }, { allowError: true });
    if (r.__error && guard === 0) {
      r = await post('/v2/product/list', { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
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
    const body = { filter: { visibility: 'ALL' }, limit: 1000 };
    if (cursor) body.cursor = cursor;
    let r = await post(endpoint, body, { allowError: true });
    if (r.__error && guard === 0) {
      endpoint = '/v4/product/info/prices';
      r = await post(endpoint, { filter: { visibility: 'ALL' }, limit: 1000, last_id: '' });
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

async function fetchProductStocks() {
  const items = [];
  let cursor = '';
  let endpoint = '/v4/product/info/stocks';
  for (let guard = 0; guard < 100; guard++) {
    let r = await post(endpoint, { cursor, filter: { visibility: 'ALL' }, limit: 1000 }, { allowError: true });
    if (r.__error && guard === 0) { endpoint = '/v3/product/info/stocks'; break; }
    if (r.__error) throw new Error(r.__error);
    const result = r.result || r;
    const batch = Array.isArray(result.items) ? result.items : [];
    items.push(...batch);
    const next = asStr(first(result.cursor, r.cursor));
    if (!batch.length || batch.length < 1000 || !next || next === cursor) return { rows: items, source: endpoint, complete: true };
    cursor = next;
  }

  if (endpoint === '/v3/product/info/stocks') {
    const legacy = [];
    let lastId = '';
    for (let guard = 0; guard < 100; guard++) {
      const r = await post(endpoint, { filter: { visibility: 'ALL' }, last_id: lastId, limit: 1000 });
      const result = r.result || r;
      const batch = Array.isArray(result.items) ? result.items : [];
      legacy.push(...batch);
      const next = asStr(first(result.last_id, r.last_id));
      if (!batch.length || batch.length < 1000 || !next || next === lastId) return { rows: legacy, source: endpoint, complete: true };
      lastId = next;
    }
    return { rows: legacy, source: endpoint, complete: false };
  }
  return { rows: items, source: endpoint, complete: false };
}

/* ----------------------------- mappings ------------------------------- */
function extractProductSkuCandidates(p) {
  const set = new Set();
  for (const v of [p.sku, p.fbo_sku, p.fbs_sku]) if (v) set.add(asStr(v));
  for (const s of p.sources || []) for (const v of [s.sku, s.source_sku]) if (v) set.add(asStr(v));
  return [...set];
}

function buildMaps(products, stockRaw, previousStockRows = []) {
  const articleBySku = new Map();
  const nameBySku = new Map();
  const productByArticle = new Map();

  for (const p of products) {
    const article = asStr(first(p.offer_id, p.offerId));
    const productId = asStr(first(p.product_id, p.id));
    if (article) productByArticle.set(article, { article, productId, name: asStr(p.name) });
    for (const sku of extractProductSkuCandidates(p)) {
      if (article) articleBySku.set(sku, article);
      if (p.name) nameBySku.set(sku, asStr(p.name));
    }
  }

  for (const s of stockRaw) {
    const article = asStr(first(s.item_code, s.offer_id, s.offerId));
    const directSku = asStr(first(s.sku, s.fbo_sku, s.fbs_sku));
    const nested = Array.isArray(s.stocks) ? s.stocks.map(st => asStr(first(st.sku, st.fbo_sku, st.fbs_sku))).filter(Boolean) : [];
    for (const sku of new Set([directSku, ...nested].filter(Boolean))) {
      if (article) articleBySku.set(sku, article);
      if (first(s.item_name, s.name)) nameBySku.set(sku, asStr(first(s.item_name, s.name)));
    }
  }

  for (const r of previousStockRows || []) {
    const article = asStr(r.article);
    const sku = asStr(r.sku);
    if (article && sku && !articleBySku.has(sku)) articleBySku.set(sku, article);
    if (sku && r.name && !nameBySku.has(sku)) nameBySku.set(sku, asStr(r.name));
    if (article && !productByArticle.has(article)) productByArticle.set(article, { article, productId: asStr(r.productId), name: asStr(r.name) });
  }

  return { articleBySku, nameBySku, productByArticle };
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
  return { fbo, fbs };
}

function normalizeStock(stockRaw, maps, priceByArticle) {
  const grouped = new Map();
  for (const r of stockRaw) {
    const nestedSkus = Array.isArray(r.stocks) ? r.stocks.map(st => asStr(first(st.sku, st.fbo_sku, st.fbs_sku))).filter(Boolean) : [];
    const sku = asStr(first(r.sku, r.fbo_sku, r.fbs_sku, nestedSkus[0]));
    const article = asStr(first(r.item_code, r.offer_id, r.offerId, maps.articleBySku.get(sku)));
    if (!sku && !article) continue;
    const key = article || `sku:${sku}`;
    const o = grouped.get(key) || {
      article, sku,
      name: asStr(first(r.item_name, r.name, maps.nameBySku.get(sku), maps.productByArticle.get(article)?.name)),
      category: '', type: '', brand: '',
      productId: asStr(first(r.product_id, maps.productByArticle.get(article)?.productId)),
      volume: null, currentPrice: null,
      stockFbo: 0, stockFbs: 0, stockRealFbs: 0,
      reservedFbo: 0, reservedFbs: 0
    };

    if ('free_to_sell_amount' in r) {
      o.stockFbo += asNum(r.free_to_sell_amount);
    } else if (Array.isArray(r.stocks)) {
      for (const st of r.stocks) {
        const type = String(first(st.type, st.stock_type, st.warehouse_type, st.shipment_type, '')).toLowerCase();
        const present = asNum(first(st.present, st.stock, st.free_to_sell_amount));
        const reserved = Math.max(0, asNum(first(st.reserved, st.reserved_amount), 0));
        const available = Math.max(0, present - reserved);
        if (type.includes('fbs') || type.includes('rfbs')) {
          o.stockFbs += available; o.reservedFbs += reserved;
        } else {
          o.stockFbo += available; o.reservedFbo += reserved;
        }
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
      article, sku: '', productId,
      name: asStr(first(p.name, maps.productByArticle.get(article)?.name)),
      currentPrice: getPriceValue(p),
      volume: asNum(first(p.volume_weight, p.volume), NaN),
      cost: null, costColumn: null, acquiring: null,
      commissionFbo: comm.fbo, commissionFbs: comm.fbs,
      logMaxFbo: null, lastMileFbo: null, nonstandardFbo: null,
      procMaxFbs: null, logMaxFbs: null, lastMileFbs: null, nonstandardFbs: null,
      orders7: null
    };
  }).filter(r => r.article);
}

/* ------------------------------ finance ------------------------------- */
function monthChunks(fromStr, toStr) {
  const out = [];
  let cur = new Date(`${fromStr}T00:00:00Z`);
  const end = new Date(`${toStr}T23:59:59.999Z`);
  while (cur <= end) {
    const monthEnd = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const stop = monthEnd < end ? monthEnd : end;
    out.push([cur.toISOString(), stop.toISOString()]);
    cur = new Date(stop.getTime() + 1);
  }
  return out;
}

async function fetchFinance(fromDate, toDate) {
  const operations = [];
  for (const [from, to] of monthChunks(fromDate, toDate)) {
    for (let page = 1; page < 1000; page++) {
      const r = await post('/v3/finance/transaction/list', {
        filter: {
          date: { from, to },
          operation_type: [], posting_number: '', transaction_type: 'ALL'
        },
        page, page_size: 1000
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

function signedExpenseFromServicePrice(price) { return -asNum(price, 0); }
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
    const comp = { commission: 0, acquiring: 0, logistics: 0, storage: 0, ads: 0, fines: 0, returns: 0, other: 0 };
    comp.commission += Math.abs(asNum(op.sale_commission, 0));
    comp.logistics += Math.abs(asNum(op.delivery_charge, 0));
    comp.returns += Math.abs(asNum(op.return_delivery_charge, 0));
    for (const s of op.services || []) comp[classifyService(s.name)] += signedExpenseFromServicePrice(s.price);
    const known = Object.values(comp).reduce((a, b) => a + b, 0);
    comp.other += gross - known - amount;
    rows.push({
      date: asStr(op.operation_date).slice(0, 10),
      article, sku,
      group: asStr(op.type),
      operation: asStr(first(op.operation_type_name, op.operation_type)),
      transactionId: asStr(op.operation_id),
      grossRevenue: gross || null,
      soldQty: 0, returnedQty: 0,
      commission: comp.commission, acquiring: comp.acquiring, logistics: comp.logistics,
      storage: comp.storage, ads: comp.ads, fines: comp.fines, returns: comp.returns,
      other: comp.other, rawAmount: amount
    });
  }
  return rows;
}

function mergeFinanceRows(previousRows, freshRows) {
  const newIds = new Set(freshRows.map(r => asStr(r.transactionId)).filter(Boolean));
  const kept = previousRows.filter(r => !newIds.has(asStr(r.transactionId)));
  const noIdSeen = new Set();
  const merged = [];
  for (const r of [...kept, ...freshRows]) {
    if (r.transactionId) { merged.push(r); continue; }
    const k = [r.date, r.article, r.sku, r.operation, r.rawAmount, r.commission, r.logistics].join('|');
    if (!noIdSeen.has(k)) { noIdSeen.add(k); merged.push(r); }
  }
  merged.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.transactionId).localeCompare(String(b.transactionId)));
  return merged;
}

/* ----------------------------- analytics ------------------------------ */
const ANALYTICS_METRICS = ['revenue', 'ordered_units', 'delivered_units', 'returns', 'cancellations', 'hits_view', 'session_view_pdp', 'hits_tocart'];

async function analyticsRequest(fromDate, toDate, offset) {
  return post('/v1/analytics/data', {
    date_from: fromDate,
    date_to: toDate,
    dimension: ['sku'],
    filters: [],
    metrics: ANALYTICS_METRICS,
    sort: [{ key: 'revenue', order: 'DESC' }],
    limit: 1000,
    offset
  }, { allowError: true, retries: 1, analytics: true });
}

async function fetchAnalyticsSegment(fromDate, toDate) {
  const data = [];
  for (let offset = 0, pageNo = 0; offset < 50000; offset += 1000, pageNo++) {
    if (pageNo > 0) await sleep(ANALYTICS_PAGE_DELAY_MS);
    const page = await analyticsRequest(fromDate, toDate, offset);
    if (page.__error) return { rows: data, metrics: ANALYTICS_METRICS, complete: false, error: page.__error };
    const batch = page?.result?.data || [];
    data.push(...batch);
    console.log(`Analytics delta page: ${fromDate}..${toDate}; offset=${offset}; rows=${batch.length}; accumulated=${data.length}`);
    if (batch.length < 1000) return { rows: data, metrics: ANALYTICS_METRICS, complete: true };
  }
  return { rows: data, metrics: ANALYTICS_METRICS, complete: false, error: 'Analytics pagination safety limit reached' };
}

function normalizeAnalyticsRows(rawRows, metrics, maps) {
  const idx = Object.fromEntries(metrics.map((m, i) => [m, i]));
  return rawRows.map(r => {
    const dim = r.dimensions?.[0] || {};
    const sku = asStr(first(dim.id, dim.value, dim.name));
    const article = asStr(maps.articleBySku.get(sku));
    const m = r.metrics || [];
    return {
      name: asStr(first(maps.nameBySku.get(sku), dim.name)),
      category1: '', category2: '', category3: '', brand: '', scheme: '', sku, article,
      revenue: idx.revenue != null ? asNum(m[idx.revenue]) : 0,
      impressions: idx.hits_view != null ? asNum(m[idx.hits_view]) : 0,
      visits: idx.session_view_pdp != null ? asNum(m[idx.session_view_pdp]) : 0,
      carts: idx.hits_tocart != null ? asNum(m[idx.hits_tocart]) : 0,
      ordered: idx.ordered_units != null ? asNum(m[idx.ordered_units]) : 0,
      delivered: idx.delivered_units != null ? asNum(m[idx.delivered_units]) : 0
    };
  });
}

function analyticsSegmentsFromState(previousPayload, embeddedSales) {
  if (Array.isArray(previousPayload?.history?.analyticsSegments) && previousPayload.history.analyticsSegments.length) {
    return previousPayload.history.analyticsSegments;
  }
  if (embeddedSales?.rows?.length) {
    return [{
      id: 'embedded-baseline', start: embeddedSales.start, end: embeddedSales.end,
      source: 'embedded-excel', rows: embeddedSales.rows
    }];
  }
  const prevSales = datasetOf(previousPayload, 'sales');
  return prevSales?.rows?.length ? [{ id: 'previous-sales', start: prevSales.start, end: prevSales.end, source: 'previous-payload', rows: prevSales.rows }] : [];
}

function aggregateSalesSegments(segments) {
  const byKey = new Map();
  for (const seg of segments) {
    for (const r of seg.rows || []) {
      const key = asStr(r.article) || `sku:${asStr(r.sku)}`;
      if (!key) continue;
      const o = byKey.get(key) || {
        name: '', category1: '', category2: '', category3: '', brand: '', scheme: '', sku: '', article: '',
        revenue: 0, impressions: 0, visits: 0, carts: 0, ordered: 0, delivered: 0
      };
      for (const f of ['name', 'category1', 'category2', 'category3', 'brand', 'scheme', 'sku', 'article']) if (!o[f] && r[f]) o[f] = r[f];
      for (const f of ['revenue', 'impressions', 'visits', 'carts', 'ordered', 'delivered']) o[f] += asNum(r[f]);
      byKey.set(key, o);
    }
  }
  return [...byKey.values()];
}

async function updateAnalyticsSegments(segments, maps, warnings) {
  if (SYNC_MODE !== 'daily') return segments;

  const lastEnd = segments.map(s => s.end).filter(Boolean).sort().at(-1) || null;
  let fromDate = lastEnd ? addDays(lastEnd, 1) : YESTERDAY;
  if (fromDate > YESTERDAY) {
    console.log(`Analytics already current through ${lastEnd}; no analytics API call needed.`);
    return segments;
  }

  const maxTo = addDays(fromDate, ANALYTICS_MAX_CATCHUP_DAYS - 1);
  const toDate = minDateStr(YESTERDAY, maxTo);
  console.log(`Analytics incremental catch-up: ${fromDate}..${toDate}`);

  const result = await fetchAnalyticsSegment(fromDate, toDate);
  if (!result.complete) {
    warnings.push(`Analytics delta ${fromDate}..${toDate} incomplete: ${result.error || 'unknown error'}. Previous analytics is kept unchanged.`);
    return segments;
  }

  const rows = normalizeAnalyticsRows(result.rows, result.metrics, maps);
  return [...segments, {
    id: `api-${fromDate}_${toDate}`,
    start: fromDate, end: toDate, source: 'Ozon Seller API incremental', rows
  }];
}

/* ------------------------------- main -------------------------------- */
console.log(`Ozon incremental sync mode=${SYNC_MODE}; today=${TODAY}`);
await testAuth();
console.log('Auth OK');

const warnings = [];
const previousPayload = await loadPreviousPayload();
const embedded = await loadEmbeddedBaseline();

const previousStock = datasetOf(previousPayload, 'stock') || embedded.stock || null;
const previousPrice = datasetOf(previousPayload, 'price') || embedded.price || null;
const previousFinance = datasetOf(previousPayload, 'finance') || embedded.finance || null;

const products = await fetchProducts().catch(e => { warnings.push(`Products: ${e}`); return []; });
console.log(`Products: ${products.length}`);
const prices = await fetchPrices().catch(e => { warnings.push(`Prices: ${e}`); return []; });
console.log(`Prices: ${prices.length}`);
const stockResult = await fetchProductStocks().catch(e => { warnings.push(`Stocks: ${e}`); return { rows: [], source: 'error', complete: false }; });
console.log(`Stocks product rows: ${stockResult.rows.length}; source=${stockResult.source}; complete=${stockResult.complete}`);

const maps = buildMaps(products, stockResult.rows, previousStock?.rows || []);
const priceByArticle = new Map(prices.map(p => [asStr(first(p.offer_id, p.offerId)), p]).filter(x => x[0]));
const freshStockRows = normalizeStock(stockResult.rows, maps, priceByArticle);
const freshPriceRows = normalizePrices(prices, maps);
const stockComplete = Boolean(stockResult.complete && freshStockRows.length > 1000 && (!products.length || freshStockRows.length >= Math.floor(products.length * 0.70)));

const finalStockRows = stockComplete ? freshStockRows : (previousStock?.rows || []);
if (!stockComplete) warnings.push(`Stock refresh incomplete (${freshStockRows.length}/${products.length}); previous stock snapshot kept.`);
const finalPriceRows = freshPriceRows.length ? freshPriceRows : (previousPrice?.rows || []);
if (!freshPriceRows.length) warnings.push('Price refresh returned no rows; previous price snapshot kept.');

/* Finance: refetch only a small overlapping tail, then replace transactions by operation_id. */
const prevFinanceRows = previousFinance?.rows || [];
const prevFinanceEnd = prevFinanceRows.map(r => r.date).filter(Boolean).sort().at(-1) || embedded.finance?.end || addDays(TODAY, -FINANCE_LOOKBACK_DAYS);
const financeFrom = maxDateStr(embedded.finance?.start, addDays(prevFinanceEnd, -(FINANCE_LOOKBACK_DAYS - 1))) || addDays(TODAY, -FINANCE_LOOKBACK_DAYS);
console.log(`Finance incremental window: ${financeFrom}..${TODAY}; previous rows=${prevFinanceRows.length}`);
const financeOps = await fetchFinance(financeFrom, TODAY).catch(e => { warnings.push(`Finance: ${e}`); return []; });
const freshFinanceRows = normalizeFinance(financeOps, maps);
const financeRows = financeOps.length ? mergeFinanceRows(prevFinanceRows, freshFinanceRows) : prevFinanceRows;
console.log(`Finance fresh operations: ${financeOps.length}; merged rows=${financeRows.length}`);

let financeMultiItemOps = 0, financeNoItemOps = 0;
const financeItemSkus = new Set();
for (const op of financeOps) {
  const items = Array.isArray(op.items) ? op.items : [];
  if (items.length > 1) financeMultiItemOps++;
  if (!items.length) financeNoItemOps++;
  for (const it of items) if (it?.sku != null) financeItemSkus.add(asStr(it.sku));
}
const financeMappedSkus = [...financeItemSkus].filter(sku => maps.articleBySku.has(sku)).length;

/* Analytics: preserve the embedded 3-month baseline and only append dates after it. */
let analyticsSegments = analyticsSegmentsFromState(previousPayload, embedded.sales);
analyticsSegments = await updateAnalyticsSegments(analyticsSegments, maps, warnings);
const salesRows = aggregateSalesSegments(analyticsSegments);
const salesStart = analyticsSegments.map(s => s.start).filter(Boolean).sort().at(0) || null;
const salesEnd = analyticsSegments.map(s => s.end).filter(Boolean).sort().at(-1) || null;
console.log(`Analytics segments: ${analyticsSegments.length}; coverage=${salesStart}..${salesEnd}; aggregated rows=${salesRows.length}`);

const generatedAt = new Date().toISOString();
const datasets = [];

if (salesRows.length) datasets.push({
  id: `api-sales-${salesStart}_${salesEnd}`,
  apiAuto: true, type: 'sales', label: 'Продажи / воронка (база + автообновление)',
  sheetName: 'Seller API incremental + embedded baseline', sourceName: 'Ozon',
  start: salesStart, end: salesEnd, snapshot: null, importedAt: generatedAt,
  capabilities: { sales: true, funnel: true, api: true, incremental: true },
  rows: salesRows
});

if (finalStockRows.length) datasets.push({
  id: `api-stock-${TODAY}`,
  apiAuto: true, type: 'stock', label: 'Остатки Ozon API',
  sheetName: stockComplete ? stockResult.source : (previousStock?.sheetName || 'previous snapshot'), sourceName: 'Ozon Seller API',
  start: null, end: null, snapshot: TODAY, importedAt: generatedAt,
  capabilities: { stock: true, prices: true, api: true, complete: stockComplete },
  rows: finalStockRows
});

if (finalPriceRows.length) datasets.push({
  id: `api-price-${TODAY}`,
  apiAuto: true, type: 'price', label: 'Цены / комиссии Ozon API',
  sheetName: 'product/info/prices', sourceName: 'Ozon Seller API',
  start: null, end: null, snapshot: TODAY, importedAt: generatedAt,
  capabilities: { prices: true, tariffEstimate: true, api: true, complete: Boolean(freshPriceRows.length) },
  rows: finalPriceRows
});

if (financeRows.length) {
  const financeStart = financeRows.map(r => r.date).filter(Boolean).sort().at(0) || previousFinance?.start || null;
  const financeEnd = financeRows.map(r => r.date).filter(Boolean).sort().at(-1) || TODAY;
  const financeNetTotal = financeRows.reduce((s, r) => s + asNum(r.rawAmount), 0);
  datasets.push({
    id: `api-finance-${financeStart}_${financeEnd}`,
    apiAuto: true, type: 'finance', label: 'Финансы Ozon API (инкрементально)',
    sheetName: 'finance/transaction/list', sourceName: 'Ozon Seller API',
    start: financeStart, end: financeEnd, snapshot: null, importedAt: generatedAt,
    capabilities: {
      finance: true, accrualReport: true, grossRevenue: true, api: true, incremental: true,
      components: ['commission', 'acquiring', 'logistics', 'storage', 'ads', 'fines', 'returns', 'other'],
      rawNetTotal: financeNetTotal,
      multiItemOperationsInLatestWindow: financeMultiItemOps,
      note: 'Общие суммы финансов точные. Операции с несколькими SKU не распределяются искусственно по товарам без дополнительной детализации.'
    },
    rows: financeRows
  });
}

const payload = {
  version: 3,
  generatedAt,
  syncMode: SYNC_MODE,
  clientId: CLIENT_ID,
  datasets,
  history: { analyticsSegments },
  diagnostics: {
    mode: SYNC_MODE,
    previousStateLoaded: Boolean(previousPayload),
    products: products.length,
    prices: prices.length,
    stockRows: finalStockRows.length,
    stockFreshComplete: stockComplete,
    financeRefreshFrom: financeFrom,
    financeFreshOperations: financeOps.length,
    financeRows: financeRows.length,
    financeFreshUniqueItemSkus: financeItemSkus.size,
    financeFreshMappedSkus: financeMappedSkus,
    financeFreshMultiItemOps: financeMultiItemOps,
    financeFreshNoItemOps: financeNoItemOps,
    analyticsSegments: analyticsSegments.length,
    analyticsCoverage: { from: salesStart, to: salesEnd },
    analyticsRows: salesRows.length,
    warnings
  }
};

await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
await fs.writeFile(path.join(process.cwd(), 'data', 'ozon-data.enc.json'), JSON.stringify(encryptJson(payload, PASSWORD)));
await fs.writeFile(path.join(process.cwd(), 'data', 'ozon-status.json'), JSON.stringify({
  ok: warnings.length === 0,
  generatedAt,
  mode: SYNC_MODE,
  counts: payload.diagnostics,
  note: 'No API key or detailed financial values are stored in this public status file.'
}, null, 2));

console.log(`Encrypted dashboard state written. mode=${SYNC_MODE}; warnings=${warnings.length}`);
if (warnings.length) console.warn('Non-fatal sync warnings:', warnings);
