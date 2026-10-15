import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {build} from 'esbuild';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {digest} from '../../cloudflare/accounts/worker.mjs';
const origin='https://perfectentry.store';
const good={version:2,name:'London',preferences:{symbol:'EURUSD',timeframe:300,mode:'candles',focus:true,closedOnly:true,refreshSeconds:30},studies:[{id:'rsi',key:'rsi',period:14,color:'#abcdef'}],markets:{EURUSD:{drawings:[]}}};
test('real D1 account API isolates owners, rejects revoked memberships, protects revisions and limits layouts',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../../cloudflare/accounts/worker.mjs',import.meta.url))],bundle:true,format:'esm',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['ACCOUNTS'],bindings:{ALLOWED_ORIGINS:origin,WHOP_CLIENT_ID:'app_test',WHOP_CLIENT_SECRET:'test-only',WHOP_COMPANY_API_KEY:'test-only',PERFECT_VIEW_PRODUCTS:'prod_test',SIGNALS_PRODUCTS:'prod_test'}}));
 try {
  const db=await mf.getD1Database('ACCOUNTS'),schema=await readFile(new URL('../../cloudflare/accounts/migrations/0001_accounts.sql',import.meta.url),'utf8');
  for(const sql of schema.split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const tokenA='a'.repeat(43),tokenB='b'.repeat(43),tokenNo='c'.repeat(43),now=Math.floor(Date.now()/1000);
  for(const [token,user,access] of [[tokenA,'user_alice',true],[tokenB,'user_bob',true],[tokenNo,'user_revoked',false]])await db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').bind(await digest(token),user,user,now+3600,JSON.stringify({perfectView:access,signals:access}),now).run();
  const request=(path,token=tokenA,method='GET',data,revision)=>mf.dispatchFetch('https://accounts.test'+path,{method,headers:{Origin:origin,...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json'}:{}),...(revision!==undefined?{'If-Match':String(revision)}:{})},...(data?{body:JSON.stringify(data)}:{})});
  assert.equal((await request('/indicators',tokenNo)).status,403);assert.equal((await request('/indicators',tokenA)).status,204);
  assert.equal((await request('/layouts',null)).status,401);assert.equal((await request('/layouts',tokenNo)).status,403);
  let r=await request('/layouts/london',tokenA,'PUT',good,0);assert.equal(r.status,200,await r.clone().text());assert.equal((await r.json()).revision,1);
  assert.equal((await request('/layouts/london',tokenB)).status,404);assert.equal((await request('/layouts/london',tokenB,'DELETE',null,1)).status,409);
  assert.equal((await request('/layouts/london',tokenA,'PUT',good,0)).status,409);
  r=await request('/layouts/london',tokenA,'PUT',{...good,name:'Updated'},1);assert.equal((await r.json()).revision,2);
  assert.equal((await request('/layouts/london',tokenA,'PUT',{...good,markets:{EURUSD:{drawings:[{}]}}},2)).status,400);
  assert.equal((await request('/layouts/london',tokenA,'PUT',good)).status,428);
  const foreign=await mf.dispatchFetch('https://accounts.test/layouts',{headers:{Origin:'https://evil.example',Authorization:'Bearer '+tokenA}});assert.equal(foreign.status,403);assert.equal(foreign.headers.get('Access-Control-Allow-Origin'),null);
  for(let i=0;i<19;i++)assert.equal((await request('/layouts/layout-'+i,tokenA,'PUT',good,0)).status,200);
  assert.equal((await request('/layouts/too-many',tokenA,'PUT',good,0)).status,409);
  assert.equal((await request('/auth/logout',tokenA,'POST')).status,200);assert.equal((await request('/me',tokenA)).status,401);
 }finally{await mf.dispose();}
});
test('OAuth login uses PKCE, nonce, allowlisted returns and a secure callback state cookie',async()=>{
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../../cloudflare/accounts/worker.mjs',import.meta.url))],bundle:true,format:'esm',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['ACCOUNTS'],bindings:{ALLOWED_ORIGINS:origin,WHOP_CLIENT_ID:'app_test',WHOP_CLIENT_SECRET:'test-only',WHOP_COMPANY_API_KEY:'test-only'}}));
 try{
  const db=await mf.getD1Database('ACCOUNTS'),schema=await readFile(new URL('../../cloudflare/accounts/migrations/0001_accounts.sql',import.meta.url),'utf8');for(const sql of schema.split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const query=new URLSearchParams({return_to:origin+'/perfect-view.html',challenge:'a'.repeat(43)});
  const r=await mf.dispatchFetch('https://accounts.test/auth/login?'+query,{redirect:'manual'});assert.equal(r.status,302);
  const destination=new URL(r.headers.get('Location'));assert.equal(destination.origin,'https://api.whop.com');assert.equal(destination.pathname,'/oauth/authorize');assert.equal(destination.searchParams.get('code_challenge_method'),'S256');assert.equal(destination.searchParams.get('scope'),'openid profile');assert.ok(destination.searchParams.get('nonce'));assert.match(r.headers.get('Set-Cookie'),/HttpOnly; Secure; SameSite=Lax/);
  const bad=new URLSearchParams({return_to:'https://evil.example/perfect-view.html',challenge:'a'.repeat(43)});assert.equal((await mf.dispatchFetch('https://accounts.test/auth/login?'+bad,{redirect:'manual'})).status,400);
  assert.equal((await mf.dispatchFetch('https://accounts.test/auth/callback?code=fake&state='+destination.searchParams.get('state'),{redirect:'manual'})).status,400);
  const ticket='x'.repeat(43),verifier='y'.repeat(43),now=Math.floor(Date.now()/1000);await db.prepare('INSERT INTO login_tickets VALUES(?,?,?,?,?,?)').bind(await digest(ticket),'user_alice','Alice',await digest(verifier),origin,now+60).run();
  const exchange=()=>mf.dispatchFetch('https://accounts.test/auth/exchange',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({code:ticket,verifier})});
  const session=await exchange();assert.equal(session.status,200);assert.equal((await session.json()).token.length,43);assert.equal((await exchange()).status,401);
 }finally{await mf.dispose();}
});

test('live Whop checks use the verified API contract, deduplicate products and fail closed',async()=>{
 const worker=await import('../../cloudflare/accounts/worker.mjs');
 const bundle=await build({entryPoints:[fileURLToPath(new URL('../../cloudflare/accounts/worker.mjs',import.meta.url))],bundle:true,format:'esm',write:false});
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',d1Databases:['ACCOUNTS']}));
 const native=globalThis.fetch;
 try{
  const db=await mf.getD1Database('ACCOUNTS'),schema=await readFile(new URL('../../cloudflare/accounts/migrations/0001_accounts.sql',import.meta.url),'utf8');for(const sql of schema.split(';').filter(s=>s.trim()))await db.prepare(sql).run();
  const now=Math.floor(Date.now()/1000),token='d'.repeat(43);await db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').bind(await digest(token),'user_alice','Alice',now+3600,JSON.stringify({perfectView:true,signals:true}),now-400).run();
  const env={ACCOUNTS:db,ALLOWED_ORIGINS:origin,WHOP_CLIENT_ID:'app_test',WHOP_CLIENT_SECRET:'test-only',WHOP_COMPANY_API_KEY:'test-only',PERFECT_VIEW_PRODUCTS:'prod_test',SIGNALS_PRODUCTS:'prod_test'};
  const request=()=>new Request('https://accounts.test/layouts',{headers:{Origin:origin,Authorization:'Bearer '+token}});
  let calls=0;globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'https://api.whop.com/api/v1/users/user_alice/access/prod_test');assert.equal(options.headers['Api-Version-Date'],'2026-10-13-1');return Response.json({has_access:false,access_level:'no_access'});};
  assert.equal((await worker.default.fetch(request(),env)).status,403);assert.equal(calls,1);
  await db.prepare('UPDATE sessions SET checked_at=?,access_json=?').bind(now-400,JSON.stringify({perfectView:true,signals:true})).run();
  globalThis.fetch=async()=>new Response('Outage',{status:500});assert.equal((await worker.default.fetch(request(),env)).status,503);
  // Sign-out still revokes the app session during a provider outage.
  const logout=new Request('https://accounts.test/auth/logout',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+token}});assert.equal((await worker.default.fetch(logout,env)).status,200);
 }finally{globalThis.fetch=native;await mf.dispose();}
});
