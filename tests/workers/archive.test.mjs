import test from 'node:test';import assert from 'node:assert/strict';import {Archive,validateArchive} from '../../cloudflare/collector/worker/archive.mjs';
const DAY=86400,NOW=Date.parse('2026-10-15T12:00:00Z')/1000,START=Date.parse('2026-10-01T00:00:00Z')/1000;
class Storage{constructor(){this.data=new Map();}async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async delete(k){this.data.delete(k);}async transaction(fn){const copy=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=copy;throw e;}}}
class Bucket{constructor(){this.data=new Map();this.calls=0;this.fail=false;}async put(k,v){if(this.fail&&k.endsWith('manifest.json'))throw Error('network outage');this.data.set(k,JSON.parse(v));this.calls++;}async delete(k){if(this.failDelete)throw Error('delete outage');this.data.delete(k);}}
const batch=(id,from,through,skip=[])=>({version:2,base_timeframe:3600,batch_id:id,streams:[{symbol:'EURUSD',from,through,candles:Array.from({length:(through-from)/3600},(_,i)=>[from+i*3600,1+i*.001,1.01+i*.001,.99+i*.001,1.002+i*.001,100]).filter(r=>!skip.includes(r[0]))}]});
test('hourly archive builds correct completed UTC daily OHLC and never publishes a partial day',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW);
 await archive.ingest(batch('first',START,START+12*3600));assert.equal(bucket.data.has('pv/v2/archive/EURUSD/86400/2026.json'),false);
 const later=batch('second',START+12*3600,START+DAY);await archive.ingest(later);
 const hourly=bucket.data.get('pv/v2/archive/EURUSD/3600/2026-10.json').candles;
 const daily=bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json').candles;
 assert.equal(daily.length,1);assert.deepEqual(daily[0],[START,hourly[0][1],Math.max(...hourly.map(r=>r[2])),Math.min(...hourly.map(r=>r[3])),hourly.at(-1)[4],2400]);
 const calls=bucket.calls;assert.equal((await archive.ingest(later)).duplicate,true);assert.equal(bucket.calls,calls);
 const changed=structuredClone(later);changed.streams[0].candles[0][4]+=0.0001;await assert.rejects(archive.ingest(changed),/Reused/);
});
test('uncovered ranges cannot silently become complete daily candles',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW);
 await archive.ingest(batch('before',START,START+5*3600));await archive.ingest(batch('after',START+10*3600,START+DAY));assert.equal(bucket.data.has('pv/v2/archive/EURUSD/86400/2026.json'),false);
 await archive.ingest(batch('fill',START+5*3600,START+10*3600));
 // The completed coverage is known even if the corrective chunk ends within the day.
 // A subsequent completion checkpoint finalizes from the full canonical hour file.
 await archive.ingest(batch('checkpoint',START,START+DAY));assert.equal(bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json').candles.length,1);
});
test('publication failure is durable and a restart safely completes before duplicate acknowledgement',async()=>{
 const storage=new Storage(),bucket=new Bucket();bucket.fail=true;const b=batch('retry',START,START+DAY);
 await assert.rejects(new Archive(storage,bucket,()=>NOW).ingest(b));assert.ok(await storage.get('archive-pending'));
 bucket.fail=false;assert.equal((await new Archive(storage,bucket,()=>NOW).ingest(b)).duplicate,true);assert.equal(await storage.get('archive-pending'),undefined);assert.equal(bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json').candles.length,1);
});
test('history rejects unfinished, mislabelled and inconsistent hourly candles',()=>{
 const b=batch('invalid',START,START+3600);b.streams[0].candles[0][0]++;assert.throws(()=>validateArchive(b,NOW));
 assert.throws(()=>validateArchive(batch('future',NOW,NOW+3600),NOW));
});
const minuteBatch=(id,start,count)=>({version:2,base_timeframe:60,batch_id:id,streams:[{symbol:'EURUSD',from:start,through:start+count*60,candles:Array.from({length:count},(_,i)=>[start+i*60,1,1.2,.9,1.1,10])}]});
test('minute retention trims exactly the oldest bars and preserves independent H1 and daily series',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW,5);
 await archive.ingest(batch('hourly',START,START+24*3600));
 const daily=structuredClone(bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json'));
 await archive.ingest(minuteBatch('minute-old',START,4));
 await archive.ingest(minuteBatch('minute-next-shard',START+21600,4));
 const manifest=bucket.data.get('pv/v2/archive/EURUSD/manifest.json');assert.equal(manifest.retentionBars,5);
 const files=manifest.series[60].map(p=>bucket.data.get(`pv/v2/archive/EURUSD/60/${p}.json`));
 assert.equal(files.flatMap(f=>f.candles).length,5);assert.equal(files[0].candles.length,1);
 assert.equal(files[0].candles[0][0],START+3*60);assert.deepEqual(bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json'),daily);
 await archive.ingest(batch('next-hour',START+24*3600,START+25*3600));
 assert.deepEqual(bucket.data.get('pv/v2/archive/EURUSD/86400/2026.json').candles,daily.candles);
 assert.equal(manifest.series[3600].length,1);
});
test('expired shards are removed durably and an older retry cannot resurrect them',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW,3);
 const old=minuteBatch('old',START,3);await archive.ingest(old);
 bucket.failDelete=true;await assert.rejects(archive.ingest(minuteBatch('new',START+21600,3)),/delete outage/);
 const manifest=bucket.data.get('pv/v2/archive/EURUSD/manifest.json');assert.deepEqual(manifest.series[60],['2026-10-01T06']);
 assert.ok(await storage.get('archive-pending'));bucket.failDelete=false;
 assert.equal((await new Archive(storage,bucket,()=>NOW,3).ingest(old)).duplicate,true);
 assert.equal(bucket.data.has('pv/v2/archive/EURUSD/60/2026-10-01T00.json'),false);
 assert.equal(await storage.get('archive:EURUSD:60:2026-10-01T00'),undefined);
 await archive.ingest(minuteBatch('late-old-import',START,2));
 assert.equal(bucket.data.has('pv/v2/archive/EURUSD/60/2026-10-01T00.json'),false);
});
test('known no-quote intervals do not manufacture candles and a missing hour is not covered',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW);
 await storage.put('meta',{revision:1,streams:{EURUSD:{firstHour:START,through:START+7200}}});
 await storage.put(`h:${String(START).padStart(12,'0')}:1`,{streams:{EURUSD:Array.from({length:120},(_,i)=>[START+i*30,1,1,1,1,0,1])}});
 await archive.collectClosedHours();
 const manifest=bucket.data.get('pv/v2/archive/EURUSD/manifest.json');
 assert.deepEqual(manifest.series[60],[]);assert.deepEqual(manifest.coverage,[[START,START+3600]]);
 assert.ok(!bucket.data.has('pv/v2/archive/EURUSD/86400/2026.json'));
});
test('automatic archive drains successive recovery windows with an unchanged live revision',async()=>{
 const storage=new Storage(),bucket=new Bucket(),archive=new Archive(storage,bucket,()=>NOW);
 await storage.put('meta',{revision:29,streams:{EURUSD:{firstHour:START,through:START+4*3600}}});
 for(let h=0;h<4;h++){
  const t=START+h*3600;
  await storage.put(`h:${String(t).padStart(12,'0')}:1`,{streams:{EURUSD:Array.from({length:120},(_,i)=>[t+i*30,1,1.2,.9,1.1,1,0])}});
 }
 await archive.collectClosedHours();
 await archive.collectClosedHours();
 assert.equal(await storage.get('archive-progress:EURUSD'),START+4*3600);
 assert.equal(await storage.get('archive-minute-progress:EURUSD'),START+4*3600);
 assert.equal(bucket.data.get('pv/v2/archive/EURUSD/3600/2026-10.json').candles.length,4);
 assert.equal(bucket.data.get('pv/v2/archive/EURUSD/60/2026-10-01T00.json').candles.length,240);
 const calls=bucket.calls;await archive.collectClosedHours();assert.equal(bucket.calls,calls);
});
