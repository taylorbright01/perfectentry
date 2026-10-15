import test from 'node:test';import assert from 'node:assert/strict';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {SYMBOLS} from '../../cloudflare/collector/worker/batch.mjs';
test('upgraded collector preserves batched ingestion, auto archives completed hours and accepts historical backfill',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../../cloudflare/collector/worker/index.mjs',import.meta.url))],bundle:true,format:'esm',write:false});const token='test-token-collector-not-a-production-secret';
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',bindings:{PERFECT_VIEW_COLLECTOR_TOKEN:token},r2Buckets:['CANDLES'],durableObjects:{COLLECTOR:{className:'PerfectViewCollector',useSQLite:true}}}));
 try{
  const end=Math.floor(Date.now()/3600000)*3600,start=end-3600;
  const post=(path,body)=>mf.dispatchFetch('https://test'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Perfect-View-Token':token},body:JSON.stringify(body)});
  for(let half=0;half<2;half++){
   const batch={version:1,base_timeframe:30,collector_id:'perfect_view_mt5',batch_id:'runtime-'+half,streams:SYMBOLS.map(symbol=>({symbol,broker_symbol:symbol,through:start+(half+1)*1800,candles:Array.from({length:60},(_,i)=>({time:start+half*1800+i*30,open:1,high:1.2,low:.9,close:1.1,volume:1,empty:false}))}))};
   const r=await post('/ingest',batch);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).accepted,true);
  }
  const bucket=await mf.getR2Bucket('CANDLES');const manifest=await (await bucket.get('pv/v2/archive/EURUSD/manifest.json')).json();assert.equal(manifest.through,end);
  assert.equal(manifest.retentionBars,100000);assert.equal(manifest.series[60].length,1);
  const minute=await (await bucket.get(`pv/v2/archive/EURUSD/60/${manifest.series[60][0]}.json`)).json();assert.equal(minute.candles.length,60);assert.deepEqual(minute.candles[0],[start,1,1.2,.9,1.1,2]);
  const health=await (await mf.dispatchFetch('https://test/health')).json();assert.equal(health.historyVersion,3);assert.equal(health.retentionBars,100000);
  const month=new Date(start*1000).toISOString().slice(0,7);const history=await (await bucket.get(`pv/v2/archive/EURUSD/3600/${month}.json`)).json();assert.deepEqual(history.candles,[[start,1,1.2,.9,1.1,120]]);
  const from=end-48*3600;const older={version:2,base_timeframe:3600,batch_id:'runtime-archive',streams:[{symbol:'EURUSD',from,through:from+24*3600,candles:Array.from({length:24},(_,i)=>[from+i*3600,1,1.2,.9,1.1,100])}]};
  const response=await post('/history',older);assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).accepted,true);
  assert.equal((await post('/history',older)).status,200);assert.ok(await bucket.get('pv/v1/live/g1.json'));
 }finally{await mf.dispose();}
});
