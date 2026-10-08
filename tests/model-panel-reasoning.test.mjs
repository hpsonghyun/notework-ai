import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../src/controller.mjs';

test('semantic build uses the same explicitly verified high reasoning as the selected model',async()=>{
  const file={path:'Research/source.md',stat:{size:40,mtime:1}};const inference=[];
  const controller=new ConnectionController({providers:{chatgpt:{generate:async(input,options)=>{inference.push({input,options});return '{"notes":[]}';}}},jev:{},secrets:{},vault:{getMarkdownFiles:()=>[file]},getTags:()=>[],settings:{mode:'chatgpt',reasoningEffort:'high',scope:{mode:'folders',include:['Research']},knowledge:{semanticRoute:'llm',embeddingRoute:'lexical'}},saveSettings:async()=>{},indexStore:{save:async()=>{}},knowledgeEngine:{build:async({llmCall,semanticModel})=>{await llmCall('Synthetic semantic classification',{model:semanticModel});return {id:'synthetic-index',nodes:[{id:'synthetic-node',path:file.path}],stats:{selectedNotes:1}};}}});
  controller.set({models:[{id:'gpt-6.1-sol',name:'Synthetic approved model',supportedReasoningEfforts:['low','high']}],model:'gpt-6.1-sol',reasoningEffort:'high',authenticated:true,verified:true,connection:'inference-confirmed'});
  await controller.buildKnowledge({consent:true});assert.equal(inference.length,1);assert.equal(inference[0].options.model,'gpt-6.1-sol');assert.equal(inference[0].options.reasoningEffort,'high','Build must not silently drop the user-selected effort');
});
