import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const BASE='https://api-seller.ozon.ru';
const CLIENT_ID=process.env.OZON_CLIENT_ID;
const API_KEY=process.env.OZON_API_KEY;
const POSTING='52304939-0332-1';
const CLAIM='1001150430';
const SKU='2869144787';
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqIM5FyePArk5m19E6CEv
dhsK6sQzSNQLE+evURaLzzfhOn7PIFY9awZI5oOr4tn5HIql2prtNbKHg2Z9K+IV
W16wXNFstSuyt+gtZj5+pGJuKj3btpiur3eTby3a54Iea5wObUtlfilVrh4Oyn41
F/Um0DSd8fAWqfyys9Bg2Msb6ldRBBo0ogHID6rsFngRg/Q73/dNA+NCn6Qf4wqD
RVUYaxM+FJOUuZZyAxJYw6Fm0Wa9LCFjDiOdZ2m6/N58LRt+080TAGFWccxlweC7
08Y2rIo+P2EFA/kHWJGTjb9IjQkJQZTC2PTdNij78h9v3xJjVdlN3uIr9q5YJYgC
PQIDAQAB
-----END PUBLIC KEY-----`;

if(!CLIENT_ID||!API_KEY) throw new Error('Missing Ozon credentials');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function post(path,body){
  for(let attempt=0;attempt<4;attempt++){
    const response=await fetch(BASE+path,{method:'POST',headers:{'Client-Id':CLIENT_ID,'Api-Key':API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
    const text=await response.text();
    let json; try{json=text?JSON.parse(text):{}}catch{json={raw:text}}
    if(response.ok) return json;
    if((response.status===429||response.status>=500)&&attempt<3){await sleep(1200*(attempt+1));continue}
    return {__error:{status:response.status,body:json}};
  }
}

function candidate(row){
  const s=JSON.stringify(row);
  return s.includes(POSTING)||s.includes(CLAIM)||s.includes(SKU)||/1503[.,]5/.test(s)||/2856(?:[.,]0+)?(?:[^0-9]|$)/.test(s);
}

async function allTransactions(from,to){
  const matches=[]; let total=0; let error=null;
  for(let page=1;page<=40;page++){
    const json=await post('/v3/finance/transaction/list',{filter:{date:{from:from+'T00:00:00.000Z',to:to+'T23:59:59.999Z'},operation_type:[],posting_number:'',transaction_type:'ALL'},page,page_size:1000});
    if(json.__error){error=json.__error;break}
    const root=json.result??json;
    const batch=Array.isArray(root.operations)?root.operations:[];
    total+=batch.length; matches.push(...batch.filter(candidate));
    if(batch.length<1000 || (Number(root.page_count)>0 && page>=Number(root.page_count))) break;
    await sleep(450);
  }
  return {total,matches,error};
}

function addDay(day){
  const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1);return d.toISOString().slice(0,10);
}

async function dailyAccrualMatches(from,to){
  const matches=[]; const errors=[]; let total=0;
  for(let day=from;day<=to;day=addDay(day)){
    let last='';
    for(let page=1;page<=50;page++){
      const json=await post('/v1/finance/accrual/by-day',{date:day,last_id:last});
      if(json.__error){errors.push({day,error:json.__error});break}
      const batch=Array.isArray(json.accruals)?json.accruals:[];
      total+=batch.length;
      matches.push(...batch.filter(candidate).map(row=>({queryDay:day,row})));
      const next=String(json.last_id??'');
      if(!batch.length||!next||next===last) break;
      last=next; await sleep(250);
    }
  }
  return {total,matches,errors};
}

const payload={
  generatedAt:new Date().toISOString(),
  postingNumber:POSTING,claimNumber:CLAIM,sku:SKU,
  posting:await post('/v3/posting/fbs/get',{posting_number:POSTING,with:{analytics_data:true,barcodes:false,financial_data:true,legal_info:false,translit:false}}),
  accrualPostings:await post('/v1/finance/accrual/postings',{posting_numbers:[POSTING]}),
  transactions:{
    june:await allTransactions('2026-06-01','2026-06-30'),
    july:await allTransactions('2026-07-01','2026-07-31'),
    august:await allTransactions('2026-08-01','2026-08-31'),
    september:await allTransactions('2026-09-01','2026-09-30')
  },
  dailyAccruals:{
    juneJuly:await dailyAccrualMatches('2026-06-01','2026-07-31'),
    august:await dailyAccrualMatches('2026-08-01','2026-08-31')
  }
};

const key=crypto.randomBytes(32),iv=crypto.randomBytes(12);
const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
const data=Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload),'utf8')),cipher.final()]);
const wrappedKey=crypto.publicEncrypt({key:PUBLIC_KEY,padding:crypto.constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
await fs.mkdir('diagnostic-output',{recursive:true});
await fs.writeFile('diagnostic-output/compensation-check.enc.json',JSON.stringify({v:1,alg:'RSA-OAEP-SHA256+AES-256-GCM',wrappedKey:wrappedKey.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
console.log('Encrypted expanded Ozon API result created');
