import test from 'node:test';import assert from 'node:assert/strict';
import {FxBook,currencyPaths} from '../assets/perfect-view/fx.mjs';
import {CdnFeed} from '../assets/perfect-view/cdn.mjs';
import {GROUPS} from '../assets/perfect-view/protocol.mjs';
import {instrumentPreset,calculatePositionSize} from '../assets/perfect-view/risk.mjs';
const NOW=Date.parse('2026-10-15T12:00:00Z')/1000;
const close=(book,symbol,value,age=0)=>book.set({symbol,close:value,asOf:NOW-age});
function frame(group,asOf=NOW,prices={GBPUSD:1.25,EURUSD:1.1,EURGBP:.88,USDJPY:150,USDCHF:.9,USDCAD:1.3}){
 return {version:1,baseTimeframe:30,group,revision:1,updatedAt:asOf,streams:Object.fromEntries(GROUPS[group].filter(s=>prices[s]).map(symbol=>[symbol,{through:asOf,candles:[[asOf-30,prices[symbol],prices[symbol],prices[symbol],prices[symbol],20,0]]}]))};
}
test('ticker conversion resolves direct, inverse and cross prices without currency cycles',()=>{
 const b=new FxBook();close(b,'GBPUSD',1.25);close(b,'USDCHF',.9);
 assert.equal(b.resolve('GBP','USD',{now:NOW}).rate,1.25);assert.equal(b.resolve('USD','GBP',{now:NOW}).rate,.8);
 const cross=b.resolve('CHF','GBP',{now:NOW});assert.ok(Math.abs(cross.rate-1/.9/1.25)<1e-12);assert.deepEqual(cross.symbols,['USDCHF','GBPUSD']);
 assert.equal(b.resolve('GBP','GBP',{now:NOW}).rate,1);assert.equal(b.resolve('BTC','GBP',{now:NOW}),null);
 assert.ok(currencyPaths('CHF','GBP',['USDCHF','GBPUSD','EURGBP','EURUSD']).every(p=>new Set(p.currencies).size===p.currencies.length));
});
test('conversion rejects old, future and temporally mismatched quotes',()=>{
 const b=new FxBook();close(b,'USDCHF',.9);close(b,'GBPUSD',1.25,90);assert.equal(b.resolve('CHF','GBP',{now:NOW}),null);
 close(b,'GBPCHF',1.125,5);assert.ok(b.resolve('CHF','GBP',{now:NOW}));assert.equal(b.resolve('CHF','GBP',{now:NOW+181}),null);
 close(b,'GBPUSD',1.25,-30);assert.equal(b.resolve('USD','GBP',{now:NOW,maxSkew:0}),null);
});
test('only completed nonempty valid OHLC closes can update conversion rates',()=>{
 const b=new FxBook(),f=frame(2);f.streams.GBPUSD.candles=[[NOW-300,1.2,1.2,1.2,1.2,20,0],[NOW-30,1.3,1.3,1.3,1.3,0,1],[NOW,1.4,1.4,1.4,1.4,20,0],[NOW-60,1.2,1.1,1.0,1.2,20,0]];
 b.ingestFrame(f,2,NOW);assert.equal(b.quotes.get('GBPUSD').close,1.2);assert.equal(b.resolve('USD','GBP',{now:NOW}),null);
 assert.throws(()=>b.ingestFrame({...f,updatedAt:NOW+30},2,NOW));
});
test('account sizing consumes an automatic ticker cross rate with risk rounded down',()=>{
 const b=new FxBook();close(b,'GBPUSD',1.25);const rate=b.resolve('USD','GBP',{now:NOW});
 const result=calculatePositionSize({type:'long',points:[{price:1.1},{price:1.098},{price:1.104}]},{currency:'GBP',balance:10000,mode:'percent',risk:1},instrumentPreset('EURUSD'),'EURUSD',rate);
 assert.equal(result.lots,.62);assert.ok(Math.abs(result.loss-99.2)<1e-8);assert.match(result.conversion,/Ticker GBPUSD/);
});
test('chart ticker group supplies a cached cross rate without extra conversion downloads',async()=>{
 const requests=[],feed=new CdnFeed({url:'https://data.test/',locks:null,now:()=>NOW*1000,fetchImpl:async url=>{requests.push(new URL(url).pathname);return Response.json(frame(1));}});
 await feed.live(1);const rate=await feed.conversionRate('USD','GBP',{refresh:true});assert.ok(Math.abs(rate.rate-.8)<1e-12);assert.deepEqual(rate.symbols,['EURUSD','EURGBP']);assert.equal(requests.length,1);
});
test('missing currency ticker uses one small live group and shares concurrent requests',async()=>{
 const requests=[];let clock=NOW;
 const feed=new CdnFeed({url:'https://data.test/',locks:null,now:()=>clock*1000,fetchImpl:async url=>{const pathname=new URL(url).pathname;requests.push(pathname);const group=Number(/g(\d)/.exec(pathname)[1]);await new Promise(r=>setTimeout(r,2));return Response.json(frame(group,Math.floor(clock/30)*30));}});
 await feed.live(3);const rates=await Promise.all(Array.from({length:20},()=>feed.conversionRate('USD','GBP',{refresh:true})));
 assert.ok(rates.every(r=>r.rate===.8));assert.equal(requests.length,2);assert.equal(requests[1],'/pv/v1/live/g2.json');
 for(let i=0;i<100;i++)assert.equal(feed.fxBook.resolve('USD','GBP',{now:clock}).rate,.8);assert.equal(requests.length,2);
 clock+=90;await feed.conversionRate('USD','GBP',{refresh:true});assert.equal(requests.length,3);assert.ok(requests.every(p=>p.includes('/live/')));
});
test('unavailable FX data backs off and never fetches chart history or accepts stale prices',async()=>{
 const requests=[];let clock=NOW;
 const feed=new CdnFeed({url:'https://data.test/',locks:null,now:()=>clock*1000,fetchImpl:async url=>{requests.push(new URL(url).pathname);const group=Number(/g(\d)/.exec(new URL(url).pathname)[1]);return Response.json(frame(group,NOW-600));}});
 await assert.rejects(feed.conversionRate('USD','GBP',{refresh:true}),/fresh ticker/);assert.ok(requests.length<=3);const count=requests.length;
 clock+=60;await assert.rejects(feed.conversionRate('USD','GBP',{refresh:true}),/fresh ticker/);assert.equal(requests.length,count);assert.ok(requests.every(p=>p.includes('/live/')));
});
test('a live group cannot inject a conversion quote from a different group',async()=>{
 const f=frame(3);f.streams.GBPUSD=frame(2).streams.GBPUSD;
 const feed=new CdnFeed({url:'https://data.test/',locks:null,now:()=>NOW*1000,fetchImpl:async()=>Response.json(f)});await feed.live(3);assert.equal(feed.fxBook.quotes.has('GBPUSD'),false);
});
