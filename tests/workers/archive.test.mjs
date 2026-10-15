import test from 'node:test';import assert from 'node:assert/strict';import {Archive,validateArchive} from '../../cloudflare/collector/worker/archive.mjs';
const DAY=86400,NOW=Date.parse('2026-10-15T12:00:00Z')/1000,START=Date.parse('2026-10-01T00:00:00Z')/1000;
class Storage{constructor(){this.data=new Map();}async get(k){return structuredClone(this.data.get(k));}async put(k,v){this.data.set(k,structuredClone(v));}async delete(k){this.data.delete(k);}async transaction(fn){const copy=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=copy;throw e;}}}
class Bucket{constructor(){this.data=new Map();this.calls=0;this.fail=false;}async put(k,v){if(this.fail&&k.endsWith('manifest.json'))throw Error('network outage');this.data.set(k,JSON.parse(v));this.calls++;}}
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
