import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverLocalSources } from '../src/adapters/discovery';
import { collectLocal, localRoots } from '../src/adapters/local';
import { BrowserBridge } from '../src/core/bridge';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { demoConversations } from '../src/core/demo-data';
import { cliTransport, ANALYSIS_SENTINEL } from '../src/core/generators';
import { extractEpisodes, modelView, ModelAnalyzer, modelFailure } from '../src/core/mining';
import { discoverSkills } from '../src/core/skills';
import { toolEnvironment } from '../src/core/commands';
import type { Conversation } from '../src/shared/types';

const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
async function temporary(){return mkdtemp(path.join(tmpdir(),'skillharbor-discovery-test-'));}
function log(project:string,text:string){return jsonl([{type:'session_meta',payload:{cwd:project}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}]);}

test('alternate user home and configured data directory work independently of launch location',async()=>{
  const dir=await temporary();const home=path.join(dir,'another-user');const custom=path.join(dir,'other-drive-data');
  await mkdir(path.join(custom,'sessions'),{recursive:true});await writeFile(path.join(custom,'sessions','fixture.jsonl'),jsonl([{type:'session_meta',payload:{cwd:dir,base_instructions:'large metadata '.repeat(14000)}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Read the selected document.'}]}}]));
  const options={home,environment:{CODEX_HOME:custom,CLAUDE_CONFIG_DIR:path.join(dir,'claude')}};
  assert.equal(localRoots(options).codex[0],path.join(custom,'sessions'));
  const sources=await discoverLocalSources(options);const codex=sources.find(source=>source.id==='codex')!;
  assert.equal(codex.available,true);assert.equal(codex.historyCount,1);assert.equal(codex.instances![0].state,'ready');
  const empty=await discoverLocalSources({home});assert.equal(empty.some(source=>source.available),false);
});

test('project-scoped collection reads metadata before importing messages from any other project',async()=>{
  const home=await temporary();const sessions=path.join(home,'.codex','sessions');const project=path.join(home,'selected-project');await mkdir(sessions,{recursive:true});
  await writeFile(path.join(sessions,'selected.jsonl'),log(project,'Selected project procedure.'));
  await writeFile(path.join(sessions,'other.jsonl'),log(path.join(home,'other-project'),'PRIVATE OTHER PROJECT'));
  await writeFile(path.join(sessions,'unknown.jsonl'),jsonl([{role:'user',content:'UNKNOWN PROJECT'}]));
  const found:Conversation[]=[];
  for await(const event of collectLocal('codex',{home,projectPath:project,signal:new AbortController().signal}))if(event.type==='conversation')found.push(event.conversation);
  assert.equal(found.length,1);assert.equal(found[0].messages[0].text,'Selected project procedure.');
});

test('a disconnected web source does not stall ready local history and an unchanged rerun uses the cache',async()=>{
  const store=new Store(await temporary());let collected:string[]=[];
  const collector:Collector=async function*(source){collected.push(source);yield {type:'conversation',conversation:{...demoConversations()[0],source}};};
  const pipeline=new Pipeline(store,null,()=>{},()=>'',collector,{availability:()=>[{id:'chatgpt',title:'ChatGPT',kind:'web',available:false,connected:false,mode:'import',detail:'Website login required'}]});
  try {
    pipeline.start({sources:['chatgpt','codex']});await pipeline.wait();assert.equal(pipeline.run!.status,'completed');assert.equal(pipeline.run!.sourceProgress.chatgpt!.status,'error');assert.equal(pipeline.run!.sourceProgress.codex!.imported,1);assert.deepEqual(collected,['codex']);assert.equal(store.skills().length,1);
    pipeline.start({sources:['chatgpt','codex']});await pipeline.wait();assert.equal(pipeline.run!.sourceProgress.codex!.skipped,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(pipeline.run!.skills,0);
  }finally{store.close();}
});

test('analysis calls require provider consent and generated analysis sessions never become new evidence',()=>{
  const settings=new StoreSettingsFixture();
  assert.throws(()=>cliTransport({executable:'never-run',option:{id:'codex',title:'Codex',kind:'codex',ready:true,status:'authenticated',privacy:'remote',consentIdentity:'expected',detail:'fixture'}},settings.value),/Consent/);
  const conversation={...demoConversations()[0],messages:[{id:'analysis',role:'user' as const,text:ANALYSIS_SENTINEL+'\nInternal analysis'},...demoConversations()[0].messages]};
  assert.deepEqual(extractEpisodes(conversation),[]);
  const previous=process.env.SKILLHARBOR_TEST_SECRET;process.env.SKILLHARBOR_TEST_SECRET='do-not-pass';try{assert.equal(toolEnvironment().SKILLHARBOR_TEST_SECRET,undefined);}finally{if(previous===undefined)delete process.env.SKILLHARBOR_TEST_SECRET;else process.env.SKILLHARBOR_TEST_SECRET=previous;}
});
class StoreSettingsFixture {value:import('../src/shared/types').Settings={language:'zh',analysisMode:'codex',endpoint:'http://127.0.0.1:11434/v1',model:'',apiKeySet:false,remoteConsent:false,maxModelCalls:3,maxInputChars:30000,maxOutputTokens:2200,incremental:true,redactSensitive:true,dataDir:'unused',autoConsolidate:true};}

test('focused analysis preserves exact excerpts across a long message, keeps originals, and discloses reductions',()=>{
  const source={...demoConversations()[0],messages:[{id:'long',role:'user' as const,text:'HEAD'+'.'.repeat(20000)+'TAIL'},{id:'tool',role:'system' as const,text:'system scaffold'},...demoConversations()[0].messages]};
  const view=modelView(source);assert.equal(view.excerpted,1);assert.equal(view.omitted,1);assert.ok(view.messages.some(message=>message.text.endsWith('TAIL')));assert.ok(view.messages.filter(message=>message.id==='long').every(message=>source.messages[0].text.includes(message.text)));assert.equal(source.messages[0].text.length,20008);assert.deepEqual(modelView(source,true).messages,source.messages);
});

test('a detailed executed model procedure can be an explicitly unverified candidate; a wishlist cannot',()=>{
  const episode=extractEpisodes({...demoConversations()[0],id:'fixture'})[0];
  const detailed={...episode,outcome:'unknown' as const,analysis:'model' as const,executionEvidence:5,inputs:['A public repository'],outputs:['A supported adoption decision']};
  const result=discoverSkills([detailed],[]);assert.equal(result.skills.length,1);assert.equal(result.skills[0].state,'candidate');assert.match(result.skills[0].validation.warnings.join(' '),/Single historical procedure/);
  assert.equal(discoverSkills([{...detailed,executionEvidence:0}],[]).skills.length,0);
});

test('focused coding evidence retains representative tool actions and failures within a bounded view',()=>{
  const tools=Array.from({length:12},(_,index)=>({id:`tool-${index}`,role:'tool' as const,text:index===6?'Error: targeted verification failed':`Tool step ${index}\n`+'.'.repeat(9000)}));
  const source={...demoConversations()[0],messages:[...demoConversations()[0].messages,...tools]};const view=modelView(source);
  assert.ok(view.messages.some(message=>message.id==='tool-0'));assert.ok(view.messages.some(message=>message.id==='tool-6'));assert.ok(view.messages.some(message=>message.id==='tool-11'));assert.ok(view.omitted>0);
  assert.ok(view.messages.filter(message=>message.role==='tool').reduce((sum,message)=>sum+message.text.length,0)<6500);
  assert.ok(view.messages.every(message=>source.messages.some(original=>original.id===message.id&&original.text.includes(message.text))));
});

test('private response caching permits deterministic revalidation with zero additional model calls',async()=>{
  const c={...demoConversations()[0],id:'cached-fixture'};const episode=extractEpisodes(c)[0];const assistant=c.messages.find(message=>message.role==='assistant')!;
  const response=JSON.stringify({episodes:[{goal:episode.goal,steps:episode.steps.map(text=>({text,messageId:assistant.id,quote:text})),inputs:episode.inputs,outputs:episode.outputs,outcome:'unknown'}]});
  const replies=new Map<string,string>();let calls=0;
  const transport={id:'fixture',complete:async()=>{calls++;return response;}};
  const store=new Store(await temporary());try{
    const settings={...store.settings(),analysisMode:'codex' as const};const cache={get:(key:string)=>replies.get(key),put:(key:string,value:string)=>{replies.set(key,value);}};
    const first=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:1,maxChars:30000},()=>'',undefined,transport,cache);assert.equal((await first.extract(c,new AbortController().signal)).length,1);
    const second=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:0,maxChars:0},()=>'',undefined,transport,cache);assert.equal((await second.extract(c,new AbortController().signal)).length,1);assert.equal(calls,1);assert.equal(second.budget.calls,0);
    assert.deepEqual(modelFailure(new Error('do not expose this private provider text')),{kind:'tool-or-connection'});
  }finally{store.close();}
});

test('browser profiles have separate statuses, command queues, and event authorization; selection persists',async()=>{
  const dir=await temporary();const store=new Store(dir);const bridge=new BrowserBridge(store);await bridge.start(0);const base=`http://127.0.0.1:${bridge.port}`;
  const headers={'Content-Type':'application/json','X-SkillHarbor-Client':'extension'};
  const pair=async(name:string)=>{const response=await fetch(base+'/pair',{method:'POST',headers,body:JSON.stringify({code:bridge.info().pairingCode,clientName:name})});assert.equal(response.status,200);return (await response.json() as {token:string}).token;};
  const poll=async(token:string)=>(await fetch(base+'/commands',{headers:{...headers,Authorization:`Bearer ${token}`}})).json() as Promise<{commands:{id:string;action?:string}[]}>;
  try {
    const first=await pair('Personal browser'),second=await pair('Work browser');
    for(const [token,connected] of [[first,true],[second,false]] as const)await fetch(base+'/status',{method:'POST',headers:{...headers,Authorization:`Bearer ${token}`},body:JSON.stringify({sources:[{id:'chatgpt',available:true,connected,mode:'automatic',detail:connected?'Signed in':'Login required'}]})});
    assert.equal(bridge.sourceStatuses()[0].connected,true);bridge.openSource('chatgpt');
    const commands=await poll(first);assert.equal(commands.commands.length,1);assert.equal(commands.commands[0].action,'open');assert.equal((await poll(second)).commands.length,0);
    const rejected=await fetch(base+'/events',{method:'POST',headers:{...headers,Authorization:`Bearer ${second}`},body:JSON.stringify({commandId:commands.commands[0].id,source:'chatgpt',type:'done'})});assert.equal(rejected.status,409);
    const chosen=bridge.info().clients!.find(client=>client.name==='Work browser')!.id;bridge.selectClient(chosen);assert.equal(bridge.sourceStatuses()[0].connected,false);assert.equal(bridge.info().selectedClientId,chosen);
    const restored=new BrowserBridge(store);assert.equal(restored.info().selectedClientId,chosen);assert.equal(restored.info().paired,false);
  }finally{await bridge.close();store.close();}
});
