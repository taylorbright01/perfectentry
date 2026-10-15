import {IndicatorRegistry,indicators} from '../../assets/perfect-view/core.mjs';
import {validateLayout} from '../../assets/perfect-view/layouts.mjs';
const seconds=()=>Math.floor(Date.now()/1000);
const encoder=new TextEncoder();
const base64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const random=()=>base64(crypto.getRandomValues(new Uint8Array(32)));
export const digest=async value=>base64(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));
const validSecret=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{43}$/.test(s);
class Problem extends Error {constructor(status,message){super(message);this.status=status;}}
const fail=(status,message)=>{throw new Problem(status,message);};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
const origins=env=>(env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
const products=(env,scope)=>(env[scope==='signals'?'SIGNALS_PRODUCTS':'PERFECT_VIEW_PRODUCTS']??'').split(',').map(s=>s.trim()).filter(s=>/^prod_[a-zA-Z0-9]+$/.test(s)).slice(0,8);
const whopBase=env=>env.WHOP_SANDBOX==='true'?'https://sandbox-api.whop.com':'https://api.whop.com';
async function body(request,max=262144){const reader=request.body?.getReader();if(!reader)fail(400,'Missing body.');const chunks=[];let length=0;try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max)fail(413,'Request too large.');chunks.push(value);}}finally{reader.releaseLock();}const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}try{return JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'Invalid JSON.');}}
async function provider(env,path,options={}) {const response=await fetch(whopBase(env)+path,{...options,signal:AbortSignal.timeout(10000)});if(!response.ok)fail(503,'Whop is temporarily unavailable. Try again.');return response.json();}
async function session(request,env,checkAccess=true){
 const token=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization')??'')?.[1];if(!token)fail(401,'Sign in with Whop.');
 const hash=await digest(token),s=await env.ACCOUNTS.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').bind(hash,seconds()).first();if(!s)fail(401,'Your session expired. Sign in again.');
 if(!checkAccess)return s;
 if(!s.access_json||seconds()-s.checked_at>=300){
  const access={},checks=new Map();
  for(const scope of ['perfectView','signals']){
   const ids=products(env,scope);if(!ids.length)fail(503,'Membership products are not configured.');
   const results=await Promise.all(ids.map(id=>{if(!checks.has(id))checks.set(id,provider(env,`/api/v1/users/${encodeURIComponent(s.user_id)}/access/${encodeURIComponent(id)}`,{headers:{Authorization:'Bearer '+env.WHOP_COMPANY_API_KEY,'Api-Version-Date':'2026-10-13-1'}}));return checks.get(id);}));
   access[scope]=results.some(r=>r.has_access===true);
  }
  await env.ACCOUNTS.prepare('UPDATE sessions SET access_json=?,checked_at=? WHERE token_hash=?').bind(JSON.stringify(access),seconds(),hash).run();s.access=access;
 }else s.access=JSON.parse(s.access_json);
 return s;
}
async function requireAccess(request,env,scope='perfectView'){const s=await session(request,env);if(!s.access[scope])fail(403,'This Whop membership does not include access.');return s;}
function redirect(url,cookie){const headers={'Location':url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'};if(cookie)headers['Set-Cookie']=cookie;return new Response(null,{status:302,headers});}
async function login(request,env){
 const url=new URL(request.url),returnTo=url.searchParams.get('return_to'),challenge=url.searchParams.get('challenge');
 let target;try{target=new URL(returnTo);}catch{fail(400,'Invalid return address.');}
 if(target.username||target.password||!origins(env).includes(target.origin)||!['/perfect-view.html','/signals.html'].includes(target.pathname)||target.search||target.hash||!validSecret(challenge))fail(400,'Invalid login request.');
 const state=random(),verifier=random(),nonce=random();
 await env.ACCOUNTS.prepare('INSERT INTO oauth_flows VALUES(?,?,?,?,?,?)').bind(await digest(state),verifier,nonce,challenge,target.href,seconds()+600).run();
 const query=new URLSearchParams({response_type:'code',client_id:env.WHOP_CLIENT_ID,redirect_uri:url.origin+'/auth/callback',scope:'openid profile',state,nonce,code_challenge:await digest(verifier),code_challenge_method:'S256'});
 return redirect(whopBase(env)+'/oauth/authorize?'+query,'__Host-pv-login='+state+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600');
}
async function callback(request,env){
 const url=new URL(request.url),state=url.searchParams.get('state'),code=url.searchParams.get('code');
 const cookie=/(?:^|;\s*)__Host-pv-login=([^;]+)/.exec(request.headers.get('Cookie')??'')?.[1];
 if(!validSecret(state)||state!==cookie||!code||code.length>4096)fail(400,'The sign-in expired. Start again from Perfect Entry.');
 const flow=await env.ACCOUNTS.prepare('DELETE FROM oauth_flows WHERE state_hash=? AND expires_at>? RETURNING *').bind(await digest(state),seconds()).first();if(!flow)fail(400,'Sign-in already used or expired.');
 const token=await provider(env,'/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',code,redirect_uri:url.origin+'/auth/callback',client_id:env.WHOP_CLIENT_ID,client_secret:env.WHOP_CLIENT_SECRET,code_verifier:flow.verifier})});
 if(typeof token.access_token!=='string'||typeof token.id_token!=='string')fail(503,'Whop returned an incomplete sign-in.');
 // Identity comes from authenticated userinfo over the server-to-server token channel.
 // The id_token is used only to match the nonce from that same trusted response.
 let claims;try{claims=JSON.parse(atob(token.id_token.split('.')[1].replaceAll('-','+').replaceAll('_','/')));}catch{fail(503,'Invalid identity response.');}
 if(claims.nonce!==flow.nonce||!(Array.isArray(claims.aud)?claims.aud.includes(env.WHOP_CLIENT_ID):claims.aud===env.WHOP_CLIENT_ID)||!Number.isFinite(claims.exp)||claims.exp<seconds())fail(400,'Invalid sign-in nonce.');
 const user=await provider(env,'/oauth/userinfo',{headers:{Authorization:'Bearer '+token.access_token}});
 if(!/^user_[a-zA-Z0-9]+$/.test(user.sub??'')||claims.sub!==user.sub)fail(400,'Invalid Whop identity.');
 const ticket=random(),target=new URL(flow.return_to);
 await env.ACCOUNTS.prepare('INSERT INTO login_tickets VALUES(?,?,?,?,?,?)').bind(await digest(ticket),user.sub,String(user.name??user.preferred_username??'Member').slice(0,80),flow.client_challenge,target.origin,seconds()+60).run();
 // No Whop token is stored in the browser or retained in the database.
 if(token.refresh_token)try{await provider(env,'/oauth/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token.refresh_token,client_id:env.WHOP_CLIENT_ID,client_secret:env.WHOP_CLIENT_SECRET})});}catch{}
 target.hash=new URLSearchParams({pv_code:ticket}).toString();
 return redirect(target.href,'__Host-pv-login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
}
async function exchange(request,env){
 const {code,verifier}=await body(request,4096);if(!validSecret(code)||!validSecret(verifier))fail(400,'Invalid sign-in ticket.');
 const ticket=await env.ACCOUNTS.prepare('DELETE FROM login_tickets WHERE code_hash=? AND challenge=? AND origin=? AND expires_at>? RETURNING *').bind(await digest(code),await digest(verifier),request.headers.get('Origin'),seconds()).first();if(!ticket)fail(401,'Sign-in ticket expired or does not match this browser.');
 const token=random(),expires=seconds()+7*86400;
 await env.ACCOUNTS.prepare('INSERT INTO sessions(token_hash,user_id,display_name,expires_at) VALUES(?,?,?,?)').bind(await digest(token),ticket.user_id,ticket.display_name,expires).run();
 return json({token,expiresAt:expires,user:{id:ticket.user_id,name:ticket.display_name}});
}
async function layoutRegistry(env) {
 const registry=new IndicatorRegistry();for(const d of indicators.definitions.values())registry.register(d);
 if(!env.PRIVATE_INDICATORS)return registry;
 const object=await env.PRIVATE_INDICATORS.get('custom-indicators.schema.json');if(!object)return registry;
 if(object.size>65536)fail(503,'Private indicator settings are too large.');
 const definitions=await object.json();if(!Array.isArray(definitions)||definitions.length>20)fail(503,'Private indicator settings are invalid.');
 for(const d of definitions){
  if(!/^pe_[a-z0-9_]{1,48}$/.test(d.id??'')||typeof d.name!=='string'||!d.inputs||typeof d.inputs!=='object'||Object.keys(d.inputs).length>30)fail(503,'Private indicator settings are invalid.');
  const inputs={};for(const [key,input] of Object.entries(d.inputs)){
   if(!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)||['id','key','name','enabled','color','__proto__','constructor','prototype'].includes(key)||!input)fail(503,'Private indicator input is invalid.');
   if(input.type==='boolean'){if(typeof input.default!=='boolean')fail(503,'Private indicator switch is invalid.');}
   else if(input.type==='number'){if(![input.min,input.max,input.step,input.default].every(Number.isFinite)||input.min>input.max||input.step<=0||input.default<input.min||input.default>input.max)fail(503,'Private indicator number is invalid.');}
   else fail(503,'Unsupported private indicator input.');inputs[key]=input;
  }
  registry.register({id:d.id,name:d.name,pane:d.pane==='oscillator'?'oscillator':'price',inputs,defaults:{color:'#b4a2ff'},calculate:()=>null});
 }
 return registry;
}
async function premiumIndicators(request,env){
 await requireAccess(request,env);if(request.method!=='GET')fail(405,'GET required.');
 if(!env.PRIVATE_INDICATORS)return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 const object=await env.PRIVATE_INDICATORS.get('custom-indicators.bundle.mjs');if(!object)return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
 if(object.size>2097152)fail(503,'Private indicator bundle is too large.');
 return new Response(object.body,{headers:{'Content-Type':'application/javascript','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
async function layouts(request,env,id){
 const s=await requireAccess(request,env),db=env.ACCOUNTS;
 if(request.method==='GET'&&!id){const r=await db.prepare('SELECT id,name,revision,updated_at FROM layouts WHERE user_id=? ORDER BY updated_at DESC').bind(s.user_id).all();return json({layouts:r.results});}
 if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id??''))fail(400,'Invalid layout ID.');
 if(request.method==='GET'){const r=await db.prepare('SELECT document,revision FROM layouts WHERE user_id=? AND id=?').bind(s.user_id,id).first();if(!r)fail(404,'Layout not found.');return json({layout:JSON.parse(r.document),revision:r.revision,id});}
 const revision=Number(request.headers.get('If-Match'));if(!request.headers.has('If-Match')||!Number.isSafeInteger(revision)||revision<0)fail(428,'Supply the saved layout revision.');
 if(request.method==='DELETE'){const r=await db.prepare('DELETE FROM layouts WHERE user_id=? AND id=? AND revision=? RETURNING id').bind(s.user_id,id,revision).first();if(!r)fail(409,'The layout changed elsewhere. Reload it first.');return json({deleted:true});}
 if(request.method!=='PUT')fail(405,'Method not allowed.');
 let layout;try{layout=validateLayout(await body(request),await layoutRegistry(env));}catch(e){if(e instanceof Problem)throw e;fail(400,e.message);}
 const document=JSON.stringify(layout);
 const r=await db.prepare(`INSERT INTO layouts(user_id,id,name,document,revision,updated_at)
 SELECT ?,?,?,?,1,? WHERE ((SELECT count(*) FROM layouts WHERE user_id=?)<20 OR EXISTS(SELECT 1 FROM layouts WHERE user_id=? AND id=?)) AND (?=0 OR EXISTS(SELECT 1 FROM layouts WHERE user_id=? AND id=?))
 ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,document=excluded.document,revision=layouts.revision+1,updated_at=excluded.updated_at WHERE layouts.revision=? AND ?>0 RETURNING revision`).bind(s.user_id,id,layout.name,document,seconds(),s.user_id,s.user_id,id,revision,s.user_id,id,revision,revision).first();
 if(!r)fail(409,'Layout changed on another device, or the 20-layout limit was reached. Reload before saving.');
 return json({id,revision:r.revision});
}
async function signals(request,env){
 await requireAccess(request,env,'signals');if(request.method!=='GET')fail(405,'GET required.');
 if(!env.SUPABASE_SERVICE_ROLE_KEY||!env.SUPABASE_URL)fail(503,'Signals source is not configured.');
 const date=new Date(),today=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate())),tomorrow=new Date(today.getTime()+86400000);
 const cache=globalThis.caches?.default,key=new Request(new URL('/internal-signal-cache/'+today.toISOString().slice(0,10)+'/'+Math.floor(Date.now()/30000),request.url));
 let cached=cache?await cache.match(key):null;
 if(!cached){const rows=[];
  for(let offset=0;offset<2000;offset+=500){const url=new URL('/rest/v1/public_signal_feed',env.SUPABASE_URL);url.search=new URLSearchParams({select:'*',created_at:'gte.'+today.toISOString(),and:`(created_at.lt.${tomorrow.toISOString()})`,currency_ai_pass:'eq.true',tf:'in.(1min,5min)',order:'created_at.desc',limit:'500',offset:String(offset)});
   const r=await fetch(url,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY},signal:AbortSignal.timeout(10000)});if(!r.ok)fail(503,'Signals are temporarily unavailable.');const page=await r.json();if(!Array.isArray(page))fail(503,'Invalid signals source.');rows.push(...page);if(page.length<500)break;
  }
  cached=new Response(JSON.stringify(rows),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=30'}});if(cache)await cache.put(key,cached.clone());
 }
 return new Response(cached.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
export async function handle(request,env){
 const url=new URL(request.url),path=url.pathname,origin=request.headers.get('Origin');
 if(path==='/health')return json({service:'perfect-view-accounts',version:2});
 if(!env.ACCOUNTS||!/^app_[a-zA-Z0-9]+$/.test(env.WHOP_CLIENT_ID??'')||!env.WHOP_CLIENT_SECRET||!env.WHOP_COMPANY_API_KEY)fail(503,'Whop accounts are not configured yet.');
 if(path==='/auth/login'&&request.method==='GET')return login(request,env);
 if(path==='/auth/callback'&&request.method==='GET')return callback(request,env);
 if(!origin||!origins(env).includes(origin))fail(403,'Origin not allowed.');
 if(request.method==='OPTIONS')return new Response(null,{status:204});
 if(path==='/auth/exchange'&&request.method==='POST')return exchange(request,env);
 if(path==='/auth/logout'&&request.method==='POST'){const s=await session(request,env,false);await env.ACCOUNTS.prepare('DELETE FROM sessions WHERE token_hash=?').bind(s.token_hash).run();return json({signedOut:true});}
 if(path==='/me'&&request.method==='GET'){const s=await session(request,env);return json({user:{id:s.user_id,name:s.display_name},access:s.access,expiresAt:s.expires_at});}
 if(path==='/signals')return signals(request,env);
 if(path==='/indicators')return premiumIndicators(request,env);
 if(path==='/layouts'||path.startsWith('/layouts/'))return layouts(request,env,path.split('/')[2]);
 fail(404,'Not found.');
}
export default {
 async fetch(request,env){let response;try{response=await handle(request,env);}catch(e){response=json({error:e instanceof Problem?e.message:'The account service is temporarily unavailable.'},e instanceof Problem?e.status:503);}
  const headers=new Headers(response.headers),origin=request.headers.get('Origin');if(origins(env).includes(origin)){headers.set('Access-Control-Allow-Origin',origin);headers.set('Vary','Origin');headers.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');headers.set('Access-Control-Allow-Headers','Authorization,Content-Type,If-Match');}
  return new Response(response.body,{status:response.status,headers});
 },
 async scheduled(event,env){const now=seconds();await env.ACCOUNTS.batch(['oauth_flows','login_tickets','sessions'].map(table=>env.ACCOUNTS.prepare(`DELETE FROM ${table} WHERE expires_at<=?`).bind(now)));}
};
