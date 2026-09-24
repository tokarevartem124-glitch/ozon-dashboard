import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../ozon-sync.mjs',import.meta.url),'utf8');
function extractFunction(name){
  const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,`function ${name} not found`);
  const bodyStart=source.indexOf('){',start)+1;assert.ok(bodyStart>0,`function ${name} body not found`);let depth=0,inString=null,escaped=false;
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
  crypto,
  money:v=>Number(v?.amount??v??0),
  classifyService:()=> 'other',
};
vm.createContext(context);
for(const name of ['emptyFinanceComponents','normalizeAccrualFinance','postingSkuKey','buildDeliveredItemEvidence','buildDeliveredSalesFromPostingMap','appendMissingMarketplaceBuyoutSales','applyFinanceRecognitionDates','supplementReturnsFromReturnsApi','applyRetroactiveReturns','validateRealizationPublishGate']){
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

const septemberSale=[{...guarded.rows[0],postingNumber:'0255156325-0006-2',sku:'sku-sep',article:'87004',date:'2026-08-31',deliveryDate:'2026-08-31'}];
const recognized=context.applyFinanceRecognitionDates(septemberSale,[{postingNumber:'0255156325-0006-2',sku:'sku-sep',article:'87004',date:'2026-09-01',saleAmount:6845}]);
assert.equal(recognized.rows[0].date,'2026-09-01');
assert.equal(recognized.rows[0].deliveryDate,'2026-08-31');
assert.equal(recognized.rows[0].recognitionDateSource,'finance-positive-sale-accrual');

const returnedSale=[{...guarded.rows[0],postingNumber:'0153848164-0007-1',sku:'sku-return',article:'49638',soldQty:1,unitPrice:1205,date:'2026-08-21',deliveryDate:'2026-08-21'}];
const supplemented=context.supplementReturnsFromReturnsApi([], [{postingNumber:'0153848164-0007-1',sku:'sku-return',article:'49638',quantity:1,date:'2026-08-21',name:'Возвращённый товар',schema:'FBS'}], returnedSale, {}, maps);
assert.equal(supplemented.addedUnits,1);
const retro=context.applyRetroactiveReturns([...returnedSale,...supplemented.rows],{},'2026-08-01',{historyStart:'2026-01-01',fbsComplete:true},[]);
assert.equal(retro.rows[0].netQty,0);
assert.equal(retro.rows[0].revenue,0);
assert.equal(retro.rows[0].returnStatus,'full');

const compensationPosting='0117367898-0030-1';
const compensationRows=context.normalizeAccrualFinance([{
  date:'2026-08-15',unit_number:compensationPosting,accrual_id:7001,total_amount:6795,
  non_item_fee:{accrual_id:7001,accrued:6795}
}],maps,new Map([[7001,'Начисление по спору: компенсация']]),{
  [compensationPosting]:{postingNumber:compensationPosting,orderNumber:'order-compensation',orderDate:'2026-07-17',orderSchema:'FBS',products:[{sku:'sku-main',article:'4466',name:'Компенсированный товар',quantity:1,price:6795}]}
});
assert.equal(compensationRows.length,1);
assert.equal(compensationRows[0].postingNumber,compensationPosting);
assert.equal(compensationRows[0].sku,'sku-main');
assert.equal(compensationRows[0].financeScope,'posting_item');
assert.equal(compensationRows[0].financeIncomeKind,'compensation');
assert.equal(compensationRows[0].compensationIncome,6795);
assert.equal(compensationRows[0].other,-6795);
assert.equal(compensationRows[0].rawAmount,6795);

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
assert.match(dashboardSource,/Доходы от Ozon всего/);
assert.match(dashboardSource,/'Компенсация Ozon':safe\(r\.compensationIncome\)/);
assert.match(dashboardSource,/v10\.5-compensation-links/);

console.log('Data Guard regression tests passed.');
