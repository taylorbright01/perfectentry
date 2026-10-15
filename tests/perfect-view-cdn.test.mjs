import test from 'node:test';import assert from 'node:assert/strict';import {CdnFeed} from '../assets/perfect-view/cdn.mjs';
const NOW=Date.parse('2026-10-15T12:00:00Z'),before=Math.floor(NOW/86400000)*86400-3*86400;
test('browser-native fetch keeps its required global receiver',async()=>{
 const native=globalThis.fetch;let called=false;globalThis.fetch=async function(){assert.equal(this,globalThis);called=true;return new Response('{}');};
 try{const feed=new CdnFeed({url:'https://data.example/',locks:null});await feed.file('example.json');assert.equal(called,true);}finally{globalThis.fetch=native;}
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
