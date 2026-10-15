import test from 'node:test';
import assert from 'node:assert/strict';
import {PerfectViewChart} from '../assets/perfect-view/chart.mjs';

const bars=(start,length)=>Array.from({length},(_,i)=>({time:(start+i)*300,open:1,high:2,low:.5,close:1,volume:1}));
function chart(){return Object.assign(Object.create(PerfectViewChart.prototype),{bars:[],count:40,end:0,timeframe:300,precision:5,priceRange:null,requestDraw(){},emit(){this.pendingViewport=null;}});}
test('passive updates hold the right-edge timestamp, including a view left at latest',()=>{
 const c=chart();c.setBars(bars(100,100),{reset:true});
 assert.equal(c.count,40);const time=c.timeAt(c.end-1);
 c.setBars(bars(100,105));assert.equal(c.timeAt(c.end-1),time);
 c.latest();assert.equal(c.timeAt(c.end-1),204*300);
 c.setBars(bars(100,106));assert.equal(c.timeAt(c.end-1),204*300);
});
test('prepending history and updating during a drag preserve the viewed market times and price scale',()=>{
 const c=chart();c.setBars(bars(200,60),{reset:true});c.end=42.5;c.count=25;
 c.priceRange={min:1,max:3};c.drag={end:45};
 const time=c.timeAt(c.end-1),dragTime=c.timeAt(c.drag.end-1);
 c.setBars(bars(0,270));assert.equal(c.timeAt(c.end-1),time);assert.equal(c.timeAt(c.drag.end-1),dragTime);
 assert.equal(c.count,25);assert.deepEqual(c.priceRange,{min:1,max:3});
});
test('epoch-zero anchor is valid and an empty first stage can populate later',()=>{
 const c=chart();c.setBars(bars(0,1),{reset:true});c.setBars(bars(0,2));assert.equal(c.timeAt(c.end-1),0);
 c.setBars([],{reset:true});c.setBars(bars(10,80));assert.equal(c.end,80);
});
test('an older saved viewport waits for its history rather than being clamped to the first screen',()=>{
 const c=chart();c.setBars(bars(200,50),{reset:true});
 c.restoreViewport({count:30,endTime:100*300});assert.equal(c.pendingViewport.endTime,100*300);
 c.setBars(bars(150,100));assert.equal(c.pendingViewport.endTime,100*300);
 c.setBars(bars(0,250));assert.equal(c.pendingViewport,null);assert.equal(c.count,30);assert.equal(c.timeAt(c.end-1),100*300);
});
test('explicit navigation cancels a pending saved viewport and reset starts a fresh 40-bar view',()=>{
 const c=chart();c.setBars(bars(200,50),{reset:true});c.restoreViewport({count:30,endTime:30000});
 c.latest();c.setBars(bars(0,250));assert.equal(c.timeAt(c.end-1),249*300);
 c.setBars(bars(400,100),{reset:true});assert.equal(c.count,40);assert.equal(c.end,100);
});
