// Exact bar values: gaps and warmups remain unavailable, never carried forward.
export function pointValueAt(points,time){
  if(!Number.isFinite(time)||!Array.isArray(points)||!points.length)return null;
  let lo=0,hi=points.length-1;
  while(lo<=hi){const mid=(lo+hi)>>1,p=points[mid];if(p.time===time)return Number.isFinite(p.value)?p.value:null;if(p.time<time)lo=mid+1;else hi=mid-1;}
  return null;
}
export function valuePrecision(model,pricePrecision=5){
  return model.id==='volume'?0:model.pane!=='oscillator'?pricePrecision:model.range?.[1]===100?2:Math.min(8,Math.max(2,pricePrecision+1));
}
export function formatStudyValue(value,model,pricePrecision=5){
  return Number.isFinite(value)?value.toLocaleString('en-GB',{minimumFractionDigits:valuePrecision(model,pricePrecision),maximumFractionDigits:valuePrecision(model,pricePrecision)}):'—';
}
export function modelValuesAt(model,time,pricePrecision=5){
  const series=[...(model.lines??[]).map((s,i)=>({...s,name:s.name??((model.lines??[]).length===1?'Value':'Line '+(i+1))})),...(model.histograms??[]).map((s,i)=>({...s,name:s.name??((model.histograms??[]).length===1?'Histogram':'Histogram '+(i+1))}))];
  return series.map(s=>{const value=pointValueAt(s.points,time);return {name:s.name,value,text:formatStudyValue(value,model,pricePrecision),color:s.color??(value>=0?s.positive:s.negative)??'#b4a2ff'};});
}
