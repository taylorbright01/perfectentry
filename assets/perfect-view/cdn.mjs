import {parseFeedResponse} from './feed.mjs';
import {groupFor,hourOf,liveKey,hourKey} from './protocol.mjs';
export function nextCdnCheck(now,seconds=30) {
 const period=seconds*1000,phase=5000;
 return Math.max(250,(Math.floor((now-phase)/period)+1)*period+phase-now);
}
export class CdnFeed {
 constructor({url,fetchImpl=fetch,readCache=async()=>null,writeCache=async()=>{},now=()=>Date.now(),locks=globalThis.navigator?.locks}) {
  Object.assign(this,{url,fetchImpl,readCache,writeCache,now,locks});
  this.memory=new Map();
 }
 async cached(key,ttl,action) {
  const run=async()=>{
   let cached=this.memory.get(key);
   if (!cached || this.now()-cached.savedAt>=ttl) try {
    const shared=await this.readCache(key);
    if(shared && (!cached || shared.savedAt>cached.savedAt))cached=shared;
   } catch {}
   if(cached && cached.savedAt<=this.now() && this.now()-cached.savedAt<ttl) return cached.value;
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
 async load(symbol,previous=null,{signal}={}) {
  const group=groupFor(symbol);if(group<0)throw new Error('Unsupported market.');
  const prefix='cdn:'+new URL(this.url).href+':';
  const frame=await this.cached(prefix+'live:'+group,2000,()=>this.file(liveKey(group),signal));
  this.validateFile(frame,group);
  const source=frame.streams[symbol],now=Math.floor(this.now()/1000);
  if(!Number.isSafeInteger(frame.revision) || !Number.isSafeInteger(frame.updatedAt) || frame.updatedAt>now+10 || !source || !Array.isArray(source.candles) || source.candles.length>4 || !Number.isSafeInteger(source.through) || source.through%30 || source.through>now+10)throw new Error('No completed candles have arrived for this market yet.');
  const rows=[...source.candles];
  const last=previous?.candles.at(-1)?.time;
  const needsHistory=last===undefined || (rows.length && rows[0][0]>last+30);
  if(needsHistory && source.firstHour!==undefined) {
   if(!Number.isSafeInteger(source.firstHour) || source.firstHour%3600 || !Number.isSafeInteger(source.lastHour) || source.lastHour%3600 || source.lastHour>hourOf(now) || source.firstHour>source.lastHour)throw new Error('Invalid history range.');
   const from=Math.max(source.firstHour,source.lastHour-71*3600,last===undefined?0:hourOf(last));
   const hours=[];for(let hour=from;hour<=source.lastHour;hour+=3600)hours.push(hour);
   for(let offset=0;offset<hours.length;offset+=4) {
    const files=await Promise.all(hours.slice(offset,offset+4).map(async hour=>{
     const ttl=hour<hourOf(now)-3600 ? 3600000 : 2000;
     const file=await this.cached(prefix+`hour:${group}:${hour}`,ttl,()=>this.file(hourKey(group,hour),signal,true));
     if(!file)return [];
     this.validateFile(file,group);
     if(file.hour!==hour)throw new Error('Different history hour returned.');
     const candles=file.streams[symbol] ?? [];
     if(!Array.isArray(candles) || candles.length>120 || candles.some(b=>!Array.isArray(b) || b[0]<hour || b[0]>=hour+3600))throw new Error('Invalid history candles.');
     return candles;
    }));
    rows.unshift(...files.flat());
   }
  }
  const unique=new Map();
  for(const row of rows) {
   if(!Array.isArray(row) || row.length!==7 || !Number.isSafeInteger(row[0]) || row[0]%30 || row[0]+30>source.through || ![0,1].includes(row[6]))throw new Error('Invalid or unfinished candle.');
   if(row[6] && (row[5]!==0 || !row.slice(1,5).every(v=>v===row[1])))throw new Error('Invalid empty candle.');
   unique.set(row[0],{time:row[0],open:row[1],high:row[2],low:row[3],close:row[4],volume:row[5],empty:!!row[6]});
  }
  const data=parseFeedResponse(JSON.stringify({symbol,baseTimeframe:30,
   candles:[...unique.values()].sort((a,b)=>a.time-b.time),
   meta:{brokerSymbol:source.brokerSymbol,collectedThrough:source.through,receivedAt:frame.updatedAt,revision:frame.revision}
  }),symbol,30,previous);
  return data;
 }
}
