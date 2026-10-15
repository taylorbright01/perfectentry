import {parseFeedResponse} from './feed.mjs';
import {GROUPS,groupFor,hourOf,liveKey,hourKey} from './protocol.mjs';
import {FxBook,currencyPaths} from './fx.mjs';
export function nextCdnCheck(now,seconds=30) {
 const period=seconds*1000,phase=5000;
 return Math.max(250,(Math.floor((now-phase)/period)+1)*period+phase-now);
}
export class CdnFeed {
 constructor({url,fetchImpl=globalThis.fetch.bind(globalThis),readCache=async()=>null,writeCache=async()=>{},now=()=>Date.now(),locks=globalThis.navigator?.locks}) {
  Object.assign(this,{url,fetchImpl,readCache,writeCache,now,locks});
  this.memory=new Map();
  this.fxBook=new FxBook();this.liveInflight=new Map();this.fxInflight=new Map();this.fxFailures=new Map();
 }
 async cached(key,ttl,action,revision) {
  const run=async()=>{
   let cached=this.memory.get(key);
   if (!cached || this.now()-cached.savedAt>=ttl || (revision!==undefined && cached.value?.revision!==revision)) try {
    const shared=await this.readCache(key);
    if(shared && (!cached || shared.savedAt>cached.savedAt || (revision!==undefined && shared.value?.revision===revision)))cached=shared;
   } catch {}
   if(cached && cached.savedAt<=this.now() && this.now()-cached.savedAt<ttl && (revision===undefined || cached.value?.revision===revision)) return cached.value;
   const value=await action(),record={savedAt:this.now(),value};
   if(this.memory.size>=400)this.memory.delete(this.memory.keys().next().value);
   this.memory.set(key,record);
   try {await this.writeCache(key,record);} catch {} // Downloads still work with storage disabled.
   return value;
  };
  // Same-origin tabs share short-lived downloads via IndexedDB under one lock.
  return this.locks ? this.locks.request(key,run) : run();
 }
 async file(path,signal,missingOkay=false) {
  const url=new URL(path,this.url.endsWith('/')?this.url:this.url+'/');
  const response=await this.fetchImpl(url,{credentials:'omit',cache:'default',signal});
  if(response.status===404 && missingOkay)return null;
  if(!response.ok)throw new Error('The candle files are unavailable. Existing data may be stale.');
  const text=await response.text();
  if(text.length>512*1024)throw new Error('Candle file is too large.');
  return JSON.parse(text);
 }
 validateFile(file,group) {
  if(!file || file.version!==1 || file.baseTimeframe!==30 || file.group!==group || !file.streams || typeof file.streams!=='object')throw new Error('Invalid candle file.');
 }
 async live(group,{signal}={}){
  if(this.liveInflight.has(group))return this.liveInflight.get(group);
  const run=(async()=>{
    const prefix='cdn:'+new URL(this.url).href+':';
    const frame=await this.cached(prefix+'live:'+group,2000,()=>this.file(liveKey(group),signal));
    this.validateFile(frame,group);
    // Only instruments belonging to this group may contribute conversion quotes.
    this.fxBook.ingestFrame({...frame,streams:Object.fromEntries(Object.entries(frame.streams).filter(([symbol])=>GROUPS[group]?.includes(symbol)))},group,this.now()/1000);
    return frame;
  })();
  this.liveInflight.set(group,run);try{return await run;}finally{this.liveInflight.delete(group);}
 }
 async conversionRate(from,to,{signal,refresh=false}={}){
  const existing=this.fxBook.resolve(from,to,{now:this.now()/1000}),key=from+':'+to;
  if(existing&&(!refresh||existing.age<=60))return existing;
  if(this.fxInflight.has(key))return this.fxInflight.get(key);
  const failed=this.fxFailures.get(key);if(failed!==undefined&&this.now()-failed<300000){if(existing)return existing;throw new Error('Conversion feed unavailable. Waiting for fresh ticker closes.');}
  const run=(async()=>{
    const candidates=currencyPaths(from,to,GROUPS.flat(),2),requested=new Set();
    candidates.sort((a,b)=>{
      const cost=p=>new Set(p.symbols.filter(s=>{const q=this.fxBook.quotes.get(s);return !q||this.now()/1000-q.asOf>60;}).map(groupFor)).size;
      return cost(a)-cost(b)||a.symbols.length-b.symbols.length;
    });
    for(const path of candidates){
      const groups=[...new Set(path.symbols.map(groupFor))];
      for(const group of groups){
        if(requested.has(group)||requested.size>=3)continue;
        requested.add(group);try{await this.live(group,{signal});}catch{}
        const result=this.fxBook.resolve(from,to,{now:this.now()/1000});
        if(result&&result.age<=60){this.fxFailures.delete(key);return result;}
      }
      if(requested.size>=3)break;
    }
    const result=this.fxBook.resolve(from,to,{now:this.now()/1000});
    if(result){this.fxFailures.delete(key);return result;}
    this.fxFailures.set(key,this.now());throw new Error('Conversion feed unavailable. Waiting for fresh ticker closes.');
  })();
  this.fxInflight.set(key,run);try{return await run;}finally{this.fxInflight.delete(key);}
 }
 async load(symbol,previous=null,options={}) {
  let data;for await(const update of this.stream(symbol,previous,options))data=update;
  return data;
 }
 async *stream(symbol,previous=null,{signal,timeframe=300,recentOnly=false,maxHours=72,before=Infinity}={}) {
  const group=groupFor(symbol);if(group<0)throw new Error('Unsupported market.');
  const prefix='cdn:'+new URL(this.url).href+':';
  signal?.throwIfAborted();
  const frame=await this.live(group,{signal});
  signal?.throwIfAborted();
  this.validateFile(frame,group);
  const source=frame.streams[symbol],now=Math.floor(this.now()/1000);
  if(!Number.isSafeInteger(frame.revision) || !Number.isSafeInteger(frame.updatedAt) || frame.updatedAt>now+10 || !source || !Array.isArray(source.candles) || source.candles.length>4 || !Number.isSafeInteger(source.through) || source.through%30 || source.through>now+10)throw new Error('No completed candles have arrived for this market yet.');
  const liveRows=[...source.candles],rows=[];
  const normalize=(historyComplete=false)=>{
   const unique=new Map();
   // Live rows win over older hour files when the publisher corrects an overlap.
   for(const row of [...rows,...liveRows]) {
    if(!Array.isArray(row) || row.length!==7 || !Number.isSafeInteger(row[0]) || row[0]%30 || row[0]+30>source.through || ![0,1].includes(row[6]))throw new Error('Invalid or unfinished candle.');
    if(row[6] && (row[5]!==0 || !row.slice(1,5).every(v=>v===row[1])))throw new Error('Invalid empty candle.');
    unique.set(row[0],{time:row[0],open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],empty:!!row[6]});
   }
   const data=parseFeedResponse(JSON.stringify({symbol,baseTimeframe:30,
    candles:[...unique.values()].sort((a,b)=>a.time-b.time),
    meta:{brokerSymbol:source.brokerSymbol,collectedThrough:source.through,receivedAt:frame.updatedAt,revision:frame.revision}
   }),symbol,30,previous);
   return {...data,historyComplete};
  };
  const last=previous?.candles.at(-1)?.time;
  const needsHistory=Number.isFinite(before)||last===undefined || previous?.historyComplete===false || (liveRows.length && liveRows[0][0]>last+30);
  if(recentOnly || !needsHistory || source.firstHour===undefined){yield normalize(previous?.historyComplete!==false);return;}
  if(!Number.isSafeInteger(source.firstHour) || source.firstHour%3600 || !Number.isSafeInteger(source.lastHour) || source.lastHour%3600 || source.lastHour>hourOf(now) || source.firstHour>source.lastHour)throw new Error('Invalid history range.');
  const end=Number.isFinite(before)?Math.min(source.lastHour,hourOf(before-1)):source.lastHour;
  const from=Math.max(source.firstHour,end-(Math.max(1,Math.min(72,maxHours))-1)*3600,Number.isFinite(before)||last===undefined||previous?.historyComplete===false?0:hourOf(last));
  const hours=[];for(let hour=end;hour>=from;hour-=3600)hours.push(hour);
  // For intraday charts fetch approximately one screen first. Higher timeframes
  // start their native archives immediately instead of waiting for 72 raw hours.
  const firstBatch=timeframe>=3600?1:Math.min(12,Math.ceil(41*timeframe/3600)+1);
  let published=false;
  for(let offset=0;offset<hours.length;){
   signal?.throwIfAborted();
   const size=offset===0?firstBatch:4;
   const files=await Promise.all(hours.slice(offset,offset+size).map(async hour=>{
    const ttl=hour<hourOf(now)-3600 ? 3600000 : 2000;
    const file=await this.cached(prefix+`hour:${group}:${hour}`,ttl,()=>this.file(hourKey(group,hour),signal,true));
    signal?.throwIfAborted();
    if(!file)return [];
    this.validateFile(file,group);
    if(file.hour!==hour)throw new Error('Different history hour returned.');
    const candles=file.streams[symbol] ?? [];
    if(!Array.isArray(candles) || candles.length>120 || candles.some(b=>!Array.isArray(b) || b[0]<hour || b[0]>=hour+3600))throw new Error('Invalid history candles.');
    return candles;
   }));
   rows.push(...files.flat());offset+=size;
   if(rows.length||liveRows.length||previous?.candles.length){yield normalize(offset>=hours.length);published=true;}
   // Allow the first canvas paint and input events between background batches.
   await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(!published)yield normalize(true);
 }
}

// Only the selected market/timeframe downloads an archive. Old completed parts
// are shared through the same IndexedDB cache; live candles still use one group.
CdnFeed.prototype.history = async function(symbol,timeframe,options={}) {
 let data=null;for await(const update of this.historyStream(symbol,timeframe,options))data=update;
 return data;
};
CdnFeed.prototype.historyStream = async function*(symbol,timeframe,{signal}={}) {
 if(![3600,14400,86400].includes(timeframe))return;
 signal?.throwIfAborted();
 const base=timeframe===86400?86400:3600,prefix='cdn:'+new URL(this.url).href+':archive:'+symbol;
 const manifest=await this.cached(prefix+':manifest',60000,()=>this.file(`pv/v2/archive/${symbol}/manifest.json`,signal,true));
 signal?.throwIfAborted();
 if(!manifest)return;
 if(manifest.version!==2||manifest.symbol!==symbol||!manifest.series||!Number.isSafeInteger(manifest.through)||manifest.through>this.now()/1000+10)throw Error('Invalid history manifest.');
 const parts=[...new Set((manifest.series[base]??[]).filter(p=>base===3600?/^\d{4}-\d{2}$/.test(p):/^\d{4}$/.test(p)))].sort().slice(base===3600?-13:-6).reverse();
 const rows=[];
 // Newest month/year first; an older part never blocks the first screen.
 for(const part of parts){
  signal?.throwIfAborted();
  const revision=manifest.partRevisions?.[base+':'+part];
  const file=await this.cached(prefix+':'+base+':'+part,part===parts[0]?60000:7*86400000,()=>this.file(`pv/v2/archive/${symbol}/${base}/${part}.json${revision===undefined?'':'?v='+revision}`,signal,true),revision);
  signal?.throwIfAborted();
  if(!file)continue;
  if(file.version!==2||file.symbol!==symbol||file.baseTimeframe!==base||file.part!==part||!Array.isArray(file.candles)||file.candles.length>(base===3600?750:366))throw Error('Invalid historical candle file.');
  rows.push(...file.candles);
  if(!rows.length)continue;
  const unique=new Map();for(const r of rows){if(!Array.isArray(r)||r.length!==6||r[0]+base>this.now()/1000)throw Error('Unfinished historical candle.');unique.set(r[0],{time:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]});}
  yield parseFeedResponse(JSON.stringify({symbol,baseTimeframe:base,candles:[...unique.values()].sort((a,b)=>a.time-b.time)}),symbol,base);
  await new Promise(resolve=>setTimeout(resolve,0));
 }
};

// Demand-driven pagination: one small recent slice, then another only near the
// left edge. The manifest and previously downloaded parts share the local cache.
export const archiveBase=timeframe=>timeframe===30?null:timeframe<3600?60:timeframe===86400?86400:3600;
const partStart=(part,base)=>Date.parse(base===60?part+':00:00Z':base===3600?part+'-01T00:00:00Z':part+'-01-01T00:00:00Z')/1000;
CdnFeed.prototype.archivePage=async function(symbol,timeframe,{before=Infinity,target=40,signal}={}){
 const base=archiveBase(timeframe);if(!base||groupFor(symbol)<0)return {data:null,hasMore:false};
 signal?.throwIfAborted();
 const prefix='cdn:'+new URL(this.url).href+':archive:'+symbol;
 const manifest=await this.cached(prefix+':manifest',60000,()=>this.file(`pv/v2/archive/${symbol}/manifest.json`,signal,true));
 signal?.throwIfAborted();if(!manifest)return {data:null,hasMore:false};
 if(manifest.version!==2||manifest.symbol!==symbol||!manifest.series||!Number.isSafeInteger(manifest.through)||manifest.through>this.now()/1000+10)throw Error('Invalid history manifest.');
 const pattern=base===60?/^\d{4}-\d{2}-\d{2}T(00|06|12|18)$/:base===3600?/^\d{4}-\d{2}$/:/^\d{4}$/;
 const all=[...new Set((manifest.series[base]??[]).filter(p=>pattern.test(p)))].sort().reverse();
 const parts=all.filter(p=>partStart(p,base)<before),rows=[];
 const needed=Math.min(100000,Math.max(40,Math.ceil(target*timeframe/base))+timeframe/base);
 let cursor=before,read=0;
 for(const part of parts){
  signal?.throwIfAborted();const revision=manifest.partRevisions?.[base+':'+part];
  const file=await this.cached(prefix+':'+base+':'+part,part===all[0]?60000:7*86400000,()=>this.file(`pv/v2/archive/${symbol}/${base}/${part}.json${revision===undefined?'':'?v='+revision}`,signal,true),revision);
  signal?.throwIfAborted();cursor=partStart(part,base);read++;
  if(file){
   if(file.version!==2||file.symbol!==symbol||file.baseTimeframe!==base||file.part!==part||!Array.isArray(file.candles)||file.candles.length>(base===60?360:base===3600?750:366))throw Error('Invalid historical candle file.');
   for(const r of file.candles){if(!Array.isArray(r)||r.length!==6||!Number.isSafeInteger(r[0])||r[0]%base||r[0]<cursor||r[0]+base>this.now()/1000)throw Error('Unfinished historical candle.');const end=base===60?cursor+21600:base===3600?Date.UTC(Number(part.slice(0,4)),Number(part.slice(5,7)),1)/1000:Date.UTC(Number(part)+1,0,1)/1000;if(r[0]+base>end)throw Error('Historical candle is outside its shard.');if(r[0]<before)rows.push({time:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]});}
  }
  // Bound each interaction even when early parts are empty/missing. A further
  // scroll can request another page without blocking the current chart.
  if(rows.length>=needed||read>=4)break;
 }
 const data=rows.length?parseFeedResponse(JSON.stringify({symbol,baseTimeframe:base,candles:rows.sort((a,b)=>a.time-b.time)}),symbol,base):null;
 return {data,nextBefore:cursor,hasMore:parts.length>read};
};
