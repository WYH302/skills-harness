import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/core/store';
import {ModelAnalyzer,MINER_VERSION,type ModelBudget,type ModelTransport} from '../src/core/mining';
import {organizeProcedures} from '../src/core/organization-analysis';
import {discoverSkills} from '../src/core/skills';
import {Pipeline} from '../src/core/pipeline';
import {hash} from '../src/core/util';
import type {Conversation,Episode,Run,Settings,SourceId} from '../src/shared/types';

const zh=['明确用户需求和必须满足的约束。','读取官方文档，核实功能和限制。','交付比较报告，说明推荐理由和适用范围。'];
const en=['Clarify the user needs and mandatory constraints.','Read official documentation to verify capabilities and limitations.','Deliver a comparison report explaining the recommendation and its applicability.'];
function seed(store:Store,id:string,source:SourceId,steps:string[],extra:Partial<Episode>={}):{conversation:Conversation;episode:Episode}{
  const input:Conversation={source,externalId:id,title:'Public procedure fixture',messages:[{id:'u',role:'user',text:'Evaluate an open-source tool against the supplied requirements.'},{id:'a',role:'assistant',text:steps.join('\n')},{id:'done',role:'user',text:'That works. Use this approach.'}],completeness:'full',warnings:[]};
  const imported=store.import(input);const conversation=store.conversation(imported.id)!;
  const episode:Episode={id,conversationId:imported.id,source,goal:'Evaluate an open-source tool for a beginner',steps,inputs:['Tool link and requirements'],outputs:['Evidence-based comparison'],preferences:[],corrections:[],outcome:'accepted',evidence:steps.map(quote=>({messageId:'a',quote,kind:'step'})),contentHash:hash(conversation.messages),analysis:'model',executionEvidence:steps.length,scope:'general',outputLanguage:'source',updatedAt:'2026-10-29T00:00:00Z',...extra};
  store.setEpisodes(conversation,[episode]);return {conversation,episode};
}
function settings(store:Store,extra:Partial<Settings>={}):Settings{return store.saveSettings({analysisMode:'codex',model:'',skillOutputLanguage:'source',maxModelCalls:4,maxInputChars:100000,processingStrategy:'full',...extra});}
function run():Run{return {id:'fixture-run',outputLanguage:'source',status:'running',stage:'generating',startedAt:'2026-10-29T00:00:00Z',sources:['chatgpt','claude'],sourceProgress:{},episodes:2,skills:0,modelCalls:0,inputChars:0,cached:0,warnings:[]};}
function alignment(content:string):string {
  const cards=JSON.parse(content).episodes as {id:string;steps:{index:number;text:string}[]}[];
  return JSON.stringify({groups:[{episodeIds:cards.map(c=>c.id),steps:cards[0].steps.map((_,index)=>{const from=cards.map(c=>({episodeId:c.id,index}));return {use:from[0],from};})}]});
}
function analyzer(store:Store,s:Settings,budget:ModelBudget,transport:ModelTransport){return new ModelAnalyzer(s,budget,()=>'',undefined,transport,{get:key=>store.cache<string>(key),put:(key,raw)=>store.putCache(key,raw)});}
async function workspace(action:(store:Store)=>Promise<void>){const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-organization-'));const store=new Store(dir);try{await action(store);}finally{store.close();await rm(dir,{recursive:true,force:true});}}

test('semantic alignment uses the persisted shared budget and an unchanged cache sends nothing',async()=>workspace(async store=>{
  const a=seed(store,'a','chatgpt',zh),b=seed(store,'b','claude',en);let calls=0;const s=settings(store);
  const budget:ModelBudget={calls:1,inputChars:350,maxCalls:1,maxChars:100000,entries:[]};
  const transport:ModelTransport={id:'fixture',estimateInput:()=>1234,complete:async(_system,content)=>{calls++;return alignment(content);}};
  const model=analyzer(store,s,budget,transport),first=run();
  const partial=await organizeProcedures(store,first,s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  assert.equal(calls,0);assert.equal(first.organization!.pending,1);assert.equal(discoverSkills(store.episodes(),[],true,'source',partial).skills.length,2);
  budget.maxCalls=2;const resumed=run();const aligned=await organizeProcedures(store,resumed,s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  assert.equal(calls,1);assert.equal(budget.calls,2);assert.equal(budget.inputChars,1584);assert.equal(budget.entries![0].stage,'organization');
  assert.equal(resumed.organization!.pending,0);assert.equal(discoverSkills(store.episodes(),[],true,'source',aligned).skills.length,1);
  const repeated=run();const reused=await organizeProcedures(store,repeated,s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  assert.equal(calls,1);assert.equal(repeated.organization!.cached,1);assert.deepEqual(reused,aligned);
}));

test('only selected source evidence is sent and existing local alignment survives another selection',async()=>workspace(async store=>{
  const a=seed(store,'a','chatgpt',zh),b=seed(store,'b','claude',en);seed(store,'excluded','codex',['PRIVATE_FIXTURE_MARKER collect data.','PRIVATE_FIXTURE_MARKER inspect records.','PRIVATE_FIXTURE_MARKER report findings.']);
  const s=settings(store);let sent='';const transport:ModelTransport={id:'fixture',complete:async(_system,content)=>{sent=content;return alignment(content);}};
  const budget:ModelBudget={calls:0,inputChars:0,maxCalls:2,maxChars:100000};const model=analyzer(store,s,budget,transport);
  const result=await organizeProcedures(store,run(),s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  assert.ok(!sent.includes('PRIVATE_FIXTURE_MARKER'));assert.equal(result!.groups.length,1);
  const retained=await organizeProcedures(store,run(),s,model,store.episodes(),[],new AbortController().signal,()=>{});
  assert.deepEqual(retained,result);
  store.forget('derived');assert.equal(store.getMeta('procedureOrganization',null),null);
}));

test('new history with no remaining budget preserves valid prior merges and user edits',async()=>workspace(async store=>{
  const a=seed(store,'a','chatgpt',zh),b=seed(store,'b','claude',en),s=settings(store);
  const budget:ModelBudget={calls:0,inputChars:0,maxCalls:1,maxChars:100000};const model=analyzer(store,s,budget,{id:'fixture',complete:async(_system,content)=>alignment(content)});
  const first=await organizeProcedures(store,run(),s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  const previous=discoverSkills(store.episodes(),[],true,'source',first).skills;previous[0].userEdited=true;previous[0].markdown+='\nUser custom detail.\n';
  const c=seed(store,'c','chatgpt',[...en,'Record the additional maintenance requirement.']);const currentRun=run();
  const next=await organizeProcedures(store,currentRun,s,model,store.episodes(),[a.conversation,b.conversation,c.conversation],new AbortController().signal,()=>{});
  assert.equal(currentRun.organization!.pending,1);assert.deepEqual(next!.groups[0],first!.groups[0]);assert.ok(next!.groups.some(group=>group.episodeIds.length===1&&group.episodeIds[0]==='c'));
  const result=discoverSkills(store.episodes(),previous,true,'source',next).skills;
  assert.equal(result.find(skill=>skill.id===previous[0].id)!.markdown,previous[0].markdown);
}));

test('invalid and interrupted organization reserves cost without applying an invented mapping',async()=>workspace(async store=>{
  const a=seed(store,'a','chatgpt',zh),b=seed(store,'b','claude',en),s=settings(store);const budget:ModelBudget={calls:0,inputChars:0,maxCalls:2,maxChars:100000,entries:[]};
  const model=analyzer(store,s,budget,{id:'bad-fixture',complete:async()=>'{"groups":[]}'});const attempt=run();
  const result=await organizeProcedures(store,attempt,s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});
  assert.equal(attempt.organization!.pending,1);assert.equal(budget.calls,1);assert.equal(result!.groups.length,2);assert.ok(result!.groups.every(group=>group.episodeIds.length===1));
  assert.equal(discoverSkills(store.episodes(),[],true,'source',result).skills.length,2);
  await organizeProcedures(store,run(),s,model,store.episodes(),[a.conversation,b.conversation],new AbortController().signal,()=>{});assert.equal(budget.calls,1,'Invalid cached response is not paid for repeatedly');
  const aborter=new AbortController();const failing=analyzer(store,s,budget,{id:'aborted-fixture',complete:async()=>{aborter.abort();throw new Error('interrupted');}});
  await assert.rejects(()=>organizeProcedures(store,run(),s,failing,store.episodes(),[a.conversation,b.conversation],aborter.signal,()=>{}));
  assert.equal(budget.calls,2);assert.equal(budget.entries!.at(-1)!.status,'failed');
}));

test('the normal pipeline aligns bilingual methods and resumes without a new model call',async()=>workspace(async store=>{
  seed(store,'a','chatgpt',zh);seed(store,'b','claude',en);const s=settings(store);let calls=0;
  store.setMeta('analysisModeKey',hash([MINER_VERSION,s.analysisMode,s.model,s.endpoint,s.redactSensitive,s.generationConsentIdentity,s.analysisDetail,s.skillOutputLanguage]));
  const pipeline=new Pipeline(store,null,()=>{},()=>'',async function*(){},{requireModel:true,transport:async()=>({id:'pipeline-fixture',complete:async(_system,content)=>{calls++;return alignment(content);}})});
  pipeline.start({sources:['chatgpt','claude']});await pipeline.wait();assert.equal(pipeline.run!.status,'completed');assert.equal(store.skills().length,1);assert.equal(pipeline.run!.organization!.mergedGroups,1);assert.equal(pipeline.run!.modelCalls,1);
  pipeline.start({sources:['chatgpt','claude']});await pipeline.wait();assert.equal(calls,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(pipeline.run!.skills,0);assert.equal(pipeline.run!.organization!.cached,1);
}));

test('default selection reserves a share for organization instead of spending every call on extraction',async()=>workspace(async store=>{
  const workflows=[
    ['Reconcile warehouse inventory records',['Inspect SKU identifiers and preserve their leading zeros.','Compare warehouse quantities and quarantine contradictory counts.','Write the reconciliation ledger with missing inventory keys.']],
    ['Trace document research evidence',['Read primary study passages and record page references.','Separate observational associations from causal explanations.','Write the evidence table with contradictory study findings.']],
    ['Prepare a reader-focused writing revision',['Identify the intended audience and the purpose of the article.','Revise paragraph structure to keep each argument connected.','Deliver the revised article with a concise account of edits.']]
  ] as const;
  const records:Conversation[]=workflows.map(([goal,steps],i)=>({source:'chatgpt',externalId:`allocation-${i}`,title:goal,completeness:'full',warnings:[],messages:[{id:'u',role:'user',text:goal+' as my reusable procedure for future tasks.'},{id:'a',role:'assistant',text:steps.map((s,j)=>`${j+1}. ${s}`).join('\n')},{id:'ok',role:'user',text:'Approved, that works.'}]}));
  const calls:string[]=[];settings(store,{maxModelCalls:3,processingStrategy:'representative'});
  const transport:ModelTransport={id:'allocation-fixture',complete:async(_system,content)=>{
    const payload=JSON.parse(content);
    if(payload.episodes){calls.push('organization');return JSON.stringify({groups:payload.episodes.map((e:{id:string;steps:{index:number}[]})=>({episodeIds:[e.id],steps:e.steps.map(step=>({use:{episodeId:e.id,index:step.index},from:[{episodeId:e.id,index:step.index}]}))}))});}
    calls.push('extraction');const messages=payload.messages as {id:string;role:string;text:string}[];const answer=messages.find(m=>m.role==='assistant')!;
    return JSON.stringify({episodes:[{goal:messages.find(m=>m.role==='user')!.text,inputs:['Relevant task materials'],outputs:['Requested deliverable'],steps:answer.text.split('\n').map(line=>({text:line.replace(/^\d+\. /,''),messageId:answer.id,quote:line})),preferences:[],corrections:[],outcome:'accepted',scope:'general',quality:null}]});
  }};
  const pipeline=new Pipeline(store,null,()=>{},()=>'',async function*(){for(const conversation of records)yield {type:'conversation' as const,conversation};},{requireModel:true,transport:async()=>transport});
  pipeline.start({sources:['chatgpt']});await pipeline.wait();
  assert.equal(pipeline.run!.status,'completed');assert.deepEqual(calls,['extraction','extraction','organization']);assert.equal(pipeline.run!.modelCalls,3);assert.equal(pipeline.run!.organization!.pending,0);assert.equal(pipeline.run!.selection!.pendingGroups,1);assert.equal(store.skills().length,2);
}));
