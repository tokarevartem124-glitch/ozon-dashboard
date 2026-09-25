import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const BASE = 'https://api-seller.ozon.ru';
const CLIENT_ID = process.env.OZON_CLIENT_ID;
const API_KEY = process.env.OZON_API_KEY;
const PUBLIC_KEY_B64 = process.env.EXPORT_PUBLIC_KEY_B64;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

if (!CLIENT_ID || !API_KEY || !PUBLIC_KEY_B64) {
  throw new Error('Missing OZON_CLIENT_ID, OZON_API_KEY or EXPORT_PUBLIC_KEY_B64');
}

async function post(endpoint, body, { retries = 4, allowError = false } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(`${BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Client-Id': CLIENT_ID,
        'Api-Key': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body ?? {})
    });
    const text = await response.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (response.ok) return json;
    const error = { endpoint, status: response.status, body: json };
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2500 * (attempt + 1));
      continue;
    }
    if (allowError) return { __error: error };
    throw new Error(JSON.stringify(error));
  }
}

async function fetchBuyouts(dateFrom, dateTo) {
  const result = await post('/v1/finance/products/buyout', {
    date_from: dateFrom,
    date_to: dateTo
  }, { allowError: true });
  return { dateFrom, dateTo, result };
}

async function fetchTransactions(dateFrom, dateTo) {
  const operations = [];
  for (let page = 1; page <= 200; page++) {
    const response = await post('/v3/finance/transaction/list', {
      filter: {
        date: {
          from: `${dateFrom}T00:00:00.000Z`,
          to: `${dateTo}T23:59:59.999Z`
        },
        operation_type: [],
        posting_number: '',
        transaction_type: 'ALL'
      },
      page,
      page_size: 1000
    }, { allowError: true });
    if (response.__error) return { dateFrom, dateTo, operations, error: response.__error };
    const root = response.result ?? response;
    const batch = Array.isArray(root.operations) ? root.operations : [];
    operations.push(...batch);
    const pageCount = Number(root.page_count ?? 0);
    if (!batch.length || batch.length < 1000 || (pageCount && page >= pageCount)) break;
    await sleep(700);
  }
  return { dateFrom, dateTo, operations };
}

function addDays(day, amount) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function dateRange(dateFrom, dateTo) {
  const result = [];
  for (let day = dateFrom; day <= dateTo; day = addDays(day, 1)) result.push(day);
  return result;
}

async function fetchAccrualTypes() {
  return post('/v1/finance/accrual/types', {}, { allowError: true });
}

async function fetchAccruals(dateFrom, dateTo) {
  const rows = [];
  const errors = [];
  for (const date of dateRange(dateFrom, dateTo)) {
    let lastId = '';
    for (let page = 1; page <= 500; page++) {
      const response = await post('/v1/finance/accrual/by-day', {
        date,
        last_id: lastId
      }, { allowError: true });
      if (response.__error) {
        errors.push({ date, error: response.__error });
        break;
      }
      const batch = Array.isArray(response.accruals) ? response.accruals : [];
      rows.push(...batch);
      const next = String(response.last_id ?? '');
      if (!batch.length || !next || next === lastId) break;
      lastId = next;
      await sleep(350);
    }
  }
  return { dateFrom, dateTo, rows, errors };
}

function rfcStart(day) { return `${day}T00:00:00.000Z`; }
function rfcEnd(day) { return `${day}T23:59:59.999Z`; }

async function fetchPostingPages(endpoint, bodyFactory, label) {
  const postings = [];
  let cursor = '';
  for (let page = 1; page <= 300; page++) {
    const response = await post(endpoint, bodyFactory(cursor), { allowError: true });
    if (response.__error) return { label, postings, error: response.__error };
    const root = response.result ?? response;
    const batch = Array.isArray(root.postings) ? root.postings : [];
    postings.push(...batch);
    const next = String(root.cursor ?? '');
    if (!batch.length || !root.has_next || !next || next === cursor) break;
    cursor = next;
    await sleep(700);
  }
  return { label, postings };
}

function postingNumberFromTransaction(operation) {
  return String(
    operation?.posting?.posting_number ??
    operation?.posting_number ??
    operation?.posting?.delivery_schema ?? ''
  );
}

function buyoutProducts(chunk) {
  const root = chunk?.result ?? {};
  return Array.isArray(root.products) ? root.products : [];
}

const today = new Date().toISOString().slice(0, 10);
const buyoutChunks = [
  await fetchBuyouts('2026-08-01', '2026-08-31'),
  await fetchBuyouts('2026-09-01', today)
];
const buyouts = buyoutChunks.flatMap(buyoutProducts);
const buyoutPostingNumbers = new Set(buyouts.map(row => String(row.posting_number ?? '')).filter(Boolean));

const transactionChunks = [
  await fetchTransactions('2026-08-01', '2026-08-31'),
  await fetchTransactions('2026-09-01', today)
];
const allTransactions = transactionChunks.flatMap(chunk => chunk.operations ?? []);
const matchingTransactions = allTransactions.filter(operation => buyoutPostingNumbers.has(postingNumberFromTransaction(operation)));

const accrualTypes = await fetchAccrualTypes();
const accrualChunks = [
  await fetchAccruals('2026-06-01', '2026-07-31'),
  await fetchAccruals('2026-08-01', '2026-08-31'),
  await fetchAccruals('2026-09-01', today)
];
const allAccruals = accrualChunks.flatMap(chunk => chunk.rows ?? []);
const matchingAccruals = allAccruals.filter(accrual => {
  const postingNumber = String(accrual?.posting?.posting_number ?? accrual?.unit_number ?? '');
  return buyoutPostingNumbers.has(postingNumber);
});

const postingFrom = '2026-06-01';
const fbo = await fetchPostingPages('/v3/posting/fbo/list', cursor => ({
  cursor,
  filter: { since: rfcStart(postingFrom), to: rfcEnd(today) },
  limit: 100,
  sort_dir: 'asc',
  translit: false,
  with: { analytics_data: true, financial_data: true, legal_info: false }
}), 'FBO');
const fbs = await fetchPostingPages('/v4/posting/fbs/list', cursor => ({
  cursor,
  filter: { since: rfcStart(postingFrom), to: rfcEnd(today) },
  limit: 100,
  sort_dir: 'asc',
  translit: false,
  with: { analytics_data: true, barcodes: false, financial_data: true, legal_info: false, translit: false }
}), 'FBS');

const allPostings = [...(fbo.postings ?? []), ...(fbs.postings ?? [])];
const matchingPostings = allPostings.filter(posting => {
  const number = String(posting.posting_number ?? '');
  const flagged = (posting.products ?? []).some(product => product.is_marketplace_buyout === true);
  return buyoutPostingNumbers.has(number) || flagged;
});

function accrualPostingNumber(accrual) {
  return String(accrual?.posting?.posting_number ?? accrual?.unit_number ?? '');
}

function moneyAmount(value) {
  const raw = value && typeof value === 'object' ? value.amount : value;
  const number = Number(raw ?? 0);
  return Number.isFinite(number) ? number : 0;
}

const augustAccrualsByPosting = new Map();
for (const accrual of allAccruals) {
  if (String(accrual?.date ?? '').slice(0, 7) !== '2026-08') continue;
  const number = accrualPostingNumber(accrual);
  if (!number) continue;
  const rows = augustAccrualsByPosting.get(number) ?? [];
  rows.push(accrual);
  augustAccrualsByPosting.set(number, rows);
}

const ordinaryCandidates = allPostings
  .filter(posting => {
    const number = String(posting?.posting_number ?? '');
    const products = Array.isArray(posting?.products) ? posting.products : [];
    const accruals = augustAccrualsByPosting.get(number) ?? [];
    const isBuyout = products.some(product => product?.is_marketplace_buyout === true);
    const hasCommission = accruals.some(accrual =>
      (accrual?.posting?.products ?? []).some(product => product?.commission != null)
    );
    const hasDeliveryService = accruals.some(accrual =>
      (accrual?.posting?.products ?? []).some(product =>
        Array.isArray(product?.delivery?.services) && product.delivery.services.length > 0
      )
    );
    const hasPositiveAccrual = accruals.some(accrual => moneyAmount(accrual?.total_amount) > 0);
    return String(posting?.status ?? '').toLowerCase() === 'delivered' &&
      !isBuyout && products.length === 1 && accruals.length > 0 &&
      hasCommission && hasDeliveryService && hasPositiveAccrual;
  })
  .sort((a, b) => String(a.posting_number).localeCompare(String(b.posting_number)));

const ordinaryTargetPostingNumber = '0116834127-0208-1';
const ordinaryPosting = ordinaryCandidates.find(posting =>
  String(posting?.posting_number ?? '') === ordinaryTargetPostingNumber
) ?? null;
const ordinaryPostingNumber = String(ordinaryPosting?.posting_number ?? '');
const ordinaryOrderNumber = String(ordinaryPosting?.order_number ?? '');
const ordinaryAccruals = allAccruals.filter(accrual => {
  if (String(accrual?.date ?? '').slice(0, 7) !== '2026-08') return false;
  const unitNumber = accrualPostingNumber(accrual);
  return unitNumber === ordinaryPostingNumber || unitNumber === ordinaryOrderNumber;
});

const payload = {
  kind: 'ozon_august_finance_reconciliation_export',
  generatedAt: new Date().toISOString(),
  requestedThrough: {
    buyout: '/v1/finance/products/buyout',
    transactions: '/v3/finance/transaction/list',
    fbo: '/v3/posting/fbo/list',
    fbs: '/v4/posting/fbs/list'
  },
  periods: ['2026-08-01..2026-08-31', `2026-09-01..${today}`],
  diagnostics: {
    buyoutRows: buyouts.length,
    buyoutPostings: buyoutPostingNumbers.size,
    transactionRowsScanned: allTransactions.length,
    matchingTransactionRows: matchingTransactions.length,
    accrualRowsScanned: allAccruals.length,
    matchingAccrualRows: matchingAccruals.length,
    postingRowsScanned: allPostings.length,
    matchingPostingRows: matchingPostings.length,
    ordinaryCandidates: ordinaryCandidates.length,
    ordinaryPostingNumber,
    ordinaryOrderNumber,
    ordinaryAccrualRows: ordinaryAccruals.length,
    fboError: fbo.error ?? null,
    fbsError: fbs.error ?? null,
    transactionErrors: transactionChunks.map(chunk => chunk.error ?? null),
    accrualErrors: accrualChunks.flatMap(chunk => chunk.errors ?? []),
    buyoutErrors: buyoutChunks.map(chunk => chunk.result?.__error ?? null)
  },
  buyouts,
  accrualTypes,
  matchingAccruals,
  matchingTransactions,
  matchingPostings,
  fullAugust: {
    accruals: accrualChunks[1]?.rows ?? [],
    transactions: transactionChunks[0]?.operations ?? [],
    buyouts: buyoutChunks[0] ? buyoutProducts(buyoutChunks[0]) : [],
    postings: allPostings.filter(posting => {
      const orderDate = String(posting?.in_process_at ?? posting?.created_at ?? posting?.shipment_date ?? posting?.delivering_date ?? '');
      return orderDate.slice(0, 7) <= '2026-08' || String(posting?.status ?? '').toLowerCase() === 'delivered';
    })
  },
  fullAudit: {
    accruals: allAccruals,
    postings: allPostings
  },
  ordinarySample: {
    posting: ordinaryPosting,
    accruals: ordinaryAccruals
  }
};

const aesKey = crypto.randomBytes(32);
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
const tag = cipher.getAuthTag();
const publicKey = Buffer.from(PUBLIC_KEY_B64, 'base64').toString('utf8');
const wrappedKey = crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, aesKey);

await fs.mkdir('diagnostic-output', { recursive: true });
await fs.writeFile('diagnostic-output/cis-api-export.enc.json', JSON.stringify({
  version: 1,
  algorithm: 'RSA-OAEP-SHA256+AES-256-GCM',
  wrappedKey: wrappedKey.toString('base64'),
  iv: iv.toString('base64'),
  tag: tag.toString('base64'),
  data: encrypted.toString('base64')
}));

console.log(`Encrypted CIS export created: buyouts=${buyouts.length}; postings=${buyoutPostingNumbers.size}; matchedTransactions=${matchingTransactions.length}; matchedPostings=${matchingPostings.length}`);
