import {GROUPS,groupFor,hourOf,rowOf,mergeRows,liveKey,hourKey} from './protocol.mjs';
const padding = value => String(value).padStart(12,'0');
const hourStore = (group,hour) => `h:${padding(hour)}:${group}`;
const receiptKey = (batch,now) => `r:${padding(Math.floor(now/86400))}:${batch.collector_id}:${batch.batch_id}`;
export class CollectorEngine {
 constructor(storage,bucket,now=()=>Math.floor(Date.now()/1000)) { Object.assign(this,{storage,bucket,now}); }
 async flush() {
  const pending = await this.storage.get('pending');
  if (!pending) return;
  // Publish history first. A live frame never advertises unacknowledged history.
  for (let offset=0;offset<pending.hours.length;offset+=4) {
   await Promise.all(pending.hours.slice(offset,offset+4).map(async key=>{
    const file = await this.storage.get(key);
    if (!file) throw new Error('Pending history missing');
    await this.bucket.put(hourKey(file.group,file.hour),JSON.stringify(file),{
     httpMetadata:{contentType:'application/json',cacheControl:'public, max-age=2, s-maxage=2'}
    });
   }));
  }
  await Promise.all(pending.frames.map(file=>this.bucket.put(liveKey(file.group),JSON.stringify(file),{
   httpMetadata:{contentType:'application/json',cacheControl:'public, max-age=2, s-maxage=2'}
  })));
  await this.storage.transaction(async tx=>{
   const receipt = await tx.get(pending.receipt);
   await tx.put(pending.receipt,{...receipt,published:true});
   await tx.delete('pending');
  });
 }
 async ingest(batch,hash) {
  // The caller serializes this method. Recover an earlier failed publication first.
  await this.flush();
  const now=this.now(),meta=await this.storage.get('meta') ?? {revision:0,streams:{}};
  if (meta.collector && meta.collector!==batch.collector_id) throw new Error('Different collector ID');
  const keys = Array.from({length:9},(_,n)=>receiptKey(batch,now-n*86400));
  const receipts=await this.storage.get(keys);
  for (const receipt of receipts.values()) {
   if (receipt.hash!==hash) throw new Error('Batch ID was reused with different candles');
   return {accepted:true,batch_id:batch.batch_id,duplicate:true};
  }
  const changed=new Map();
  for (const stream of batch.streams) {
   const group=groupFor(stream.symbol),old=meta.streams[stream.symbol] ?? {through:0,recent:[]};
   const rows=stream.candles.map(rowOf),recent=mergeRows(old.recent,rows).slice(-4);
   meta.streams[stream.symbol]={...old,brokerSymbol:stream.broker_symbol,
    through:Math.max(old.through,stream.through),recent};
   for (const row of rows) {
    const hour=hourOf(row[0]),key=hourStore(group,hour);
    let file=changed.get(key);
    if (!file) { file=await this.storage.get(key) ?? {version:1,baseTimeframe:30,group,hour,streams:{}};changed.set(key,file); }
    file.streams[stream.symbol]=mergeRows(file.streams[stream.symbol] ?? [],[row]);
    const data=meta.streams[stream.symbol];
    data.firstHour=Math.min(data.firstHour ?? hour,hour);
    data.lastHour=Math.max(data.lastHour ?? hour,hour);
   }
  }
  meta.collector=batch.collector_id;meta.revision++;meta.updatedAt=now;
  const cutoff=hourOf(now-4*86400);
  for (const data of Object.values(meta.streams)) if (data.firstHour!==undefined) {
   if(data.lastHour<cutoff) {delete data.firstHour;delete data.lastHour;}
   else data.firstHour=Math.max(data.firstHour,cutoff);
  }
  const frames=GROUPS.map((symbols,group)=>({version:1,baseTimeframe:30,group,revision:meta.revision,
   updatedAt:now,streams:Object.fromEntries(symbols.filter(s=>meta.streams[s]).map(symbol=>{
    const {recent,...other}=meta.streams[symbol];return [symbol,{...other,candles:recent}];
   }))}));
  const receipt=receiptKey(batch,now);
  await this.storage.transaction(async tx=>{
   for (const [key,file] of changed) await tx.put(key,file);
   await tx.put('meta',meta);
   await tx.put(receipt,{hash,published:false});
   await tx.put('pending',{receipt,hours:[...changed.keys()],frames});
  });
  await this.flush();
  if (meta.cleanupHour!==hourOf(now)) {
   // Bounded, time-indexed retention; never scan every candle or receipt.
   for (const options of [{prefix:'h:',end:`h:${padding(cutoff)}:`,limit:200},
    {prefix:'r:',end:`r:${padding(Math.floor(now/86400)-8)}:`,limit:4000}]) {
    const old=await this.storage.list(options);if(old.size)await this.storage.delete([...old.keys()]);
   }
   meta.cleanupHour=hourOf(now);await this.storage.put('meta',meta);
  }
  return {accepted:true,batch_id:batch.batch_id,duplicate:false,candles:batch.streams.reduce((n,s)=>n+s.candles.length,0)};
 }
}
