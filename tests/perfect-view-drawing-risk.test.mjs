import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultFib,validateFib,fibPrices,validatePriceRange} from '../assets/perfect-view/drawings.mjs';
import {validateDrawing} from '../assets/perfect-view/core.mjs';
import {instrumentPreset,calculatePositionSize,validateRiskSession} from '../assets/perfect-view/risk.mjs';
import {validateLayout} from '../assets/perfect-view/layouts.mjs';
import {PerfectViewChart} from '../assets/perfect-view/chart.mjs';
const session={currency:'USD',balance:10000,mode:'percent',risk:1};
const drawing=(entry=1.1,stop=1.098,target=1.104,type='long')=>({type,points:[{time:10,price:entry},{time:20,price:stop},{time:30,price:target}]});
test('fib ratios retain swing direction, extensions and independent appearance',()=>{
 const settings=defaultFib();settings.levels=[{value:0,color:'#abcdef',opacity:.3,visible:true},{value:.618,color:'#123456',opacity:1,visible:true},{value:1.618,color:'#123456',opacity:1,visible:true},{value:.5,color:'#ffffff',opacity:1,visible:false}];
 const prices=fibPrices([{price:100},{price:200}],settings);assert.equal(prices.length,3);assert.ok(Math.abs(prices[1].price-138.2)<1e-10);assert.ok(Math.abs(prices[2].price-38.2)<1e-10);
 assert.equal(fibPrices([{price:200},{price:100}],settings)[1].price,161.8);
 const validated=validateDrawing({id:'fib',type:'fib',points:[{time:10,price:100},{time:20,price:200}],fib:settings});assert.equal(validated.fib.levels[0].opacity,.3);assert.equal(validated.fib.levels[0].color,'#abcdef');
 assert.equal(validateFib({...settings,levels:settings.levels.map(l=>({...l,visible:false}))}),null);assert.equal(validateFib({...settings,width:100}),null);assert.equal(validateFib({...settings,levels:[{...settings.levels[0],value:Infinity}]}),null);
 assert.equal(validateDrawing({...validated,points:[{time:10,price:100},{time:20,price:100}]}),null);
});
test('vertical zoom preserves time and its anchor, and reset restores auto scale',()=>{
 const chart=Object.create(PerfectViewChart.prototype);Object.assign(chart,{bars:[{}],count:110,end:200,min:100,max:200,plot:{top:0,bottom:500,height:500},requestDraw(){},emit(){}});
 chart.zoomPrice(.5,125);assert.deepEqual(chart.getPriceRange(),{min:137.5,max:187.5});assert.equal(chart.count,110);assert.equal(chart.end,200);
 assert.equal(chart.min+(500-125)/500*(chart.max-chart.min),175);
 chart.resetPriceScale();assert.equal(chart.getPriceRange(),null);assert.equal(validatePriceRange({min:10,max:10}),null);
});
test('price-axis drags do not move time or leave a manual range after cancellation',()=>{
 const chart=Object.create(PerfectViewChart.prototype);Object.assign(chart,{bars:[{time:0}],drawings:[],count:110,end:200,min:100,max:200,tool:'select',priceRange:null,plot:{left:0,right:900,width:900,top:0,bottom:500,height:500},position:e=>({x:e.clientX,y:e.clientY}),canvas:{style:{},setPointerCapture(){}},requestDraw(){},emit(){}});
 chart.onDown({button:0,pointerId:1,clientX:920,clientY:200});chart.onMove({pointerId:1,clientX:920,clientY:201});assert.equal(chart.end,200);
 chart.onMove({pointerId:1,clientX:920,clientY:260});assert.ok(chart.getPriceRange());assert.equal(chart.end,200);chart.onCancel({pointerId:1});assert.equal(chart.getPriceRange(),null);
});
test('position size is rounded down, never upsized to the minimum or risk budget',()=>{
 const p=instrumentPreset('EURUSD'),s=calculatePositionSize(drawing(),session,p,'EURUSD');assert.equal(s.ok,true);assert.equal(s.lots,.5);assert.equal(s.units,50000);assert.ok(Math.abs(s.loss-100)<1e-10);
 const rounded=calculatePositionSize(drawing(1.1,1.0979,1.104),session,p,'EURUSD');assert.equal(rounded.lots,.47);assert.ok(rounded.loss<=100);
 const low=calculatePositionSize(drawing(),{...session,balance:1},p,'EURUSD');assert.equal(low.lots,0);assert.match(low.message,/minimum/);
 const fee=calculatePositionSize(drawing(),session,{...p,commissionPerLot:7},'EURUSD');assert.equal(fee.lots,.48);assert.ok(fee.loss<=100);assert.ok(Math.abs(fee.rr-fee.reward/fee.loss)<1e-12);
 const capped=calculatePositionSize(drawing(),session,{...p,maxLot:.1},'EURUSD');assert.equal(capped.lots,.1);assert.match(capped.message,/maximum/);
});
test('cash risk, short positions and quote/base account currencies use the correct units',()=>{
 const p=instrumentPreset('USDJPY'),d=drawing(150,151,148,'short');
 const result=calculatePositionSize(d,{...session,mode:'cash',risk:100},p,'USDJPY');assert.equal(result.ok,true);assert.equal(result.lots,.15);assert.ok(Math.abs(result.loss-.15*100000/151)<1e-10);assert.ok(Math.abs(result.reward-.15*2*100000/148)<1e-10);
 const jpy=calculatePositionSize(d,{...session,currency:'JPY',balance:1000000},p,'USDJPY');assert.equal(jpy.lots,.1);assert.equal(jpy.loss,10000);
 const bad=calculatePositionSize(d,session,p,'EURJPY');assert.equal(bad.ok,false);assert.match(bad.message,/ticker conversion/);
 const converted=calculatePositionSize(d,session,p,'EURJPY',{rate:.0065,symbols:['USDJPY']});assert.equal(converted.ok,true);assert.equal(converted.lots,.15);
});
test('CFD contract and account-currency tick modes require broker inputs',()=>{
 const p=instrumentPreset('XAUUSD'),d=drawing(2600,2595,2610);assert.equal(calculatePositionSize(d,session,p,'XAUUSD').ok,false);
 const gold=calculatePositionSize(d,session,{...p,contractSize:100},'XAUUSD');assert.equal(gold.lots,.2);assert.equal(gold.units,20);assert.equal(gold.loss,100);
 const ticks=calculatePositionSize(d,session,{...p,mode:'tick',tickSize:.1,tickValue:10,contractSize:100},'XAUUSD');assert.equal(ticks.lots,.2);assert.equal(ticks.loss,100);
 assert.equal(calculatePositionSize(d,session,{...p,mode:'tick'},'XAUUSD').ok,false);
 assert.equal(validateRiskSession({...session,risk:101}),null);assert.equal(calculatePositionSize(d,{...session,mode:'cash',risk:10001},{...p,contractSize:100},'XAUUSD').ok,false);
 assert.equal(calculatePositionSize(d,session,{...p,contractSize:100,lotStep:0},'XAUUSD').ok,false);
 assert.equal(calculatePositionSize(d,session,{...p,contractSize:100,lotStep:1e-300},'XAUUSD').ok,false);
});
test('account layout round-trips fib appearance and a manual vertical range',()=>{
 const fib={id:'f',...drawing(100,99,110),type:'fib',points:[{time:10,price:100},{time:20,price:110}],fib:defaultFib()};fib.fib.levels[0].color='#123456';
 const raw={version:2,name:'Fib workspace',preferences:{symbol:'EURUSD',timeframe:300,mode:'candles',focus:true,closedOnly:true,refreshSeconds:30},studies:[],markets:{EURUSD:{drawings:[fib],viewport:{count:110,endTime:20,priceRange:{min:101,max:108}}}}};
 const result=validateLayout(raw);assert.equal(result.markets.EURUSD.drawings[0].fib.levels[0].color,'#123456');assert.deepEqual(result.markets.EURUSD.viewport.priceRange,{min:101,max:108});
 assert.throws(()=>validateLayout({...raw,markets:{EURUSD:{...raw.markets.EURUSD,viewport:{count:110,endTime:20,priceRange:{min:108,max:101}}}}}));
});
