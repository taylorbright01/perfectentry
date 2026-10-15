import test from 'node:test';import assert from 'node:assert/strict';
import {average,rsiValues} from '../assets/perfect-view/studies.mjs';
import {indicators,validateStudies,validateDrawing,createDemoBars} from '../assets/perfect-view/core.mjs';
import {validateLayout} from '../assets/perfect-view/layouts.mjs';
test('SMA, WMA, Wilder and EMA match independently calculated values',()=>{
 assert.deepEqual(average([1,2,3,4,5],3),[null,null,2,3,4]);
 assert.deepEqual(average([1,2,3,4,5],3,'wma'),[null,null,14/6,20/6,26/6]);
 assert.deepEqual(average([1,2,3,4,5],3,'ema'),[1,1.5,2.25,3.125,4.0625]);
 const rma=average([1,2,3,4,5],3,'rma');assert.equal(rma[2],2);assert.ok(Math.abs(rma[3]-8/3)<1e-12);
});
test('RSI handles warmup, all gains, all losses and a flat market',()=>{
 assert.deepEqual(rsiValues([1,2,3,4,5],3),[null,null,null,100,100]);
 assert.equal(rsiValues([5,4,3,2],3).at(-1),0);assert.equal(rsiValues([2,2,2,2],3).at(-1),50);
});
test('MACD histogram equals MACD minus signal, and bands use population deviation',()=>{
 const bars=[1,2,3,4,5].map((close,i)=>({time:i*60,close,open:close,high:close+.1,low:close-.1,volume:10}));
 const m=indicators.calculate('macd',bars,{fast:2,slow:4,signal:2});for(let i=0;i<bars.length;i++)assert.ok(Math.abs(m.histograms[0].points[i].value-(m.lines[0].points[i].value-m.lines[1].points[i].value))<1e-12);
 const b=indicators.calculate('bb',bars,{period:3,deviation:2});assert.equal(b.lines[0].points[2].value,2);assert.ok(Math.abs(b.lines[1].points[2].value-(2+2*Math.sqrt(2/3)))<1e-12);
});
test('every default study is causal and individual components can be hidden',()=>{
 const bars=createDemoBars().slice(0,100);for(const definition of indicators.definitions.values()){
  const old=indicators.calculate(definition.id,bars.slice(0,80)),extended=indicators.calculate(definition.id,bars);
  for(const field of ['lines','histograms'])for(let i=0;i<old[field].length;i++)assert.deepEqual(extended[field][i].points.slice(0,80),old[field][i].points,definition.id);
  const settings=Object.fromEntries(Object.entries(definition.inputs).filter(([,v])=>v.type==='boolean').map(([k])=>[k,false]));const hidden=indicators.calculate(definition.id,bars,settings);assert.equal(hidden.lines.length+hidden.histograms.length,0,definition.id);
 }
});
test('study settings reject bad periods and inconsistent RSI/MACD settings',()=>{
 const raw={id:'rsi',key:'x',period:14,color:'#abcdef'};assert.equal(validateStudies([raw]).length,1);
 assert.equal(validateStudies([{...raw,period:0}]).length,0);assert.equal(validateStudies([{...raw,lower:80,upper:20}]).length,0);
 assert.equal(validateStudies([{id:'macd',key:'x',fast:30,slow:12}]).length,0);
});
test('long and short position validation preserves three valid anchors',()=>{
 const d={id:'x',type:'long',points:[{time:10,price:100},{time:20,price:95},{time:30,price:110}],color:'#abcdef'};
 assert.equal(validateDrawing(d).points.length,3);assert.equal(validateDrawing({...d,type:'short'}),null);assert.equal(validateDrawing({...d,points:d.points.slice(0,2)}),null);
});
test('account layout preserves markets/settings and rejects malformed drawing documents',()=>{
 const raw={version:2,name:'London',preferences:{symbol:'EURUSD',timeframe:300,mode:'candles',focus:true,closedOnly:true,refreshSeconds:30},studies:[{id:'rsi',key:'rsi-1',period:14,color:'#abcdef'}],markets:{EURUSD:{drawings:[],viewport:{count:110,endTime:null}},GBPUSD:{drawings:[]}}};
 const layout=validateLayout(raw);assert.equal(layout.studies[0].showLine,true);assert.deepEqual(Object.keys(layout.markets),['EURUSD','GBPUSD']);
 assert.throws(()=>validateLayout({...raw,markets:{EURUSD:{drawings:[{type:'script'}]}}}));
});
