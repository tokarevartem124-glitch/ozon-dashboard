import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../ozon-sync.mjs',import.meta.url),'utf8');
function extractFunction(name){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,`function ${name} not found`);
  const bodyStart=source.indexOf('{',start);let depth=0,inString=null,escaped=false;
  for(let i=bodyStart;i<source.length;i++){
    const ch=source[i];
    if(inString){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch===inString)inString=null;continue}
    if(ch==='"'||ch==="'"||ch==='`'){inString=ch;continue}
    if(ch==='{')depth++;
    else if(ch==='}'&&--depth===0)return source.slice(start,i+1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context={
  console,
  TODAY:'2026-09-23',
  asStr:v=>v==null?'':String(v),
  asNum:(v,fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback,
  first:(...xs)=>xs.find(v=>v!==undefined&&v!==null&&v!==''),
  dateOnly:v=>String(v||'').slice(0,10),
  monthKey:v=>String(v||'').slice(0,7),
};
vm.createContext(context);
for(const name of ['postingSkuKey','buildDeliveredItemEvidence','buildDeliveredSalesFromPostingMap','appendMissingMarketplaceBuyoutSales','validateRealizationPublishGate']){
  vm.runInContext(`${extractFunction(name)};this.${name}=${name};`,context);
}

const maps={articleBySku:new Map([['sku-main','4466'],['sku-extra','4477'],['sku-cis','87837']]),nameBySku:new Map()};
const postingMap={
  '18817428-0180-1':{status:'delivered',postingNumber:'18817428-0180-1',orderNumber:'order-1',orderDate:'2026-07-26',orderSchema:'FBS',postingSource:'FBS',observedDeliveredDate:'2026-08-12',observedDeliveredDateSource:'status',products:[
    {sku:'sku-main',article:'4466',name:'Подтверждённая позиция',quantity:1,price:1056,pricePresent:true},
    {sku:'sku-extra',article:'4477',name:'Лишняя позиция',quantity:1,price:959,pricePresent:true},
  ]}
};
const controlRows=[{postingNumber:'18817428-0180-1',sku:'sku-main',article:'4466',soldQty:1}];
const guarded=context.buildDeliveredSalesFromPostingMap(postingMap,'2026-08-01','2026-08-31',maps,[],controlRows);
assert.equal(guarded.rows.length,1);
assert.equal(guarded.rows[0].sku,'sku-main');
assert.equal(guarded.excludedDeliveredProductGross,959);

const cisFinance=[{date:'2026-08-08',postingNumber:'0192431327-0015-1',sku:'sku-cis',article:'87837',name:'СНГ товар',marketplaceBuyout:{quantity:1,sellerPrice:1244}}];
const cis=context.appendMissingMarketplaceBuyoutSales(guarded.rows,cisFinance,{},'2026-08-01','2026-08-31',maps);
assert.equal(cis.added.length,1);
assert.equal(cis.added[0].unitPrice,1244);
assert.equal(cis.missingPostings.length,0);

const noDuplicate=context.appendMissingMarketplaceBuyoutSales(cis.rows,cisFinance,{},'2026-08-01','2026-08-31',maps);
assert.equal(noDuplicate.added.length,0);

const realizedRows=cis.rows.map(r=>({...r,returnedQty:0,netQty:r.soldQty,originalRevenue:r.soldQty*r.unitPrice,revenue:r.soldQty*r.unitPrice,retroReturnedRevenue:0}));
const passed=context.validateRealizationPublishGate({rows:realizedRows,diagnostics:{pAndLPriceMissing:0,marketplaceBuyoutSalesExpectedPostings:1,marketplaceBuyoutSalesCoveredPostings:1,marketplaceBuyoutSalesMissingPostings:[],marketplaceBuyoutSalesInvalidRows:0}});
assert.equal(passed.status,'passed');

const blocked=context.validateRealizationPublishGate({rows:[...realizedRows,realizedRows[0]],diagnostics:{pAndLPriceMissing:0,marketplaceBuyoutSalesMissingPostings:[],marketplaceBuyoutSalesInvalidRows:0}});
assert.equal(blocked.status,'blocked');
assert.equal(blocked.duplicateRows,1);

const dashboardSource=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(dashboardSource,/function productOrderExportColumns\(p\)/);
assert.match(dashboardSource,/'Номер заказа Ozon':orders\.map/);
assert.match(dashboardSource,/'Дата заказа Ozon':orders\.map/);
assert.match(dashboardSource,/'Номер отправления Ozon':orders\.map/);
assert.match(dashboardSource,/\.\.\.productOrderExportColumns\(p\)/);

console.log('Data Guard regression tests passed.');
