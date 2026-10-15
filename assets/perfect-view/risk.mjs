export const ACCOUNT_CURRENCIES=['USD','GBP','EUR','JPY','AUD','CAD','CHF','NZD'];
export function instrumentPreset(symbol) {
  const base=symbol.slice(0,3),quote=symbol.slice(3,6);
  const forex=symbol.length===6&&ACCOUNT_CURRENCIES.includes(base)&&ACCOUNT_CURRENCIES.includes(quote)&&base!==quote;
  return {mode:'contract',contractSize:forex?100000:0,profitCurrency:/^[A-Z]{6}$/.test(symbol)&&ACCOUNT_CURRENCIES.includes(quote)?quote:'USD',lotStep:.01,minLot:.01,maxLot:0,tickSize:0,tickValue:0,commissionPerLot:0,forex};
}
export function validateRiskSession(raw) {
  if(!raw||!ACCOUNT_CURRENCIES.includes(raw.currency)||!Number.isFinite(raw.balance)||raw.balance<0||raw.balance>1e12||!['percent','cash'].includes(raw.mode)||!Number.isFinite(raw.risk)||raw.risk<=0||raw.risk>1e12||(raw.mode==='percent'&&raw.risk>100))return null;
  return {currency:raw.currency,balance:raw.balance,mode:raw.mode,risk:raw.risk,updated:typeof raw.updated==='string'?raw.updated.slice(0,30):''};
}
export function calculatePositionSize(drawing,session,profile,symbol,conversionRate) {
  const fail=message=>({ok:false,message});
  if(!drawing||!['long','short'].includes(drawing.type)||drawing.points?.length!==3)return fail('Draw or select a long/short position.');
  const [entry,stop,target]=drawing.points.map(p=>p.price),direction=drawing.type==='long'?1:-1;
  if(![entry,stop,target].every(p=>Number.isFinite(p)&&p>0)||(entry-stop)*direction<=0||(target-entry)*direction<=0)return fail('Place the stop on the loss side and target on the profit side.');
  const s=validateRiskSession(session);
  if(!s||s.balance<=0)return fail('Enter your session balance and risk.');
  const budget=s.mode==='percent'?s.balance*s.risk/100:s.risk;
  if(budget>s.balance)return fail('Risk amount exceeds the session balance.');
  const p=profile??{},distance=Math.abs(entry-stop),rewardDistance=Math.abs(target-entry);
  if(!['contract','tick'].includes(p.mode)||!Number.isFinite(p.lotStep)||p.lotStep<=0||p.lotStep>1000||!Number.isFinite(p.minLot)||p.minLot<=0||!Number.isFinite(p.maxLot)||p.maxLot<0||(p.maxLot&&p.maxLot<p.minLot)||!Number.isFinite(p.commissionPerLot)||p.commissionPerLot<0)return fail('Check the broker lot step, minimum, maximum and commission.');
  let lossPerLot,rewardPerLot,conversion;
  if(p.mode==='tick'){
    if(!(p.tickSize>0&&p.tickValue>0&&Number.isFinite(p.tickSize)&&Number.isFinite(p.tickValue)))return fail('Enter the broker tick size and loss tick value in your account currency.');
    lossPerLot=distance/p.tickSize*p.tickValue;rewardPerLot=rewardDistance/p.tickSize*p.tickValue;conversion='Account-currency tick value';
  }else{
    if(!Number.isFinite(p.contractSize)||p.contractSize<=0||p.contractSize>1e12||!ACCOUNT_CURRENCIES.includes(p.profitCurrency))return fail('Enter the contract units per lot and profit currency from MT5.');
    let lossRate,rewardRate;
    if(p.profitCurrency===s.currency){lossRate=rewardRate=1;conversion=p.profitCurrency+' = account currency';}
    else if(symbol.length===6&&symbol.slice(0,3)===s.currency&&symbol.slice(3)===p.profitCurrency){lossRate=1/stop;rewardRate=1/target;conversion='Converted at drawn stop/target';}
    else if(conversionRate&&Number.isFinite(conversionRate.rate)&&conversionRate.rate>0&&conversionRate.rate<1e9){lossRate=rewardRate=conversionRate.rate;conversion=(conversionRate.sample?'Sample ':'Ticker ')+(conversionRate.symbols??[]).join(' → ')+' · '+p.profitCurrency+' → '+s.currency;}
    else return fail('Waiting for the '+p.profitCurrency+' → '+s.currency+' ticker conversion.');
    lossPerLot=distance*p.contractSize*lossRate;rewardPerLot=rewardDistance*p.contractSize*rewardRate;
  }
  lossPerLot+=p.commissionPerLot;rewardPerLot-=p.commissionPerLot;
  if(!Number.isFinite(lossPerLot)||lossPerLot<=0||!Number.isFinite(rewardPerLot))return fail('The position calculation is outside the supported range.');
  const maximum=Math.min(budget/lossPerLot,p.maxLot||Infinity);
  if(!Number.isFinite(maximum)||maximum>1e12)return fail('Check the contract size or tick value; the calculated volume is outside the supported range.');
  // Always round down to a broker volume step. A minimum is never rounded up into excess risk.
  const steps=Math.floor((maximum+Math.max(1,maximum)*1e-12)/p.lotStep);
  if(!Number.isSafeInteger(steps))return fail('Check the broker lot step; the volume precision is outside the supported range.');
  let lots=Number((steps*p.lotStep).toPrecision(12));
  if(lots*lossPerLot>budget+Math.max(1,budget)*1e-10)lots=Number(Math.max(0,lots-p.lotStep).toPrecision(12));
  if(lots+1e-12<p.minLot)lots=0;
  const units=Number.isFinite(p.contractSize)&&p.contractSize>0?lots*p.contractSize:null;
  return {ok:true,lots,units,budget,loss:lots*lossPerLot,reward:lots*rewardPerLot,rr:rewardPerLot/lossPerLot,distance,conversion,currency:s.currency,message:lots===0?'Below the broker minimum at this risk.':p.maxLot>0&&maximum===p.maxLot?'Limited by the broker maximum.':''};
}
