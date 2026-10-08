import test from 'node:test';
import assert from 'node:assert/strict';
import {embeddingRecommendations,connectionSetupGuide} from '../src/setup-guide.mjs';
test('recommendations use measured desktop RAM and keep installed status unknown until catalog discovery',()=>{
  const small=embeddingRecommendations({hardware:{ramGiB:'3.0',freeGiB:'1.0',threads:2}});assert.equal(small.hardwareMeasured,true);assert.equal(small.recommendedId,'all-minilm:latest');assert(small.hardwareSummary.includes('3.0 GiB'));assert(small.models.every(item=>item.installed===null));
  const large=embeddingRecommendations({hardware:{totalmem:16*2**30}});assert.equal(large.recommendedId,'embeddinggemma:latest');assert.equal(large.hardwareMeasured,true);
  const unknown=embeddingRecommendations();assert.equal(unknown.hardwareMeasured,false);assert(unknown.reason.includes('Check this computer'));
});
test('catalog recommendations cannot pretend chat capability is installed embedding support',()=>{
  const result=embeddingRecommendations({installedModels:[{id:'embeddinggemma:latest',capabilities:['completion']},{id:'qwen3-embedding:0.6b',capabilities:['embedding']}]});assert.equal(result.models.find(item=>item.id==='embeddinggemma:latest').installed,false);assert.equal(result.models.find(item=>item.id==='qwen3-embedding:0.6b').installed,true);assert(result.models.every(item=>item.sourceUrl.startsWith('https://ollama.com/library/')));
});
test('mobile recommendations disable local download and guide separates answer API, embeddings and optional Jev',()=>{
  const mobile=embeddingRecommendations({desktop:false,hardware:{ramGiB:16}});assert.equal(mobile.available,false);assert.equal(mobile.recommendedId,null);assert(mobile.models.every(item=>!item.recommended));
  const steps=connectionSetupGuide({desktop:false});assert.deepEqual(steps.map(step=>step.id),['llm','embedding','jev','knowledge']);assert.equal(steps.find(step=>step.id==='jev').required,false);assert(steps[0].description.includes('your own'));assert(steps[1].description.includes('keyword'));assert(steps[2].description.includes('own API key'));assert(embeddingRecommendations().cost.includes('no per-call API billing'));
});
