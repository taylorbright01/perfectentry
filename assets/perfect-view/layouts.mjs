import {TIMEFRAMES,validateDrawing,validateStudies,indicators} from './core.mjs';
import {validatePriceRange} from './drawings.mjs';
export function validateLayout(raw, registry) {
 const fail=()=>{throw new Error('Invalid layout.');};
 if(raw?.version!==2||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>80||!raw.preferences||!raw.markets||Array.isArray(raw.markets)||typeof raw.markets!=='object')fail();
 const p=raw.preferences;
 if(!/^[A-Z0-9._-]{2,24}$/.test(p.symbol??'')||!TIMEFRAMES.includes(p.timeframe)||!['candles','line'].includes(p.mode)||typeof p.focus!=='boolean'||typeof p.closedOnly!=='boolean'||![30,60].includes(p.refreshSeconds))fail();
 if(!Array.isArray(raw.studies)||raw.studies.length>12)fail();const studies=validateStudies(raw.studies,registry);if(studies.length!==raw.studies.length)fail();
 if(studies.filter(s=>s.enabled!==false&&((registry??indicators).definitions.get(s.id)?.pane==='oscillator')).length>4)fail();
 const markets={};let count=0;
 if(Object.keys(raw.markets).length>40)fail();
 for(const [symbol,state] of Object.entries(raw.markets)){
  if(!/^[A-Z0-9._-]{2,24}$/.test(symbol)||!Array.isArray(state?.drawings)||state.drawings.length>300)fail();
  const drawings=state.drawings.map(validateDrawing);if(drawings.some(d=>!d))fail();count+=drawings.length;
  let viewport=null;
  if(state.viewport!=null){const v=state.viewport;if(!Number.isFinite(v.count)||v.count<12||v.count>1500||!(v.endTime===null||(Number.isFinite(v.endTime)&&v.endTime>=0&&v.endTime<4102444800)))fail();const priceRange=validatePriceRange(v.priceRange);if(v.priceRange!=null&&!priceRange)fail();viewport={count:v.count,endTime:v.endTime,...(priceRange?{priceRange}:{})};}
  markets[symbol]={drawings,viewport};
 }
 if(count>3000)fail();
 return {version:2,name:raw.name.trim(),preferences:{symbol:p.symbol,timeframe:p.timeframe,mode:p.mode,focus:p.focus,closedOnly:p.closedOnly,refreshSeconds:p.refreshSeconds},studies,markets};
}
