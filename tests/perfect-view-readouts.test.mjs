import test from 'node:test';import assert from 'node:assert/strict';
import {pointValueAt,modelValuesAt} from '../assets/perfect-view/readouts.mjs';
import {PerfectViewChart} from '../assets/perfect-view/chart.mjs';
import {validateLayout} from '../assets/perfect-view/layouts.mjs';
test('indicator readouts preserve exact bar values, zeroes and warmup gaps',()=>{
 const points=[{time:0,value:null},{time:60,value:0},{time:120,value:42}];assert.equal(pointValueAt(points,60),0);assert.equal(pointValueAt(points,0),null);assert.equal(pointValueAt(points,90),null);assert.equal(pointValueAt(points,180),null);
});
test('ATR retains price precision and multi-line studies identify each component',()=>{
 const atr={id:'atr',pane:'oscillator',lines:[{points:[{time:60,value:.000034}],color:'#ffffff'}]};assert.equal(modelValuesAt(atr,60,5)[0].text,'0.000034');
 const macd={id:'macd',pane:'oscillator',lines:[{name:'MACD',points:[{time:60,value:.001}]},{name:'Signal',points:[{time:60,value:.0005}]}],histograms:[{points:[{time:60,value:0}],positive:'#00ff00',negative:'#ff0000'}]};
 const values=modelValuesAt(macd,60,5);assert.deepEqual(values.map(v=>v.name),['MACD','Signal','Histogram']);assert.equal(values[2].text,'0.000000');assert.equal(values[2].color,'#00ff00');
});
function chart(){
 const c=Object.create(PerfectViewChart.prototype),model={id:'rsi',key:'rsi-1',title:'RSI 14',pane:'oscillator',range:[0,100],lines:[{points:[{time:0,value:20},{time:60,value:80}]}]};
 Object.assign(c,{bars:[{time:0,close:10},{time:60,close:20}],models:[model],crosshair:true,precision:5,height:260,end:2,count:2,min:10,max:20,plot:{left:0,right:200,width:200,top:0,bottom:100,height:100},paneScales:[{model,valueTop:120,valueBottom:200,min:0,max:100}]});return c;
}
test('crosshair reads the price and indicator axes independently at the same candle',()=>{
 const c=chart();c.cursor={x:50,y:50};let r=c.readout();assert.equal(r.time,0);assert.equal(r.region.type,'price');assert.equal(r.region.value,15);assert.equal(r.models[0].values[0].value,20);
 c.cursor={x:150,y:140};r=c.readout();assert.equal(r.time,60);assert.equal(r.region.type,'indicator');assert.equal(r.region.value,75);assert.equal(r.models[0].values[0].value,80);assert.equal(r.latest,false);
});
test('latest study values use the last completed model candle and do not fill forming bars',()=>{
 const c=chart();c.bars.push({time:120,close:30});c.end=3;c.count=3;c.cursor=null;assert.equal(c.readout().time,60);assert.equal(c.readout().models[0].values[0].value,80);
 c.cursor={x:170,y:50};assert.equal(c.readout().time,120);assert.equal(c.readout().models[0].values[0].text,'—');
 c.crosshair=false;assert.equal(c.readout().time,60);assert.equal(c.readout().latest,true);
});
test('crosshair preference survives account layouts and older layouts use its default',()=>{
 const raw={version:2,name:'Readouts',preferences:{symbol:'EURUSD',timeframe:300,mode:'candles',focus:true,closedOnly:true,refreshSeconds:30},studies:[],markets:{EURUSD:{drawings:[]}}};
 assert.equal(validateLayout(raw).preferences.crosshair,true);assert.equal(validateLayout({...raw,preferences:{...raw.preferences,crosshair:false}}).preferences.crosshair,false);assert.throws(()=>validateLayout({...raw,preferences:{...raw.preferences,crosshair:'yes'}}));
});
