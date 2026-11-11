import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelAnalyzer } from '../src/core/mining';
import { defaultSettings } from '../src/core/store';
import { normalizeConversation } from '../src/core/util';

const steps=['Normalize each identifier while preserving its case and leading zeros.','Deduplicate identical inventory rows before considering quantity conflicts.','Quarantine conflicting quantities instead of choosing the newest record.'];
const conversation=normalizeConversation({source:'chatgpt',externalId:'synthetic-domain-verbs',title:'Synthetic inventory reconciliation',completeness:'full',warnings:[],messages:[{id:'u',role:'user',text:'Reconcile this inventory export and provide a disposition ledger.'},{id:'a',role:'assistant',text:steps.join('\n')},{id:'ok',role:'user',text:'Approved, that works.'}]});
const response=(quotes=steps)=>({episodes:[{goal:'Reconcile inventory exports with a traceable disposition ledger',inputs:['Inventory export'],outputs:['Disposition ledger'],steps:steps.map((text,i)=>({text,messageId:'a',quote:quotes[i]})),preferences:[],corrections:[],outcome:'accepted',scope:'general',quality:null}]});
function model(raw:unknown){return new ModelAnalyzer({...defaultSettings,dataDir:'unused',analysisMode:'codex',skillOutputLanguage:'en'},{calls:0,inputChars:0,maxCalls:1,maxChars:20000},()=>'',undefined,{id:'test',complete:async()=>JSON.stringify(raw)});}
test('evidenced model procedures retain domain verbs outside the local extraction whitelist',async()=>{
  const episodes=await model(response()).extract(conversation,new AbortController().signal,true);
  assert.deepEqual(episodes[0].steps,steps);assert.equal(episodes[0].executionEvidence,3);assert.equal(episodes[0].outcome,'accepted');
});
test('removing verb whitelist does not permit unsupported quotes or generic advice',async()=>{
  await assert.rejects(model(response(['This quote never existed.',steps[1],steps[2]])).extract(conversation,new AbortController().signal,true),/unsupported evidence/);
  const raw=response();raw.episodes[0].steps=steps.map(quote=>({text:'Follow best practices.',messageId:'a',quote}));
  const episodes=await model(raw).extract(conversation,new AbortController().signal,true);assert.equal(episodes[0].steps.length,0);assert.equal(episodes[0].executionEvidence,0);
});
