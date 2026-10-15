// Native, causal studies. Every calculation uses this and earlier completed bars only.
const color = '#b4a2ff';
const number = (label,value,min=1,max=500,step=1)=>({type:'number',label,default:value,min,max,step});
const toggle=(label,value=true)=>({type:'boolean',label,default:value});
export function average(values,period,method='sma') {
 const out=Array(values.length).fill(null);let sum=0,weighted=0,value=null;
 const alpha=method==='rma'?1/period:2/(period+1);
 const window=[];
 for(let i=0;i<values.length;i++) {
  const v=values[i];
  if(!Number.isFinite(v)){window.length=0;sum=0;weighted=0;value=null;continue;}
  if(method==='ema'){value=value===null?v:value+alpha*(v-value);out[i]=value;continue;}
  if(window.length===period){weighted-=sum;sum-=window.shift();}
  window.push(v);sum+=v;weighted+=v*window.length;
  if(window.length<period)continue;
  if(method==='rma'){value=value===null?sum/period:value+alpha*(v-value);out[i]=value;}
  else out[i]=method==='wma'?weighted/(period*(period+1)/2):sum/period;
 }
 return out;
}
const points=(bars,values)=>bars.map((b,i)=>({time:b.time,value:values[i]}));
const line=(bars,values,color)=>({points:points(bars,values),color});
const base=(pane='price')=>({pane,lines:[],zones:[],markers:[],histograms:[],levels:[]});
export function rsiValues(values,period) {
 const gain=values.map((v,i)=>i?Math.max(0,v-values[i-1]):null);
 const loss=values.map((v,i)=>i?Math.max(0,values[i-1]-v):null);
 const gains=average(gain,period,'rma'),losses=average(loss,period,'rma');
 return gains.map((g,i)=>g===null?null:losses[i]===0?(g===0?50:100):100-100/(1+g/losses[i]));
}
export function trueRanges(bars){return bars.map((b,i)=>i?Math.max(b.high-b.low,Math.abs(b.high-bars[i-1].close),Math.abs(b.low-bars[i-1].close)):b.high-b.low);}
function moving(method,bars,s){
 const close=bars.map(b=>b.close);let result;
 if(method==='hma') {
  const half=average(close,Math.max(1,Math.floor(s.period/2)),'wma'),full=average(close,s.period,'wma');
  result=average(full.map((v,i)=>v===null||half[i]===null?null:2*half[i]-v),Math.max(1,Math.round(Math.sqrt(s.period))),'wma');
 } else if(method==='dema'||method==='tema') {
  const a=average(close,s.period,'ema'),b=average(a,s.period,'ema'),c=average(b,s.period,'ema');
  result=a.map((v,i)=>method==='dema'?2*v-b[i]:3*v-3*b[i]+c[i]);
 } else result=average(close,s.period,method);
 return {...base(),lines:s.showLine?[line(bars,result,s.color)]:[]};
}
export const definitions=[];
for(const [id,name] of [['sma','Simple MA'],['ema','Exponential MA'],['wma','Weighted MA'],['rma','Wilder MA'],['hma','Hull MA'],['dema','Double EMA'],['tema','Triple EMA']])
 definitions.push({id,name,inputs:{period:number('Period',20),showLine:toggle('Moving average')},defaults:{period:20,showLine:true,color},calculate:(b,s)=>moving(id,b,s)});
definitions.push({id:'rsi',name:'RSI',pane:'oscillator',inputs:{period:number('Period',14),upper:number('Overbought',70,0,100),lower:number('Oversold',30,0,100),showLine:toggle('RSI'),showLevels:toggle('Reference levels')},defaults:{period:14,upper:70,lower:30,showLine:true,showLevels:true,color:'#80cec6'},calculate:(b,s)=>({...base('oscillator'),range:[0,100],lines:s.showLine?[line(b,rsiValues(b.map(x=>x.close),s.period),s.color)]:[],levels:s.showLevels?[s.lower,50,s.upper]:[]})});
definitions.push({id:'stochrsi',name:'Stochastic RSI',pane:'oscillator',inputs:{period:number('RSI period',14),length:number('Stochastic period',14),smoothK:number('K smoothing',3),smoothD:number('D smoothing',3),showK:toggle('K line'),showD:toggle('D line')},defaults:{period:14,length:14,smoothK:3,smoothD:3,showK:true,showD:true,color:'#80cec6'},calculate:(b,s)=>{
 const r=rsiValues(b.map(x=>x.close),s.period),raw=r.map((v,i)=>{const w=r.slice(Math.max(0,i-s.length+1),i+1);if(w.length<s.length||w.some(x=>x===null))return null;const min=Math.min(...w),max=Math.max(...w);return max===min?50:100*(v-min)/(max-min);});
 const k=average(raw,s.smoothK),d=average(k,s.smoothD);return {...base('oscillator'),range:[0,100],levels:[20,80],lines:[...(s.showK?[line(b,k,s.color)]:[]),...(s.showD?[line(b,d,'#e3b975')]:[])]};
}});
definitions.push({id:'macd',name:'MACD',pane:'oscillator',inputs:{fast:number('Fast EMA',12),slow:number('Slow EMA',26),signal:number('Signal EMA',9),showMacd:toggle('MACD line'),showSignal:toggle('Signal line'),showHistogram:toggle('Histogram')},defaults:{fast:12,slow:26,signal:9,showMacd:true,showSignal:true,showHistogram:true,color:'#b4a2ff'},calculate:(b,s)=>{
 const close=b.map(x=>x.close),fast=average(close,s.fast,'ema'),slow=average(close,s.slow,'ema'),macd=fast.map((v,i)=>v-slow[i]),signal=average(macd,s.signal,'ema');
 return {...base('oscillator'),levels:[0],lines:[...(s.showMacd?[line(b,macd,s.color)]:[]),...(s.showSignal?[line(b,signal,'#e3b975')]:[])],histograms:s.showHistogram?[{points:points(b,macd.map((v,i)=>v-signal[i])),positive:'#74c8bb',negative:'#ce8585'}]:[]};
}});
definitions.push({id:'bb',name:'Bollinger Bands',inputs:{period:number('Period',20),deviation:number('Standard deviations',2,.1,10,.1),showMiddle:toggle('Middle band'),showBands:toggle('Outer bands')},defaults:{period:20,deviation:2,showMiddle:true,showBands:true,color:'#b4a2ff'},calculate:(b,s)=>{
 const close=b.map(x=>x.close),mid=average(close,s.period),sd=mid.map((m,i)=>m===null?null:Math.sqrt(close.slice(i-s.period+1,i+1).reduce((sum,v)=>sum+(v-m)**2,0)/s.period));
 return {...base(),lines:[...(s.showMiddle?[line(b,mid,s.color)]:[]),...(s.showBands?[line(b,mid.map((v,i)=>v===null?null:v+s.deviation*sd[i]),'#80cec6'),line(b,mid.map((v,i)=>v===null?null:v-s.deviation*sd[i]),'#80cec6')]:[])]};
}});
definitions.push({id:'atr',name:'ATR',pane:'oscillator',inputs:{period:number('Period',14),showLine:toggle('ATR')},defaults:{period:14,showLine:true,color:'#e3b975'},calculate:(b,s)=>({...base('oscillator'),lines:s.showLine?[line(b,average(trueRanges(b),s.period,'rma'),s.color)]:[]})});
definitions.push({id:'stochastic',name:'Stochastic',pane:'oscillator',inputs:{period:number('Lookback',14),smoothK:number('K smoothing',3),smoothD:number('D smoothing',3),showK:toggle('K line'),showD:toggle('D line')},defaults:{period:14,smoothK:3,smoothD:3,showK:true,showD:true,color:'#80cec6'},calculate:(b,s)=>{
 const raw=b.map((bar,i)=>{if(i+1<s.period)return null;const w=b.slice(i-s.period+1,i+1),lo=Math.min(...w.map(x=>x.low)),hi=Math.max(...w.map(x=>x.high));return hi===lo?50:100*(bar.close-lo)/(hi-lo);});const k=average(raw,s.smoothK),d=average(k,s.smoothD);
 return {...base('oscillator'),range:[0,100],levels:[20,80],lines:[...(s.showK?[line(b,k,s.color)]:[]),...(s.showD?[line(b,d,'#e3b975')]:[])]};
}});
definitions.push({id:'volume',name:'Tick volume',pane:'oscillator',inputs:{showHistogram:toggle('Volume')},defaults:{showHistogram:true,color:'#80cec6'},calculate:(b,s)=>({...base('oscillator'),levels:[0],histograms:s.showHistogram?[{points:points(b,b.map(x=>x.volume)),positive:s.color,negative:s.color}]:[]})});
export function validateStudy(raw,registry) {
 if(!raw||typeof raw.key!=='string'||raw.key.length>80)return null;
 const d=registry.definitions.get(raw.id);if(!d)return null;
 const result={id:d.id,key:raw.key,color:/^#[0-9a-f]{6}$/i.test(raw.color)?raw.color:d.defaults.color??color,name:typeof raw.name==='string'?raw.name.trim().slice(0,80):'',enabled:raw.enabled!==false};
 for(const [key,input] of Object.entries(d.inputs??{})){
  const value=raw[key]??input.default;
  if(input.type==='boolean'){if(typeof value!=='boolean')return null;}
  else if(typeof value!=='number'||!Number.isFinite(value)||value<input.min||value>input.max||(input.step===1&&!Number.isInteger(value)))return null;
  result[key]=value;
 }
 if(result.id==='rsi'&&result.lower>=result.upper)return null;
 if(result.id==='macd'&&result.fast>=result.slow)return null;
 return result;
}
