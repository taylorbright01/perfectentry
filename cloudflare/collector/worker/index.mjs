import {validateBatch,readLimited} from './batch.mjs';
import {Archive,validateArchive} from './archive.mjs';
import {CollectorEngine} from './engine.mjs';
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
export class PerfectViewCollector {
 constructor(ctx,env) {
  this.ctx=ctx;this.engine=new CollectorEngine(ctx.storage,env.CANDLES);this.archive=new Archive(ctx.storage,env.CANDLES);
  this.queue=Promise.resolve();
 }
 serialize(action) {const result=this.queue.then(action);this.queue=result.catch(()=>{});return result;}
 async fetch(request) {
  return this.serialize(async()=>{
   let stage='decode';
   try {
    const {batch,hash}=await request.json();
    if(batch.version===2){stage='history-import';return reply(await this.archive.ingest(batch));}
    stage='live-ingest';
    const ack=await this.engine.ingest(batch,hash);
    // Acknowledge durable live publication before doing archive catch-up.
    // Keep an existing alarm so continuous ingestion cannot postpone it.
    stage='schedule-archive';
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(Date.now()+1000);
    return reply(ack);
   } catch(error) {
    console.error('Perfect View collector failure',stage,String(error?.message ?? error).slice(0,1000));
    await this.ctx.storage.setAlarm(Date.now()+60000);
    return reply({error:'Publication unavailable; retry the same batch'},503);
   }
  });
 }
 async alarm() {
  return this.serialize(async()=>{
   try {
    await this.engine.flush();await this.archive.flush();
    // One instrument/hour per alarm bounds recovery work and lets live requests run.
    if(await this.archive.collectClosedHours(1,1))await this.ctx.storage.setAlarm(Date.now()+1000);
   }
   catch(error) {console.error('Perfect View collector alarm failure',String(error?.message ?? error).slice(0,1000));await this.ctx.storage.setAlarm(Date.now()+60000);}
  });
 }
}
export default {
 async fetch(request,env) {
  const path=new URL(request.url).pathname;
  if (request.method==='GET' && path==='/health') return reply({service:'perfect-view-collector',version:1,historyVersion:3,retentionBars:100000});
  if (!['/ingest','/history'].includes(path)) return reply({error:'Not found'},404);
  if (request.method!=='POST') return reply({error:'POST required'},405);
  const token=env.PERFECT_VIEW_COLLECTOR_TOKEN;
  if(!token || token.length<32 || !env.CANDLES || !env.COLLECTOR) return reply({error:'Collector not configured'},503);
  if(request.headers.get('X-Perfect-View-Token')!==token) return reply({error:'Unauthorized'},401);
  let batch;
  try {const raw=await readLimited(request);batch=path==='/history'?validateArchive(raw):validateBatch(raw);} catch {return reply({error:'Invalid batch'},400);}
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(batch)));
  const hash=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  // One durable writer prevents overlapping requests/retries losing hour history.
  const object=env.COLLECTOR.get(env.COLLECTOR.idFromName('perfect-view-v1'));
  return object.fetch(new Request('https://collector.internal/ingest',{method:'POST',body:JSON.stringify({batch,hash})}));
 }
};
