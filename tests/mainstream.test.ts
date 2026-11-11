import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PRODUCTS, MAIN_ASSISTANTS, API_PRESETS, matchesProduct, resolveSource, sourceName } from '../src/shared/catalog';
import { SOURCE_IDS, IMPORT_SOURCES } from '../src/shared/types';
import { localizeNotice, resolveOutputLanguage } from '../src/shared/localization';
import { parseHistoryJSON, parseHistoryText } from '../src/adapters/import';
import { Store, defaultSettings } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { ModelAnalyzer, procedureSteps, MINER_VERSION } from '../src/core/mining';
import { discoverSkills } from '../src/core/skills';
import { demoConversations } from '../src/core/demo-data';
import { normalizeConversation, hash } from '../src/core/util';
import { SELECTION_VERSION, selectMaterials } from '../src/core/selection';

test('mainstream catalog has unique products, bilingual aliases, and distinct Copilot products',()=>{
  assert.equal(PRODUCTS.length,22);assert.deepEqual(new Set(PRODUCTS.map(p=>p.id)),new Set(SOURCE_IDS));assert.equal(MAIN_ASSISTANTS.length,10);assert.equal(MAIN_ASSISTANTS.filter(id=>id==='chatgpt').length,1);
  assert.equal(resolveSource('豆包'),'doubao');assert.equal(resolveSource('QWEN'),'qwen');assert.equal(resolveSource('通义千问'),'qwen');assert.equal(resolveSource('Copilot'),'copilot');assert.equal(resolveSource('GitHub Copilot'),'github-copilot');assert.equal(resolveSource('谷歌反重力'),'antigravity');assert.equal(resolveSource('OpenClaw'),'openclaw');assert.equal(resolveSource('Hermes'),'hermes');assert.equal(resolveSource('DeepSeek Harness'),'deepseek-harness');assert.equal(sourceName('qwen','en'),'Qwen');assert.ok(matchesProduct('qwen','千问'));assert.ok(matchesProduct('doubao','Doubao'));assert.ok(matchesProduct('antigravity','反重力'));
});
test('every added source imports real role-labeled files without claiming automatic collection or completeness',()=>{
  for(const id of IMPORT_SOURCES){const sample={source:id,id:'sample',messages:[{role:'用户',content:'请解释这个工作方法。'},{role:'assistant',content:'先确认输入，再比较证据，最后记录结论。'}]};const [c]=parseHistoryJSON(sample);assert.equal(c.source,id);assert.equal(c.messages.length,2);assert.equal(c.messages[0].text,sample.messages[0].content);assert.equal(c.completeness,'unknown');}
  const [qwen]=parseHistoryJSON({source:'千问',messages:[{role:'user',content:'源文本'},{role:'assistant',content:'回答原文'}]});assert.equal(qwen.source,'qwen');
  const [text]=parseHistoryText('## 用户\n请评估工具。\n## 豆包\n先核对输入，再比较证据，最后给出结论。','capture.md','doubao');assert.equal(text.messages[1].role,'assistant');assert.equal(text.completeness,'partial');
});
test('API catalog contains explicit separate endpoints and region choices',()=>{
  assert.equal(new Set(API_PRESETS.map(p=>p.id)).size,API_PRESETS.length);assert.ok(API_PRESETS.every(p=>new URL(p.endpoint).protocol==='https:'));assert.notEqual(API_PRESETS.find(p=>p.id==='qwen-cn')?.endpoint,API_PRESETS.find(p=>p.id==='qwen-intl')?.endpoint);assert.ok(API_PRESETS.find(p=>p.brand==='doubao')?.manualModel);assert.equal(API_PRESETS.find(p=>p.id==='perplexity')?.endpoint,'https://api.perplexity.ai/orchestrator/v1');
});
test('output language resolves independently and trusted notices select the requested interface language',()=>{
  const base={...defaultSettings,dataDir:'/fixture'};assert.equal(resolveOutputLanguage({...base,language:'en',skillOutputLanguage:'zh'}),'zh');assert.equal(resolveOutputLanguage({...base,language:'zh',skillOutputLanguage:'en'}),'en');assert.equal(resolveOutputLanguage({...base,language:'en',skillOutputLanguage:'source'}),'source');assert.equal(resolveOutputLanguage({...base,language:'en',skillOutputLanguage:'interface'}),'en');
  assert.equal(localizeNotice('连接失败 / Connection failed','en'),'Connection failed');assert.equal(localizeNotice('Connection failed / 连接失败','zh'),'连接失败');assert.equal(localizeNotice('Select at least one source','zh'),'请至少选择一个历史来源。');
});
test('English skill generation retains Chinese original quotes and uses English structural sections',async()=>{
  const c=normalizeConversation(demoConversations()[0]),quotes=procedureSteps(c.messages[1].text);let system='';
  const model=new ModelAnalyzer({...defaultSettings,dataDir:'/fixture',analysisMode:'codex',skillOutputLanguage:'en'},{calls:0,inputChars:0,maxCalls:1,maxChars:30000},()=>'',undefined,{id:'fixture-only',complete:async(s)=>{system=s;return JSON.stringify({episodes:[{goal:'Evaluate whether an open-source tool is worth adopting for a beginner using documented evidence and costs',inputs:['Repository and use case'],outputs:['Evidence report and recommendation'],steps:quotes.map((q,i)=>({text:['Clarify intended use and installation limits.','Read repository documentation and the license.','Distinguish claimed features from supported capabilities.','Compare configuration and maintenance requirements.','Recommend adoption with explicit unverified capabilities.'][i],messageId:'procedure',quote:q})),preferences:[],corrections:[],outcome:'accepted',scope:'general',quality:null}]});}});
  const episodes=await model.extract(c,new AbortController().signal);assert.match(system,/Write generated goals.*in English/);assert.equal(episodes[0].outputLanguage,'en');assert.equal(episodes[0].steps.length,5);assert.deepEqual(episodes[0].evidence.map(e=>e.quote),quotes);const result=discoverSkills(episodes,[],true,'en');assert.equal(result.skills.length,1);assert.equal(result.skills[0].title,episodes[0].goal);assert.match(result.skills[0].markdown,/## When to use/);assert.match(result.skills[0].markdown,/## Procedure/);assert.ok(!/[\p{Script=Han}]/u.test(result.skills[0].markdown));assert.equal(c.messages[0].text,demoConversations()[0].messages[0].text);
});
test('switching interface language while collecting cannot change a pinned output language or restart work',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-language-'));const store=new Store(directory);store.saveSettings({language:'zh',skillOutputLanguage:'interface'});let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const collect:Collector=async function*(){await gate;yield {type:'conversation',conversation:demoConversations()[0]};};const pipeline=new Pipeline(store,null,()=>{},()=>'',collect);
  try{const run=pipeline.start({sources:['chatgpt']});const id=run.id;store.saveSettings({language:'en'});release();await pipeline.wait();assert.equal(pipeline.run!.id,id);assert.equal(pipeline.run!.outputLanguage,'zh');assert.equal(pipeline.run!.modelCalls,0);assert.equal(store.settings().language,'en');assert.equal(store.conversations()[0].messages[0].text,demoConversations()[0].messages[0].text);assert.match(store.skills()[0].markdown,/## 触发条件/);assert.ok(!store.skills()[0].markdown.includes('## When to use'));}finally{release();store.close();}
});
test('import-only sources reuse imported evidence and never enter the browser or local collector',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-import-only-'));const store=new Store(directory);store.import({...demoConversations()[0],source:'doubao'});const pipeline=new Pipeline(store,null,()=>{},()=>'',undefined,{requireModel:true});
  try{pipeline.start({sources:['doubao']});await pipeline.wait();assert.equal(pipeline.run!.sourceProgress.doubao!.status,'done');assert.equal(pipeline.run!.sourceProgress.doubao!.skipped,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(store.skills().length,0);}finally{store.close();}
});
test('upgrading the language setting reuses compatible legacy representative results without another model call',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'skillharbor-language-cache-')),store=new Store(directory);store.saveSettings({language:'zh',skillOutputLanguage:'source',analysisMode:'codex'});const c=normalizeConversation(demoConversations()[0]);store.import(c);const plan=await selectMaterials([c],new AbortController().signal);const group=plan.groups[0];const settings=store.settings();const legacy=hash([SELECTION_VERSION,MINER_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.redactSensitive,settings.generationConsentIdentity,settings.maxOutputTokens]);
  const sourceQuotes=procedureSteps(c.messages[1].text);store.putCache('representatives:'+hash([legacy,group.id]),[{id:'prior-public-episode',conversationId:c.id,source:c.source,goal:'面向新手评估开源工具是否值得采用',inputs:['仓库与用途'],outputs:['比较与建议'],steps:sourceQuotes,preferences:[],corrections:[],outcome:'accepted',evidence:sourceQuotes.map(q=>({messageId:'procedure',conversationId:c.id,quote:q})),executionEvidence:5,contentHash:'fixture',analysis:'model',scope:'general',updatedAt:'2026-10-28T00:00:00Z'}]);let calls=0;const pipeline=new Pipeline(store,null,()=>{},()=>'',undefined,{requireModel:true,transport:async()=>({id:'fixture',complete:async()=>{calls++;throw new Error('Legacy reuse must not call the model');}})});
  try{pipeline.start({sources:['chatgpt']},undefined,true);await pipeline.wait();assert.equal(calls,0);assert.equal(pipeline.run!.selection!.cachedGroups,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(store.skills().length,1);}finally{store.close();}
});
