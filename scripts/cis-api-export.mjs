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

const payload = {
  kind: 'ozon_cis_buyout_diagnostic',
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
    postingRowsScanned: allPostings.length,
    matchingPostingRows: matchingPostings.length,
    fboError: fbo.error ?? null,
    fbsError: fbs.error ?? null,
    transactionErrors: transactionChunks.map(chunk => chunk.error ?? null),
    buyoutErrors: buyoutChunks.map(chunk => chunk.result?.__error ?? null)
  },
  buyouts,
  matchingTransactions,
  matchingPostings
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
