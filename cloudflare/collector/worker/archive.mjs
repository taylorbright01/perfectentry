import {SYMBOLS} from './batch.mjs';
const hour=3600,day=86400;
const part=t=>new Date(t*1000).toISOString().slice(0,7);
const year=t=>new Date(t*1000).getUTCFullYear();
const merge=(old,next)=>[...new Map([...old,...next].map(row=>[row[0],row])).values()].sort((a,b)=>a[0]-b[0]);
const objectKey=file=>`pv/v2/archive/${file.symbol}/${file.baseTimeframe}/${file.part}.json`;
const stateKey=(s,tf,p)=>`archive:${s}:${tf}:${p}`;
export function validateArchive(raw,now=Math.floor(Date.now()/1000)){
 if(raw?.version!==2||raw.base_timeframe!==3600||!/^[A-Za-z0-9_-]{1,120}$/.test(raw.batch_id??'')||!Array.isArray(raw.streams)||!raw.streams.length||raw.streams.length>29)throw Error('Invalid history batch');
 const seen=new Set();let count=0;
 const streams=raw.streams.map(s=>{
  if(!SYMBOLS.includes(s.symbol)||seen.has(s.symbol)||!Number.isSafeInteger(s.from)||s.from%3600||!Number.isSafeInteger(s.through)||s.through%3600||s.through>now||s.from<now-8*366*day||s.from>=s.through||s.through-s.from>200*hour||!Array.isArray(s.candles)||s.candles.length>200)throw Error('Invalid history stream');seen.add(s.symbol);
  let last=-1;const candles=s.candles.map(row=>{
   if(!Array.isArray(row)||row.length!==6||!Number.isSafeInteger(row[0])||row[0]%hour||row[0]<s.from||row[0]+hour>s.through||row[0]<=last||!row.slice(1,5).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)||row[2]<Math.max(row[1],row[4])||row[3]>Math.min(row[1],row[4])||row[2]<row[3]||!Number.isSafeInteger(row[5])||row[5]<0)throw Error('Invalid closed hourly candle');last=row[0];count++;return row;
  });return {symbol:s.symbol,from:s.from,through:s.through,candles};
 });if(count>3000)throw Error('History batch too large');return {version:2,base_timeframe:3600,batch_id:raw.batch_id,streams};
}
export class Archive {
 constructor(storage,bucket,now=()=>Math.floor(Date.now()/1000)){Object.assign(this,{storage,bucket,now});}
 async flush(){
  const pending=await this.storage.get('archive-pending');if(!pending)return;
  for(let at=0;at<pending.keys.length;at+=4)await Promise.all(pending.keys.slice(at,at+4).map(async key=>{const f=await this.storage.get(key);await this.bucket.put(objectKey(f),JSON.stringify(f),{httpMetadata:{contentType:'application/json',cacheControl:'public,max-age=60,s-maxage=60'}});}));
  for(let at=0;at<pending.symbols.length;at+=4)await Promise.all(pending.symbols.slice(at,at+4).map(async symbol=>{const manifest=await this.storage.get('archive-manifest:'+symbol);await this.bucket.put(`pv/v2/archive/${symbol}/manifest.json`,JSON.stringify(manifest),{httpMetadata:{contentType:'application/json',cacheControl:'public,max-age=30,s-maxage=30'}});}));
  await this.storage.delete('archive-pending');
 }
 async collectClosedHours() {
  const meta=await this.storage.get('meta');if(!meta)return;
  const streams=[],progress=[];
  for(const [symbol,state] of Object.entries(meta.streams)) {
   if(state.firstHour===undefined)continue;
   const key='archive-progress:'+symbol,from=Math.max(await this.storage.get(key)??state.firstHour,state.firstHour);
   const through=Math.min(Math.floor(state.through/3600)*3600,from+2*3600);if(through<=from)continue;
   for(let t=from;t<through;t+=3600){
    const group=SYMBOLS.indexOf(symbol)<8?0:SYMBOLS.indexOf(symbol)<16?1:SYMBOLS.indexOf(symbol)<24?2:3;
    const file=await this.storage.get(`h:${String(t).padStart(12,'0')}:${group}`),rows=file?.streams?.[symbol]??[];
    if(rows.length&&!(rows.length===120&&rows.every((r,i)=>r[0]===t+i*30)))continue;
    const candles=rows.length?[[t,rows[0][1],Math.max(...rows.map(r=>r[2])),Math.min(...rows.map(r=>r[3])),rows.at(-1)[4],rows.reduce((n,r)=>n+r[5],0)]]:[];
    streams.push({symbol,from:t,through:t+3600,candles});
   }
   progress.push([key,through]);
  }
  // One stream per symbol per request; group consecutive work into two batches.
  for(let i=0;i<2;i++){
   const used=new Set(),chunk=streams.filter(s=>{if(used.has(s.symbol))return false;used.add(s.symbol);return true;});if(!chunk.length)break;
   const batch={version:2,base_timeframe:3600,batch_id:'auto-'+meta.revision+'-'+i,streams:chunk};await this.ingest(batch);
   for(const stream of chunk)streams.splice(streams.indexOf(stream),1);
  }
  await this.storage.transaction(async tx=>{for(const [key,value] of progress)await tx.put(key,value);});
 }
 async ingest(raw){
  await this.flush();const batch=validateArchive(raw,this.now()),batchHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(batch)));
  const hash=[...new Uint8Array(batchHash)].join('-'),receipt='archive-receipt:'+batch.batch_id,prior=await this.storage.get(receipt);
  if(prior){if(prior.hash!==hash)throw Error('Reused history batch ID');return {accepted:true,batch_id:batch.batch_id,duplicate:true};}
  const changed=new Map(),manifests=new Map();
  const load=async(s,tf,p)=>{const key=stateKey(s,tf,p);if(!changed.has(key))changed.set(key,await this.storage.get(key)??{version:2,symbol:s,baseTimeframe:tf,part:p,candles:[]});return changed.get(key);};
  for(const stream of batch.streams){
   const s=stream.symbol,manifest=await this.storage.get('archive-manifest:'+s)??{version:2,symbol:s,series:{3600:[],86400:[]},revision:0};
   // Explicit coverage allows weekend/session gaps without inventing hourly bars.
   // A completed day is rebuilt from the full stored hourly month, not a partial chunk.
   const ranges=[...(manifest.coverage??[]),[stream.from,stream.through]].sort((a,b)=>a[0]-b[0]);
   manifest.coverage=[];for(const range of ranges){const last=manifest.coverage.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else manifest.coverage.push([...range]);}
   if(manifest.coverage.length>2000)throw Error('History has too many uncovered gaps');
   const months=new Set(stream.candles.map(r=>part(r[0])));
   // Also finalize a day when the coverage ends at midnight without a new quote.
   for(let t=stream.from;t<stream.through;t+=day)months.add(part(t));months.add(part(stream.through-1));
   for(const month of months){
    const file=await load(s,3600,month);file.candles=merge(file.candles,stream.candles.filter(r=>part(r[0])===month));
    manifest.series[3600]=[...new Set([...manifest.series[3600],month])].sort();
    const days=new Map();for(const row of file.candles){const start=Math.floor(row[0]/day)*day;if(start+day>Math.max(stream.through,manifest.through??0)||!manifest.coverage.some(([from,to])=>from<=start&&to>=start+day))continue;const rows=days.get(start)??[];rows.push(row);days.set(start,rows);}
    for(const [start,rows] of days){
     // Skip an import's first partial UTC day. A later complete source can fill it.
     if(!manifest.coverage.some(([from,to])=>from<=start&&to>=start+day))continue;
     const daily=await load(s,86400,String(year(start))),bar=[start,rows[0][1],Math.max(...rows.map(r=>r[2])),Math.min(...rows.map(r=>r[3])),rows.at(-1)[4],rows.reduce((n,r)=>n+r[5],0)];daily.candles=merge(daily.candles,[bar]);
     manifest.series[86400]=[...new Set([...manifest.series[86400],String(year(start))])].sort();
    }
   }
   manifest.partRevisions ??= {};
   for(const [key,file] of changed){if(file.symbol!==s)continue;file.revision=(file.revision??0)+1;manifest.partRevisions[file.baseTimeframe+':'+file.part]=file.revision;}
   manifest.coveredFrom=Math.min(manifest.coveredFrom??stream.from,stream.from);manifest.through=Math.max(manifest.through??0,stream.through);manifest.revision++;manifest.updatedAt=this.now();manifests.set(s,manifest);
  }
  await this.storage.transaction(async tx=>{for(const [k,v] of changed)await tx.put(k,v);for(const [s,m] of manifests)await tx.put('archive-manifest:'+s,m);await tx.put(receipt,{hash,createdAt:this.now()});await tx.put('archive-pending',{keys:[...changed.keys()],symbols:[...manifests.keys()]});});
  await this.flush();return {accepted:true,batch_id:batch.batch_id,duplicate:false};
 }
}
