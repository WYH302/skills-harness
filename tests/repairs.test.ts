import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { demoConversations } from '../src/core/demo-data';
import { extractEpisodes, ModelAnalyzer } from '../src/core/mining';
import { discoverSkills, reconcileSkills } from '../src/core/skills';
import { credentialFor, consentForSettings, endpointIdentity } from '../src/core/credentials';
import { normalizeConversation } from '../src/core/util';
import { BrowserBridge } from '../src/core/bridge';
import type { Episode } from '../src/shared/types';

async function fixture(){return new Store(await mkdtemp(path.join(tmpdir(),'skillharbor-repair-')));}
test('provider credentials and transfer consent are bound to endpoint and mode',async()=>{
  const store=await fixture();const settings={...store.settings(),analysisMode:'remote' as const,endpoint:'https://one.example/v1',remoteConsent:true,remoteConsentEndpoint:'https://one.example/v1'};
  const bound={endpoint:settings.endpoint,mode:'remote' as const,key:'fixture-private-key'};
  assert.equal(credentialFor(bound,settings),'fixture-private-key');
  assert.equal(credentialFor(bound,{...settings,endpoint:'https://two.example/v1'}),'');
  assert.equal(credentialFor(bound,{...settings,analysisMode:'local',endpoint:'http://127.0.0.1:11434/v1'}),'');
  assert.equal(consentForSettings(settings,{endpoint:'https://two.example/v1',remoteConsent:true}).remoteConsent,false);
  assert.equal(consentForSettings(settings,{endpoint:'https://two.example/v1',remoteConsent:true},'https://two.example/v1').remoteConsent,true);
  assert.equal(consentForSettings(settings,{language:'en'}).remoteConsent,true);
  assert.equal(consentForSettings(settings,{analysisMode:'local'}).remoteConsent,false);store.close();
});
test('clearing analysis cache preserves source evidence, user edits and all versions',async()=>{
  const store=await fixture();const c=normalizeConversation(demoConversations()[0]);store.import(c);store.setEpisodes(c,extractEpisodes(c));const generated=discoverSkills(store.episodes(),[]).skills[0];store.saveSkill(generated);const edited=store.saveSkill({...generated,markdown:generated.markdown+'\nUser note.\n',userEdited:true});store.putCache('fixture-cache',{value:1});
  store.forget('derived');assert.equal(store.skill(edited.id).markdown,edited.markdown);assert.equal(store.versions(edited.id).length,2);assert.equal(store.stats().episodes,1);assert.equal(store.cache('fixture-cache'),undefined);assert.equal(store.conversations(true).length,1);store.close();
});
test('interrupted state, imported history and analysis cache survive reopening the library',async()=>{
  const original=await fixture();const dir=original.dir;original.import(demoConversations()[0]);original.putCache('completed-chunk',[{completed:true}]);
  original.saveRun({id:'interrupted-fixture',status:'running',stage:'analyzing',startedAt:new Date().toISOString(),sources:['chatgpt'],sourceProgress:{},episodes:0,skills:0,modelCalls:1,inputChars:100,cached:0,warnings:[]});original.close();
  const reopened=new Store(dir);assert.equal(reopened.latestRun()!.status,'interrupted');assert.equal(reopened.stats().conversations,1);assert.deepEqual(reopened.cache('completed-chunk'),[{completed:true}]);assert.equal(reopened.import(demoConversations()[0]).status,'skipped');reopened.close();
});
test('splitting incompatible procedures claims an existing identity only once',()=>{
  const e1=extractEpisodes(normalizeConversation(demoConversations()[0]))[0];const e2={...e1,id:'different-episode',conversationId:'different-conversation'};
  const prior=discoverSkills([e1,e2],[]).skills;assert.equal(prior.length,1);
  const second=extractEpisodes(normalizeConversation(demoConversations()[2]))[0];
  const split=discoverSkills([e1,{...second,id:e2.id,conversationId:e2.conversationId}],prior).skills;assert.equal(split.length,2);assert.equal(new Set(split.map(s=>s.id)).size,2);assert.equal(new Set(split.map(s=>s.name)).size,2);
});
test('newly rejected evidence disables stale generated skills while preserving their content',()=>{
  const e=extractEpisodes(normalizeConversation(demoConversations()[0]))[0];const s={...discoverSkills([e],[]).skills[0],enabled:true,state:'active' as const};
  const reconciled=reconcileSkills([s],[],[{...e,outcome:'failed'}]);assert.equal(reconciled.length,1);assert.equal(reconciled[0].enabled,false);assert.equal(reconciled[0].validation.valid,false);assert.equal(reconciled[0].markdown,s.markdown);
});
test('unrelated Chinese preferences are not counted as repeated requirements',()=>{
  const base=extractEpisodes(normalizeConversation(demoConversations()[0]))[0];
  const e1={...base,preferences:['我偏好中文输出。']};const e2={...base,id:'ep2',conversationId:'c2',preferences:['我偏好简短段落。']};
  const s=discoverSkills([e1,e2],[]).skills[0];assert.ok(!s.markdown.includes('我偏好中文输出'));assert.ok(!s.markdown.includes('我偏好简短段落'));
});
test('project-specific episodes without shared project identity remain separate',()=>{
  const base={...extractEpisodes(normalizeConversation(demoConversations()[0]))[0],scope:'project' as const};
  const second={...base,id:'other-project-episode',conversationId:'other-project-conversation'};
  const skills=discoverSkills([base,second],[]).skills;assert.equal(skills.length,2);assert.equal(new Set(skills.map(s=>s.name)).size,2);
});
test('chunk cache resumes paid analysis after budget interruption without repeating completed calls',async()=>{
  const store=await fixture();let calls=0;
  const server=createServer(async(req,res)=>{calls++;const pieces:Buffer[]=[];for await(const piece of req)pieces.push(piece);const body=JSON.parse(Buffer.concat(pieces).toString());const chunk=JSON.parse(body.messages[1].content);const assistant=chunk.messages.find((m:{role:string})=>m.role==='assistant');
    const steps=assistant?['先确认用户的实际用途、已有工具和能接受的安装维护成本。','读取仓库说明、许可证和最近的发布记录，记录每一项判断的公开来源。','区分仓库宣称的功能与实际文档或运行记录能够支持的功能。'].map(text=>({text,messageId:assistant.id,quote:text})):[];
    const episodes=assistant?[{goal:'面向新手评估一个开源工具是否值得采用',steps,inputs:[],outputs:[],preferences:[],corrections:[],outcome:'accepted',scope:'general'}]:[];
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({episodes})}}]}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const c=normalizeConversation(demoConversations()[0]);c.messages[0].text+='\n'+'z'.repeat(45000);
    const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const settings={...store.settings(),analysisMode:'local' as const,analysisDetail:'full' as const,endpoint,model:'fixture-model'};
    const cache={get:(key:string)=>store.cache<Episode[]>(key),put:(key:string,value:Episode[])=>store.putCache(key,value)};
    const first=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:1,maxChars:1000000},()=>'',cache);await assert.rejects(first.extract(c,new AbortController().signal),/budget/);assert.equal(calls,1);
    const resumed=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:5,maxChars:1000000},()=>'',cache);const result=await resumed.extract(c,new AbortController().signal);assert.ok(result.length>0);assert.equal(calls,3);assert.equal(resumed.budget.calls,2);
    const complete=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:0,maxChars:0},()=>'',cache);await complete.extract(c,new AbortController().signal);assert.equal(calls,3);
  } finally {await new Promise<void>(r=>server.close(()=>r()));store.close();}
});
test('pipeline retains failed-source checkpoints and counts local failure/skip deltas',async()=>{
  const store=await fixture();const collector:Collector=async function*(source){if(source==='codex'){yield {type:'checkpoint',cursor:'recover-me'};yield {type:'progress',failed:1};yield {type:'progress',failed:1};yield {type:'progress',skipped:1};yield {type:'progress',skipped:1};throw new Error('fixture failed');}yield {type:'checkpoint',cursor:'success'};};
  const p=new Pipeline(store,null,()=>{},()=>'',collector);p.start({sources:['codex','claude-code','codex']});await p.wait();assert.equal(store.checkpoint('codex'),'recover-me');assert.equal(store.checkpoint('claude-code'),undefined);assert.equal(p.run!.sourceProgress.codex!.failed,3);assert.equal(p.run!.sourceProgress.codex!.skipped,2);store.close();
});
test('loopback bridge rejects foreign origins, incorrect code, wrong command sources and missing bearer',async()=>{
  const store=await fixture();const bridge=new BrowserBridge(store);await bridge.start(0);const base=`http://127.0.0.1:${bridge.port}`;const headers={'Content-Type':'application/json',Origin:'chrome-extension://'+'a'.repeat(32)};
  try {
    assert.equal((await fetch(base+'/commands',{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await fetch(base+'/commands',{headers})).status,401);
    assert.equal((await fetch(base+'/pair',{method:'POST',headers,body:JSON.stringify({code:'bad'})})).status,401);
    const paired=await fetch(base+'/pair',{method:'POST',headers,body:JSON.stringify({code:bridge.info().pairingCode,clientName:'fixture'})});assert.equal(paired.status,200);const {token}=await paired.json() as {token:string};
    const authorized={...headers,Authorization:`Bearer ${token}`};const ac=new AbortController();const iterator=bridge.collect('chatgpt',{signal:ac.signal});const pending=iterator.next().catch(()=>undefined);
    const commands=await fetch(base+'/commands',{headers:authorized}).then(r=>r.json()) as {commands:{id:string}[]};assert.equal(commands.commands.length,1);
    const response=await fetch(base+'/events',{method:'POST',headers:authorized,body:JSON.stringify({commandId:commands.commands[0].id,source:'claude',type:'done'})});assert.equal(response.status,409);ac.abort();await pending;
  } finally {await bridge.close();store.close();}
});
