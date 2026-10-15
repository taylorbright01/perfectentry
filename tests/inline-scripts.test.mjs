import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {spawnSync} from 'node:child_process';
test('modified signal/performance pages retain parseable scripts in their actual module/classic mode',async()=>{
 for(const name of ['signals.html','currencyai.html','counterfactual.html','wheel.html','network.html','0-1m.html','screener.html']){
  const source=await readFile(new URL('../'+name,import.meta.url),'utf8');
  for(const match of source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
   if(!match[2].trim()||match[1].includes('ld+json'))continue;
   const mode=/type\s*=\s*["']module["']/.test(match[1])?'module':'commonjs';
   const result=spawnSync(process.execPath,['--input-type='+mode,'--check'],{input:match[2],encoding:'utf8'});assert.equal(result.status,0,name+': '+result.stderr);
  }
 }
});
