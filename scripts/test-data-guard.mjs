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
  FINANCE_COMPONENT_KEYS:['commission','acquiring','logistics','storage','ads','fines','returns','other'],
};
vm.createContext(context);
for(const name of ['emptyFinanceComponents','normalizeAccrualFinance','applyValidatedCompensationLinks','financeTotals','commonOzonExpenseGroup','splitCommonOzonExpenses','attributeOrderFinanceToSaleDate','postingSkuKey','buildDeliveredItemEvidence','buildDeliveredSalesFromPostingMap','appendMissingMarketplaceBuyoutSales','applyFinanceRecognitionDates','supplementReturnsFromReturnsApi','applyRetroactiveReturns','validateRealizationPublishGate']){
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

const anonymousCompensation=[{
  date:'2026-08-07',article:'',sku:'',postingNumber:'',orderNumber:'',financeScope:'period',financeAttribution:'unallocated',
  transactionId:'anonymous-6795',grossRevenue:null,rawAmount:6795,compensationIncome:0,...context.emptyFinanceComponents(),other:-6795,
  chargeLines:[{typeName:'Корректировка сверки начисления',component:'other',amount:-6795}]
}];
const linkedCompensation=context.applyValidatedCompensationLinks(anonymousCompensation,{rows:[{id:'aug-claim-6795',period:'2026-08',postingNumber:compensationPosting,amount:6795,name:'Компенсированный товар'}]}, {
  [compensationPosting]:{postingNumber:compensationPosting,orderNumber:'order-compensation',orderDate:'2026-07-17',orderSchema:'FBS',products:[{sku:'sku-main',article:'4466',name:'Компенсированный товар',quantity:1,price:6795}]}
},maps);
assert.equal(linkedCompensation.rows.length,1);
assert.equal(linkedCompensation.rows[0].postingNumber,compensationPosting);
assert.equal(linkedCompensation.rows[0].financeIncomeKind,'compensation');
assert.equal(linkedCompensation.rows[0].compensationIncome,6795);
assert.equal(linkedCompensation.rows[0].rawAmount,6795);
assert.equal(linkedCompensation.rows[0].other,-6795);
assert.equal(linkedCompensation.diagnostics.total,6795);

const augustRealized=[{
  date:'2026-08-22',recognitionDate:'2026-08-22',postingNumber:'post-aug',orderNumber:'order-aug',sku:'sku-main',article:'4466',soldQty:1,originalRevenue:2000
}];
const rawPeriodFinance=[
  {...context.emptyFinanceComponents(),date:'2026-09-02',postingNumber:'post-aug',orderNumber:'order-aug',sku:'sku-main',article:'4466',operation:'Вознаграждение за продажу',rawAmount:-300,commission:300},
  {...context.emptyFinanceComponents(),date:'2026-09-05',postingNumber:'post-aug',orderNumber:'order-aug',sku:'sku-main',article:'4466',operation:'Обработка возврата',rawAmount:-140,returns:140},
  {...context.emptyFinanceComponents(),date:'2026-09-06',postingNumber:'',orderNumber:'',sku:'',article:'',operation:'Premium подписка',rawAmount:-990,other:990},
  {...context.emptyFinanceComponents(),date:'2026-09-07',postingNumber:'post-aug',orderNumber:'order-aug',sku:'sku-main',article:'4466',operation:'Компенсация Ozon',financeIncomeKind:'compensation',rawAmount:200,other:-200}
];
const attributed=context.attributeOrderFinanceToSaleDate(rawPeriodFinance,augustRealized);
assert.equal(attributed.rows[0].date,'2026-08-22');
assert.equal(attributed.rows[0].financeDate,'2026-09-02');
assert.equal(attributed.rows[0].accountingDateSource,'order-sale-date');
assert.equal(attributed.rows[1].date,'2026-09-05');
assert.equal(attributed.rows[1].returnDatePolicy,'finance-date');
assert.equal(attributed.rows[2].date,'2026-09-06');
assert.equal(attributed.rows[2].accountingDateSource,'finance-date');
assert.equal(attributed.rows[3].date,'2026-09-07');
assert.equal(attributed.rows[3].accountingDateSource,'finance-date');
assert.equal(attributed.diagnostics.shiftedRows,1);
assert.equal(attributed.diagnostics.returnRowsKeptOnFinanceDate,1);
assert.equal(attributed.diagnostics.positiveIncomeRowsKeptOnFinanceDate,1);
assert.equal(attributed.diagnostics.totalDelta,0);

const mixedOrderCharge={
  ...context.emptyFinanceComponents(),date:'2026-09-02',postingNumber:'post-aug',orderNumber:'order-aug',sku:'sku-main',article:'4466',
  transactionId:'mixed-order-charge',operation:'Штраф по заказу',grossRevenue:1000,rawAmount:650,commission:300,fines:50,financeAttribution:'direct_sku',financeScope:'posting_item',
  chargeLines:[
    {typeName:'Вознаграждение за продажу',component:'commission',amount:300},
    {typeName:'Жалобы покупателей: неполная комплектация',component:'fines',amount:50}
  ]
};
const split=context.splitCommonOzonExpenses([mixedOrderCharge]);
assert.equal(split.rows.length,2);
assert.equal(split.diagnostics.ledgerDelta,0);
assert.equal(split.rows.reduce((z,r)=>z+r.rawAmount,0),650);
const splitOrder=split.rows.find(r=>!r.commonExpense),splitPeriod=split.rows.find(r=>r.commonExpense);
assert.equal(splitOrder.rawAmount,700);
assert.equal(splitOrder.commission,300);
assert.equal(splitOrder.fines,0);
assert.equal(splitPeriod.rawAmount,-50);
assert.equal(splitPeriod.fines,50);
assert.equal(splitPeriod.article,'');
assert.equal(splitPeriod.sku,'');
assert.equal(splitPeriod.financeScope,'period');
assert.equal(splitPeriod.commonExpenseGroup,'Ошибки продавца');
assert.equal(splitPeriod.sourcePostingNumber,'post-aug');
const splitAttributed=context.attributeOrderFinanceToSaleDate(split.rows,augustRealized);
assert.equal(splitAttributed.rows.find(r=>!r.commonExpense).date,'2026-08-22');
assert.equal(splitAttributed.rows.find(r=>r.commonExpense).date,'2026-09-02');
assert.equal(splitAttributed.diagnostics.periodCommonRowsKeptOnFinanceDate,1);

const premiumSplit=context.splitCommonOzonExpenses([{...context.emptyFinanceComponents(),date:'2026-08-10',transactionId:'premium',rawAmount:-24990,other:24990,financeAttribution:'unallocated',financeScope:'period',chargeLines:[{typeName:'Premium-подписка',component:'other',amount:24990}]}]);
assert.equal(premiumSplit.rows[0].commonExpenseGroup,'Премиум-подписка');
assert.equal(premiumSplit.diagnostics.groups['Премиум-подписка'],24990);
assert.equal(context.commonOzonExpenseGroup({typeName:'Корректировка сверки начисления',component:'other'},{operation:'Premium-подписка'}),'Премиум-подписка');
assert.equal(context.commonOzonExpenseGroup({typeName:'Временное размещение товара партнерами',component:'other'}),'Платное хранение товаров на ПВЗ');
assert.equal(context.commonOzonExpenseGroup({typeName:'Обеспечение материалами для упаковки товара',component:'other'}),'Дополнительная упаковка возвратов');
assert.equal(context.commonOzonExpenseGroup({typeName:'Упаковка товара партнёрами',component:'other'}),'Дополнительная упаковка возвратов');

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
assert.match(dashboardSource,/v10\.8-period-common-expenses/);

console.log('Data Guard regression tests passed.');
