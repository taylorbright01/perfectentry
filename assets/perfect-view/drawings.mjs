const colours = ['#b5c3cc','#80cec6','#8ab8ed','#dfca86','#b4a2ff','#dd9db4','#b5c3cc','#8ab8ed','#80cec6'];
export function defaultFib() {
  return {opacity:.9,width:1.5,extend:true,labels:true,levels:[0,.236,.382,.5,.618,.786,1,1.272,1.618].map((value,i)=>({value,color:colours[i],opacity:1,visible:true}))};
}
export function validateFib(raw) {
  if(raw==null)return defaultFib();
  if(!raw||!Number.isFinite(raw.opacity)||raw.opacity<.1||raw.opacity>1||!Number.isFinite(raw.width)||raw.width<.5||raw.width>5||typeof raw.extend!=='boolean'||typeof raw.labels!=='boolean'||!Array.isArray(raw.levels)||raw.levels.length<1||raw.levels.length>24)return null;
  const levels=[];
  for(const l of raw.levels){
    if(!l||!Number.isFinite(l.value)||Math.abs(l.value)>10||!/^#[0-9a-f]{6}$/i.test(l.color)||!Number.isFinite(l.opacity)||l.opacity<.1||l.opacity>1||typeof l.visible!=='boolean')return null;
    levels.push({value:l.value,color:l.color,opacity:l.opacity,visible:l.visible});
  }
  if(!levels.some(l=>l.visible))return null;
  return {opacity:raw.opacity,width:raw.width,extend:raw.extend,labels:raw.labels,levels};
}
// 0 is the second (swing-end) anchor; 1 is the first (swing-start) anchor.
export function fibPrices(points,settings=defaultFib()) {
  const [start,end]=points;
  return settings.levels.filter(l=>l.visible).map(l=>({...l,price:end.price+(start.price-end.price)*l.value}));
}
export function validatePriceRange(raw) {
  if(raw==null)return null;
  return Number.isFinite(raw.min)&&Number.isFinite(raw.max)&&raw.max>raw.min&&raw.max>0&&Math.abs(raw.min)<1e15&&raw.max<1e15 ? {min:raw.min,max:raw.max} : null;
}
