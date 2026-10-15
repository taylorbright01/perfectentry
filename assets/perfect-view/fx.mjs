import {ACCOUNT_CURRENCIES} from './risk.mjs';
export const FX_MAX_AGE=180;
export function isFxSymbol(symbol){return typeof symbol==='string'&&symbol.length===6&&ACCOUNT_CURRENCIES.includes(symbol.slice(0,3))&&ACCOUNT_CURRENCIES.includes(symbol.slice(3))&&symbol.slice(0,3)!==symbol.slice(3);}
export function currencyPaths(from,to,symbols,maxHops=3){
  if(!ACCOUNT_CURRENCIES.includes(from)||!ACCOUNT_CURRENCIES.includes(to))return [];
  if(from===to)return [{currencies:[from],symbols:[]}];
  const graph=new Map();
  for(const symbol of new Set(symbols.filter(isFxSymbol))){const a=symbol.slice(0,3),b=symbol.slice(3);for(const [start,end] of [[a,b],[b,a]]){if(!graph.has(start))graph.set(start,[]);graph.get(start).push({end,symbol});}}
  const queue=[{currencies:[from],symbols:[]}],paths=[];
  while(queue.length){const p=queue.shift(),last=p.currencies.at(-1);if(p.symbols.length>=maxHops)continue;
    for(const edge of graph.get(last)??[]){if(p.currencies.includes(edge.end))continue;const next={currencies:[...p.currencies,edge.end],symbols:[...p.symbols,edge.symbol]};if(edge.end===to)paths.push(next);else queue.push(next);}
  }
  return paths.sort((a,b)=>a.symbols.length-b.symbols.length||Number(!a.currencies.includes('USD'))-Number(!b.currencies.includes('USD')));
}
export class FxBook{
  constructor(){this.quotes=new Map();this.generation=0;this.cache=new Map();}
  set(quote){
    if(!quote||!isFxSymbol(quote.symbol)||!Number.isFinite(quote.close)||quote.close<=0||!Number.isSafeInteger(quote.asOf)||quote.asOf<0)return;
    const old=this.quotes.get(quote.symbol);if(old&&old.asOf>quote.asOf)return;
    if(old&&old.asOf===quote.asOf&&old.close===quote.close)return;
    this.quotes.set(quote.symbol,{symbol:quote.symbol,close:quote.close,asOf:quote.asOf});this.generation++;this.cache.clear();
  }
  resolve(from,to,{now=Date.now()/1000,maxAge=FX_MAX_AGE,maxSkew=60}={}){
    if(!ACCOUNT_CURRENCIES.includes(from)||!ACCOUNT_CURRENCIES.includes(to))return null;
    if(from===to)return {rate:1,from,to,currencies:[from],symbols:[],asOf:Math.floor(now),age:0};
    const key=[from,to,Math.floor(now),maxAge,maxSkew,this.generation].join(':');if(this.cache.has(key))return this.cache.get(key);
    const quotes=[...this.quotes.values()].filter(q=>q.asOf<=now&&now-q.asOf<=maxAge);
    const bySymbol=new Map(quotes.map(q=>[q.symbol,q]));let result=null;
    for(const p of currencyPaths(from,to,quotes.map(q=>q.symbol))){
      const dates=p.symbols.map(s=>bySymbol.get(s).asOf);if(Math.max(...dates)-Math.min(...dates)>maxSkew)continue;
      let rate=1;p.symbols.forEach((s,i)=>{const q=bySymbol.get(s);rate*=s.slice(0,3)===p.currencies[i]?q.close:1/q.close;});
      if(!Number.isFinite(rate)||rate<=0||rate>=1e9)continue;
      result={rate,from,to,...p,asOf:Math.min(...dates),age:now-Math.min(...dates)};break;
    }
    if(this.cache.size>32)this.cache.clear();this.cache.set(key,result);return result;
  }
  ingestFrame(frame,group,now=Date.now()/1000){
    if(frame?.version!==1||frame.baseTimeframe!==30||frame.group!==group||!Number.isSafeInteger(frame.revision)||!Number.isSafeInteger(frame.updatedAt)||frame.updatedAt>now+10||!frame.streams||typeof frame.streams!=='object')throw new Error('Invalid conversion candle file.');
    for(const [symbol,source] of Object.entries(frame.streams)){
      if(!isFxSymbol(symbol)||!Number.isSafeInteger(source?.through)||source.through%30||source.through>now+10||!Array.isArray(source.candles)||source.candles.length>4)continue;
      const rows=source.candles.filter(r=>Array.isArray(r)&&r.length===7&&r[6]===0&&Number.isSafeInteger(r[0])&&r[0]%30===0&&r[0]+30<=source.through&&r[0]+30<=now&&r.slice(1,6).every(Number.isFinite)&&r.slice(1,5).every(v=>v>0)&&r[5]>=0&&r[2]>=Math.max(r[1],r[4])&&r[3]<=Math.min(r[1],r[4])&&r[2]>=r[3]);
      rows.sort((a,b)=>b[0]-a[0]);const last=rows[0];if(last)this.set({symbol,close:last[4],asOf:last[0]+30});
    }
  }
}
