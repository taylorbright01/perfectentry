import test from 'node:test';import assert from 'node:assert/strict';import {CdnFeed} from '../assets/perfect-view/cdn.mjs';
import {aggregateBars} from '../assets/perfect-view/core.mjs';
const NOW=Date.parse('2026-10-15T12:00:00Z'),before=Math.floor(NOW/86400000)*86400-3*86400;
test('browser-native fetch keeps its required global receiver',async()=>{
 const native=globalThis.fetch;let called=false;globalThis.fetch=async function(){assert.equal(this,globalThis);called=true;return new Response('{}');};
 try{const feed=new CdnFeed({url:'https://data.example/',locks:null});await feed.file('example.json');assert.equal(called,true);}finally{globalThis.fetch=native;}
});

function rollingFeed(){
 const end=NOW/1000,latestHour=end-3600,requests=[];let liveClose=1.2;
 const row=time=>[time,1,1.5,.5,1.1,10,0];
 const feed=new CdnFeed({url:'https://data.example/',locks:null,now:()=>NOW,fetchImpl:async(url,{signal})=>{
  signal?.throwIfAborted();const path=new URL(url).pathname;requests.push(path);
  if(path.includes('/live/'))return Response.json({version:1,baseTimeframe:30,group:1,revision:1,updatedAt:end,streams:{EURUSD:{through:end,brokerSymbol:'EURUSD',firstHour:latestHour-71*3600,lastHour:latestHour,candles:[...Array.from({length:4},(_,i)=>{const r=row(end-120+i*30);r[4]=liveClose;return r;})]}}});
  const hour=Number(path.split('/').at(-1).replace('.json',''));
  return Response.json({version:1,baseTimeframe:30,group:1,hour,streams:{EURUSD:Array.from({length:120},(_,i)=>row(hour+i*30))}});
 }});
 return {feed,requests,setClose:value=>{liveClose=value;}};
}
test('a recent screen is yielded before older hour files are even requested, with live overlap authoritative',async()=>{
 const {feed,requests}=rollingFeed(),stream=feed.stream('EURUSD',null,{timeframe:300});
 const first=(await stream.next()).value;
 assert.equal(first.historyComplete,false);assert.ok(requests.length<10);
 assert.ok(aggregateBars(first.candles,300,{baseTimeframe:30,now:NOW/1000}).length>=40);
 assert.equal(first.candles.at(-1).close,1.2);
 let last=first;for await(const update of stream)last=update;
 assert.equal(last.historyComplete,true);assert.equal(last.candles.length,72*120);
 assert.equal(last.candles.at(-1).close,1.2);assert.equal(requests.length,73);
 const count=requests.length;await feed.load('EURUSD',last);assert.equal(requests.length,count);
});
test('aborted background loads stop requesting files and incomplete history can resume from cache',async()=>{
 const {feed,requests}=rollingFeed(),controller=new AbortController(),stream=feed.stream('EURUSD',null,{signal:controller.signal});
 const first=(await stream.next()).value,count=requests.length;controller.abort();
 await assert.rejects(stream.next(),{name:'AbortError'});assert.equal(requests.length,count);
 const result=await feed.load('EURUSD',first);assert.equal(result.historyComplete,true);assert.equal(result.candles.length,72*120);
 assert.equal(requests.length,73); // Already fetched hours were reused.
});
test('live polls do not restart or wait for an active older-history download',async()=>{
 const {feed,requests}=rollingFeed(),stream=feed.stream('EURUSD');
 const first=(await stream.next()).value,count=requests.length;
 const update=await feed.load('EURUSD',first,{recentOnly:true});
 assert.equal(requests.length,count);assert.equal(update.historyComplete,false);
 await stream.return();
});
test('higher timeframes start with one raw hour so their native archive is not blocked by raw history',async()=>{
 const {feed,requests}=rollingFeed(),stream=feed.stream('EURUSD',null,{timeframe:86400});
 const first=(await stream.next()).value;assert.equal(requests.length,2);assert.equal(first.candles.length,120);await stream.return();
});
test('native archives stream newest parts first and cancel before fetching older parts',async()=>{
 const requests=[],controller=new AbortController();
 const feed=new CdnFeed({url:'https://data.example/',locks:null,now:()=>NOW,fetchImpl:async url=>{
  const path=new URL(url).pathname;requests.push(path);
  if(path.endsWith('manifest.json'))return Response.json({version:2,symbol:'EURUSD',through:NOW/1000,series:{86400:['2024','2026','2025']}});
  const part=path.split('/').at(-1).slice(0,4),time=Date.parse(part+'-01-01T00:00:00Z')/1000;
  return Response.json({version:2,symbol:'EURUSD',baseTimeframe:86400,part,candles:[[time,1,1.5,.5,1.1,10]]});
 }});
 const stream=feed.historyStream('EURUSD',86400,{signal:controller.signal}),first=(await stream.next()).value;
 assert.equal(first.candles[0].time,Date.parse('2026-01-01T00:00:00Z')/1000);assert.equal(requests.length,2);
 controller.abort();await assert.rejects(stream.next(),{name:'AbortError'});assert.equal(requests.length,2);
 const all=await feed.history('EURUSD',86400);assert.equal(all.candles.length,3);assert.equal(requests.length,4);
});
test('archived bars merge from versioned parts and corrected revisions replace stale local cache',async()=>{
 const requests=[],cache=new Map();let revision=1,clock=NOW;
 const feed=new CdnFeed({url:'https://data.example/',locks:null,now:()=>clock,readCache:async k=>cache.get(k),writeCache:async(k,v)=>cache.set(k,v),fetchImpl:async(url,options)=>{
  const u=new URL(url);requests.push(u);assert.equal(options.credentials,'omit');
  if(u.pathname.endsWith('manifest.json'))return Response.json({version:2,symbol:'EURUSD',through:NOW/1000,series:{86400:['2026']},partRevisions:{'86400:2026':revision}});
  assert.equal(u.searchParams.get('v'),String(revision));return Response.json({version:2,symbol:'EURUSD',baseTimeframe:86400,part:'2026',revision,candles:[[before,1,1.3,.9,revision===1?1.1:1.2,100]]});
 }});
 let data=await feed.history('EURUSD',86400);assert.equal(data.candles[0].close,1.1);assert.equal(requests.length,2);
 await feed.history('EURUSD',86400);assert.equal(requests.length,2);
 clock+=61000;revision=2;data=await feed.history('EURUSD',86400);assert.equal(data.candles[0].close,1.2);assert.equal(requests.length,4);
 assert.equal(await feed.history('EURUSD',300),null);assert.equal(requests.length,4);
});
