const key='perfect-view:account-session:v2',flowKey='perfect-view:login-verifier:v2';
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function challenge(value){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
export class Account {
 constructor(url){this.url=url?.replace(/\/$/,'');this.user=null;this.access={};this.token=null;}
 async initialize(){
  if(!this.url)return null;
  const hash=new URLSearchParams(location.hash.slice(1)),code=hash.get('pv_code');
  if(code){
   history.replaceState(null,'',location.pathname+location.search);
   const verifier=sessionStorage.getItem(flowKey);sessionStorage.removeItem(flowKey);
   if(!verifier)throw new Error('Sign-in could not be matched to this tab. Try again.');
   const session=await this.request('/auth/exchange',{method:'POST',body:JSON.stringify({code,verifier})},false);
   sessionStorage.setItem(key,JSON.stringify({...session,endpoint:this.url}));
  }
  let saved;try{saved=JSON.parse(sessionStorage.getItem(key)||'null');}catch{}
  if(saved?.endpoint===this.url&&saved.expiresAt>Date.now()/1000)this.token=saved.token;
  if(!this.token)return null;
  try{const profile=await this.request('/me');this.user=profile.user;this.access=profile.access;return profile;}
  catch(e){if(e.status===401){sessionStorage.removeItem(key);this.token=null;return null;}throw e;}
 }
 async signIn(){
  const verifier=random();sessionStorage.setItem(flowKey,verifier);
  const url=new URL(this.url+'/auth/login');url.search=new URLSearchParams({return_to:location.origin+location.pathname,challenge:await challenge(verifier)});location.assign(url);
 }
 async request(path,options={},authenticated=true){
  if(!this.url)throw new Error('Account sync is not configured yet.');
  if(authenticated&&!this.token)throw new Error('Sign in to save layouts to your account.');
  const response=await fetch(this.url+path,{...options,credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{...(options.body?{'Content-Type':'application/json'}:{}),...(authenticated?{Authorization:'Bearer '+this.token}:{}),...options.headers}});
  const body=await response.json();if(!response.ok){const e=new Error(body.error??'Account request failed.');e.status=response.status;throw e;}return body;
 }
 async loadPremium(registry) {
  if(!this.token||!this.access.perfectView)return;
  const response=await fetch(this.url+'/indicators',{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+this.token}});
  if(response.status===204)return;
  if(!response.ok)throw new Error('Your private indicators could not be loaded.');
  const source=await response.text();if(source.length>2097152)throw new Error('Private indicator bundle is too large.');
  // This is an owner-published, self-contained ES module, not arbitrary user code.
  const url=URL.createObjectURL(new Blob([source],{type:'application/javascript'}));
  try{const bundle=await import(url);if(typeof bundle.registerCustomIndicators!=='function')throw new Error('Invalid private indicator bundle.');bundle.registerCustomIndicators(registry);}finally{URL.revokeObjectURL(url);}
 }
 async signOut(){try{await this.request('/auth/logout',{method:'POST'});}finally{sessionStorage.removeItem(key);this.user=null;this.token=null;this.access={};}}
}
export function showMembershipGate(account,scope,onGranted){
 if(account.user&&account.access[scope]){onGranted?.();return true;}
 const section=document.createElement('section');section.className='membership-gate';section.setAttribute('role','region');
 const heading=document.createElement('h2');heading.textContent=account.user?'Membership required':'Sign in to Perfect Entry';
 const copy=document.createElement('p');copy.textContent=account.user?'Your Whop account does not currently include this page. Use the account linked to your membership.':'Use the Whop account linked to your Perfect Entry membership.';
 const button=document.createElement('button');button.className='button primary';button.textContent=account.user?'Use a different Whop account':'Sign in with Whop';button.addEventListener('click',async()=>{if(account.user)await account.signOut();await account.signIn();});
 section.append(heading,copy,button);document.querySelector('main')?.replaceWith(section);return false;
}
