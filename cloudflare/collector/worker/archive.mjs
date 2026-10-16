import {SYMBOLS} from './batch.mjs';
export const ARCHIVE_BAR_LIMIT=100000;
const hour=3600,day=86400;
const minutePart=t=>new Date(Math.floor(t/21600)*21600*1000).toISOString().slice(0,13);
const part=t=>new Date(t*1000).toISOString().slice(0,7);
const year=t=>new Date(t*1000).getUTCFullYear();
const merge=(old,next)=>[...new Map([...old,...next].map(row=>[row[0],row])).values()].sort((a,b)=>a[0]-b[0]);
const objectKey=file=>`pv/v2/archive/${file.symbol}/${file.baseTimeframe}/${file.part}.json`;
const stateKey=(s,tf,p)=>`archive:${s}:${tf}:${p}`;
export function validateArchive(raw,now=Math.floor(Date.now()/1000)){
 if(raw?.version!==2||![60,3600].includes(raw.base_timeframe)||!/^[A-Za-z0-9_-]{1,120}$/.test(raw.batch_id??'')||!Array.isArray(raw.streams)||!raw.streams.length||raw.streams.length>29)throw Error('Invalid history batch');
 const step=raw.base_timeframe,seen=new Set();let count=0;
 const streams=raw.streams.map(s=>{
  if(!SYMBOLS.includes(s.symbol)||seen.has(s.symbol)||!Number.isSafeInteger(s.from)||s.from%step||!Number.isSafeInteger(s.through)||s.through%step||s.through>now||s.from<946684800||s.from>=s.through||s.through-s.from>200*step||!Array.isArray(s.candles)||s.candles.length>200)throw Error('Invalid history stream');seen.add(s.symbol);
  let last=-1;const candles=s.candles.map(row=>{
   if(!Array.isArray(row)||row.length!==6||!Number.isSafeInteger(row[0])||row[0]%step||row[0]<s.from||row[0]+step>s.through||row[0]<=last||!row.slice(1,5).every(v=>typeof v==='number'&&Number.isFinite(v)&&v>0)||row[2]<Math.max(row[1],row[4])||row[3]>Math.min(row[1],row[4])||row[2]<row[3]||!Number.isSafeInteger(row[5])||row[5]<0)throw Error('Invalid closed historical candle');last=row[0];count++;return row;
  });return {symbol:s.symbol,from:s.from,through:s.through,candles};
 });if(count>3000)throw Error('History batch too large');return {version:2,base_timeframe:step,batch_id:raw.batch_id,streams};
}
export class Archive {
 constructor(storage,bucket,now=()=>Math.floor(Date.now()/1000),limit=ARCHIVE_BAR_LIMIT){Object.assign(this,{storage,bucket,now,limit});}
 async flush(){
  const pending=await this.storage.get('archive-pending');if(!pending)return;
  for(let at=0;at<pending.keys.length;at+=4)await Promise.all(pending.keys.slice(at,at+4).map(async key=>{const f=await this.storage.get(key);await this.bucket.put(objectKey(f),JSON.stringify(f),{httpMetadata:{contentType:'application/json',cacheControl:'public,max-age=60,s-maxage=60'}});}));
  for(let at=0;at<pending.symbols.length;at+=4)await Promise.all(pending.symbols.slice(at,at+4).map(async symbol=>{const manifest=await this.storage.get('archive-manifest:'+symbol);await this.bucket.put(`pv/v2/archive/${symbol}/manifest.json`,JSON.stringify(manifest),{httpMetadata:{contentType:'application/json',cacheControl:'public,max-age=30,s-maxage=30'}});}));
  // Manifests stop advertising expired parts before their objects are removed.
  for(const key of pending.deletes??[])await this.bucket.delete(key);
  await this.storage.delete('archive-pending');
 }
 async collectClosedHours(maxSymbols=SYMBOLS.length,maxHours=2) {
  const meta=await this.storage.get('meta');if(!meta)return;
  const hourly=[],minutes=[],progress=[];
  for(const [symbol,state] of Object.entries(meta.streams)) {
   if(progress.length>=maxSymbols*2)break;
   if(state.firstHour===undefined)continue;
   const hourKey='archive-progress:'+symbol,minuteKey='archive-minute-progress:'+symbol;
   const hourFrom=Math.max(await this.storage.get(hourKey)??state.firstHour,state.firstHour);
   const minuteFrom=Math.max(await this.storage.get(minuteKey)??state.firstHour,state.firstHour);
   const from=Math.min(hourFrom,minuteFrom),through=Math.min(Math.floor(state.through/hour)*hour,from+maxHours*hour);
   if(through<=from)continue;
   for(let t=from;t<through;t+=hour){
    const group=SYMBOLS.indexOf(symbol)<8?0:SYMBOLS.indexOf(symbol)<16?1:SYMBOLS.indexOf(symbol)<24?2:3;
    const file=await this.storage.get(`h:${String(t).padStart(12,'0')}:${group}`),rows=file?.streams?.[symbol]??[];
    if(!file||!Array.isArray(file.streams?.[symbol]))continue; // Missing data is not a known closed session.
    if(t>=minuteFrom){
     const byTime=new Map(rows.map(r=>[r[0],r])),candles=[];
     for(let time=t;time<t+hour;time+=60){const a=byTime.get(time),b=byTime.get(time+30);if(a&&b){const quoted=[a,b].filter(r=>!r[6]);if(quoted.length)candles.push([time,quoted[0][1],Math.max(...quoted.map(r=>r[2])),Math.min(...quoted.map(r=>r[3])),quoted.at(-1)[4],quoted.reduce((n,r)=>n+r[5],0)]);}}
     minutes.push({symbol,from:t,through:t+hour,candles});
    }
    if(t<hourFrom||rows.length&&!(rows.length===120&&rows.every((r,i)=>r[0]===t+i*30)))continue;
    const quoted=rows.filter(r=>!r[6]);
    const candles=quoted.length?[[t,quoted[0][1],Math.max(...quoted.map(r=>r[2])),Math.min(...quoted.map(r=>r[3])),quoted.at(-1)[4],quoted.reduce((n,r)=>n+r[5],0)]]:[];
    hourly.push({symbol,from:t,through:t+hour,candles});
   }
   progress.push([hourKey,Math.max(hourFrom,through)],[minuteKey,Math.max(minuteFrom,through)]);
  }
  for(const [step,streams] of [[3600,hourly],[60,minutes]])for(let i=0;i<2;i++){
   const used=new Set(),chunk=streams.filter(s=>{if(used.has(s.symbol))return false;used.add(s.symbol);return true;});if(!chunk.length)break;
   // A retried live batch can drain another recovery window without changing
   // meta.revision. Identify the actual archive payload, not that live revision.
   const payload=JSON.stringify({base_timeframe:step,streams:chunk});
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
   const id=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
   await this.ingest({version:2,base_timeframe:step,batch_id:'auto-v2-'+step+'-'+id,streams:chunk});
   for(const stream of chunk)streams.splice(streams.indexOf(stream),1);
  }
  if(progress.length)await this.storage.transaction(async tx=>{for(const [key,value] of progress)await tx.put(key,value);});
  return progress.length>0;
 }
 // Count-based retention applies independently to every symbol and resolution.
 // Only the boundary shard is rewritten; entire older shards are removed.
 async retain(symbol,manifest,changed,deleted){
  manifest.counts??={};manifest.retentionBars=this.limit;
  for(const tf of [60,3600,86400]){
   const parts=manifest.series[tf]??=[];let total=0;
   for(const p of parts){const key=stateKey(symbol,tf,p),file=changed.get(key);if(file)manifest.counts[tf+':'+p]=file.candles.length;
    if(manifest.counts[tf+':'+p]===undefined)manifest.counts[tf+':'+p]=(await this.storage.get(key))?.candles.length??0;
    total+=manifest.counts[tf+':'+p];
   }
   while(total>this.limit&&parts.length){
    const p=parts[0],key=stateKey(symbol,tf,p),count=manifest.counts[tf+':'+p],excess=total-this.limit;
    const file=changed.get(key)??await this.storage.get(key);
    if(!file)throw Error('Retained history shard is missing');
    if(count<=excess){parts.shift();changed.delete(key);deleted.set(key,objectKey(file));delete manifest.counts[tf+':'+p];delete manifest.partRevisions[tf+':'+p];total-=count;}
    else{file.candles=file.candles.slice(excess);file.revision=(file.revision??0)+1;changed.set(key,file);manifest.counts[tf+':'+p]=file.candles.length;manifest.partRevisions[tf+':'+p]=file.revision;total-=excess;}
   }
   if(tf===3600&&parts.length){
    const key=stateKey(symbol,tf,parts[0]),first=(changed.get(key)??await this.storage.get(key))?.candles[0]?.[0];
    // An already derived D1 bar survives H1 expiry. Never rebuild that older
    // day later using only the tail of a pruned hourly boundary shard.
    if(first!==undefined)manifest.coverage=(manifest.coverage??[]).map(([a,b])=>[Math.max(a,first),b]).filter(([a,b])=>a<b);
   }
  }
 }

 async ingest(raw){
  await this.flush();const batch=validateArchive(raw,this.now()),batchHash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(batch)));
  const hash=[...new Uint8Array(batchHash)].join('-'),receipt='archive-receipt:'+batch.batch_id,prior=await this.storage.get(receipt);
  if(prior){if(prior.hash!==hash)throw Error('Reused history batch ID');return {accepted:true,batch_id:batch.batch_id,duplicate:true};}
  const changed=new Map(),manifests=new Map(),deleted=new Map();
  const load=async(s,tf,p)=>{const key=stateKey(s,tf,p);if(!changed.has(key))changed.set(key,await this.storage.get(key)??{version:2,symbol:s,baseTimeframe:tf,part:p,candles:[]});return changed.get(key);};
  for(const stream of batch.streams){
   const s=stream.symbol,manifest=await this.storage.get('archive-manifest:'+s)??{version:2,symbol:s,series:{60:[],3600:[],86400:[]},revision:0};
   manifest.series[60]??=[];
   if(batch.base_timeframe===60){
    for(const p of new Set(stream.candles.map(r=>minutePart(r[0])))){const file=await load(s,60,p);file.candles=merge(file.candles,stream.candles.filter(r=>minutePart(r[0])===p));manifest.series[60]=[...new Set([...manifest.series[60],p])].sort();}
   }else{
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
   }
   manifest.partRevisions ??= {};
   for(const [key,file] of changed){if(file.symbol!==s)continue;file.revision=(file.revision??0)+1;manifest.partRevisions[file.baseTimeframe+':'+file.part]=file.revision;}
   await this.retain(s,manifest,changed,deleted);
   manifest.coveredFrom=Math.min(manifest.coveredFrom??stream.from,stream.from);manifest.through=Math.max(manifest.through??0,stream.through);manifest.revision++;manifest.updatedAt=this.now();manifests.set(s,manifest);
  }
  await this.storage.transaction(async tx=>{for(const [k,v] of changed)await tx.put(k,v);for(const [s,m] of manifests)await tx.put('archive-manifest:'+s,m);await tx.put(receipt,{hash,createdAt:this.now()});for(const key of deleted.keys())await tx.delete(key);await tx.put('archive-pending',{keys:[...changed.keys()],symbols:[...manifests.keys()],deletes:[...deleted.values()]});});
  await this.flush();return {accepted:true,batch_id:batch.batch_id,duplicate:false};
 }
}
