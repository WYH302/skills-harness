import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { demoConversations } from '../src/core/demo-data';
import { extractEpisodes } from '../src/core/mining';
import { discoverSkills } from '../src/core/skills';
import { hash, normalizeConversation } from '../src/core/util';
import { parseCollectionPreferences } from '../src/renderer/preferences';

async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-experience-'));return {dir,store:new Store(dir)};}

test('paused file import resumes the original file after reopening, without contacting a source collector',async()=>{
  const {dir,store}=await fixture();const file=path.join(dir,'synthetic.json');await writeFile(file,JSON.stringify(demoConversations().slice(0,2)));
  let stopped=false;let pipeline:Pipeline;
  pipeline=new Pipeline(store,null,()=>{if(!stopped&&pipeline?.run?.stage==='collecting'&&store.stats().conversations===1){stopped=true;pipeline.cancel();}});
  pipeline.start({sources:[]},{path:file});await pipeline.wait();assert.equal(pipeline.run!.status,'cancelled');assert.equal(pipeline.run!.input,'import');assert.equal(pipeline.run!.collectionComplete,false);store.close();
  const reopened=new Store(dir);let collectorCalls=0;const collector:Collector=async function*(){collectorCalls++;throw new Error('Must not contact the website');};
  try {
    const resumed=new Pipeline(reopened,null,()=>{},()=>'',collector);resumed.resume();await resumed.wait();
    assert.equal(resumed.run!.status,'completed');assert.equal(reopened.stats().conversations,2);assert.ok(reopened.skills().length>0);assert.equal(collectorCalls,0);
  }finally{reopened.close();}
});

test('missing original file during incomplete import yields a recovery message instead of website fallback',async()=>{
  const {dir,store}=await fixture();const file=path.join(dir,'missing-later.json');await writeFile(file,JSON.stringify(demoConversations().slice(0,2)));
  let pipeline:Pipeline;pipeline=new Pipeline(store,null,()=>{if(pipeline?.run?.stage==='collecting'&&store.stats().conversations===1)pipeline.cancel();});
  try {
    pipeline.start({sources:[]},{path:file});await pipeline.wait();const previous=pipeline.run!.id;await unlink(file);
    assert.throws(()=>pipeline.resume(),/原导入文件不可用/);assert.equal(pipeline.run!.id,previous);assert.equal(store.stats().conversations,1);
  }finally{store.close();}
});

test('model budget remainder resumes analysis from stored history even after the original export is gone',async()=>{
  const {dir,store}=await fixture();const file=path.join(dir,'synthetic.json');await writeFile(file,JSON.stringify([demoConversations()[0]]));
  let collectorCalls=0;const collector:Collector=async function*(){collectorCalls++;throw new Error('Unexpected collector');};
  try {
    store.saveSettings({analysisMode:'local',model:'fixture',maxModelCalls:0});
    const pipeline=new Pipeline(store,null,()=>{},()=>'',collector);pipeline.start({sources:[]},{path:file});await pipeline.wait();
    assert.equal(pipeline.run!.status,'completed');assert.equal(pipeline.run!.pendingAnalysis,1);assert.equal(pipeline.run!.collectionComplete,true);assert.equal(pipeline.run!.modelCalls,0);
    await unlink(file);store.saveSettings({analysisMode:'extractive'});pipeline.resume({analysisOnly:true});await pipeline.wait();
    assert.equal(pipeline.run!.status,'completed');assert.equal(pipeline.run!.input,'analysis');assert.equal(pipeline.run!.pendingAnalysis,0);assert.equal(collectorCalls,0);assert.equal(store.skills().length,1);
  }finally{store.close();}
});

test('cancelling an in-flight model request preserves the actual call/input accounting and pending work',async()=>{
  const {store}=await fixture();let reached!:()=>void;const requestStarted=new Promise<void>(resolve=>{reached=resolve;});
  const server=createServer(async(req,res)=>{for await(const _ of req){}reached();res.on('error',()=>{});});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    store.saveSettings({analysisMode:'local',model:'fixture',endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`});
    const collector:Collector=async function*(){yield {type:'conversation',conversation:demoConversations()[0]};};
    const pipeline=new Pipeline(store,null,()=>{},()=>'',collector);pipeline.start({sources:['chatgpt']});await requestStarted;pipeline.cancel();await pipeline.wait();
    assert.equal(pipeline.run!.status,'cancelled');assert.equal(pipeline.run!.modelCalls,1);assert.ok(pipeline.run!.inputChars>0);assert.equal(pipeline.run!.pendingAnalysis,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

test('retrying failed sources retains the original date range and avoids successful sources',async()=>{
  const {store}=await fixture();const seen:{source:string;from?:string;to?:string}[]=[];let fail=true;
  const collector:Collector=async function*(source,options){seen.push({source,from:options.dateFrom,to:options.dateTo});if(source==='claude'&&fail)throw new Error('Temporary fixture failure');};
  try {
    const pipeline=new Pipeline(store,null,()=>{},()=>'',collector);pipeline.start({sources:['chatgpt','claude'],dateFrom:'2026-01-01',dateTo:'2026-10-01'});await pipeline.wait();
    fail=false;pipeline.resume({failedOnly:true});await pipeline.wait();assert.equal(pipeline.run!.status,'completed');
    assert.deepEqual(seen.map(row=>row.source),['chatgpt','claude','claude']);assert.deepEqual(seen[2],{source:'claude',from:'2026-01-01',to:'2026-10-01'});
  }finally{store.close();}
});

test('unchanged runs report zero created/updated skills while preserving the supported library',async()=>{
  const {store}=await fixture();const collector:Collector=async function*(){yield {type:'conversation',conversation:demoConversations()[0]};};
  try {
    const pipeline=new Pipeline(store,null,()=>{},()=>'',collector);pipeline.start({sources:['chatgpt']});await pipeline.wait();assert.equal(pipeline.run!.skills,1);
    pipeline.start({sources:['chatgpt']});await pipeline.wait();assert.equal(pipeline.run!.skills,0);assert.equal(pipeline.run!.supportedSkills,1);assert.equal(pipeline.run!.processedConversations,0);assert.equal(store.skills()[0].version,1);
  }finally{store.close();}
});

test('dismissed revisions do not repeat; materially new evidence can propose a revision again',async()=>{
  const {store}=await fixture();
  try {
    const episode=extractEpisodes(normalizeConversation(demoConversations()[0]))[0];const generated=discoverSkills([episode],[]).skills[0];const saved=store.saveSkill(generated);
    const edited=store.saveSkill({...saved,markdown:saved.markdown+'\nPersonal note remains.\n',userEdited:true});
    const proposal=discoverSkills([episode],[edited]).skills[0];assert.ok(proposal.proposedRevision);
    const dismissed=store.saveSkill({...proposal,proposedRevision:undefined,dismissedRevisionHash:hash(proposal.proposedRevision!)});
    const unchanged=discoverSkills([episode],[dismissed]).skills[0];assert.equal(unchanged.proposedRevision,undefined);assert.equal(unchanged.markdown,edited.markdown);assert.equal(store.versions(saved.id).length,2);
    const additional={...episode,id:'new-evidence',conversationId:'new-conversation'};
    const updated=discoverSkills([episode,additional],[unchanged]).skills[0];assert.ok(updated.proposedRevision);assert.equal(updated.markdown,edited.markdown);
  }finally{store.close();}
});

test('erasing imported history also removes the saved recovery file path',async()=>{
  const {store}=await fixture();
  try {store.setMeta('lastImport',{runId:'fixture',file:{path:'synthetic-only.json'}});store.forget('history');assert.equal(store.getMeta('lastImport',null),null);}finally{store.close();}
});

test('saved source/date preferences accept only known sources and ignore unrelated sensitive fields',()=>{
  assert.deepEqual(parseCollectionPreferences(JSON.stringify({sources:['codex','unknown','codex','claude'],range:true,from:'2026-01-01',to:'bad',apiKey:'not-to-be-saved'})),{sources:['codex','claude'],range:true,from:'2026-01-01',to:''});
  for(const raw of [null,'bad','null','{}','{"sources":null}'])assert.equal(parseCollectionPreferences(raw),undefined);
  assert.deepEqual(parseCollectionPreferences('{"sources":[],"range":"true"}'),{sources:[],range:false,from:'',to:''});
});
