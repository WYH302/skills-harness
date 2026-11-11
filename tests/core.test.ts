import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { demoConversations } from '../src/core/demo-data';
import { extractEpisodes, ModelAnalyzer } from '../src/core/mining';
import { validateSkill, discoverSkills, routeSkills } from '../src/core/skills';
import { exportSkills, detectDestinations, installSkill } from '../src/core/delivery';
import { selectMaterials } from '../src/core/selection';
import { assertSafeUrl, normalizeConversation, redact } from '../src/core/util';

async function fixture(){const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-core-'));const store=new Store(dir);return {dir,store};}
test('full pipeline rejects topics/one-time tasks, combines procedures across sources, and is incremental',async()=>{
  const {store}=await fixture();let extra=false;
  const collector:Collector=async function*(source){for(const conversation of demoConversations(extra).filter(c=>c.source===source))yield {type:'conversation',conversation};};
  const p=new Pipeline(store,null,()=>{},()=>'',collector);
  const sources=demoConversations().map(c=>c.source);
  p.start({sources});await p.wait();
  assert.equal(p.run!.status,'completed');assert.equal(store.stats().conversations,8);assert.equal(store.skills().length,3);
  for(const s of store.skills()){assert.equal(s.evidenceIds.length,2);assert.equal(s.sources.length,2);assert.equal(s.validation.valid,true);assert.match(s.markdown,/1\. /);assert.ok(!/颜色|大写/.test(s.title));}
  p.start({sources});await p.wait();assert.equal(store.stats().conversations,8);assert.equal(p.run!.cached,8);assert.equal(p.run!.modelCalls,0);assert.ok(store.skills().every(s=>s.version===1));
  extra=true;p.start({sources:[...sources,'opencode']});await p.wait();assert.equal(store.skills().length,3);assert.equal(store.stats().conversations,9);assert.ok(store.skills().some(s=>s.evidenceIds.length===3&&s.version===2));store.close();
});
test('duplicate imported copies never count as independent evidence and metadata changes preserve identity',async()=>{
  const {store}=await fixture();const c=demoConversations()[0];store.import(c);const duplicate={...c,externalId:'copy',source:'grok' as const};assert.equal(store.import(duplicate).status,'skipped');assert.equal(store.stats().conversations,1);
  const next={...c,title:'Updated title'};const result=store.import(next);assert.equal(result.status,'imported');assert.equal(store.stats().conversations,1);store.close();
});
test('unknown outcomes are not invented successes, failed and one-time procedures are not promoted',()=>{
  const c=normalizeConversation(demoConversations()[0]);const unknown=extractEpisodes({...c,messages:c.messages.slice(0,2)});assert.equal(unknown[0].outcome,'unknown');assert.equal(discoverSkills(unknown,[]).skills.length,0);
  const failed=extractEpisodes({...c,messages:[...c.messages.slice(0,2),{id:'bad',role:'user',text:'不行，这个结果失败了，方法不对。'}]});assert.equal(failed[0].outcome,'failed');assert.equal(discoverSkills(failed,[]).skills.length,0);
  const once=extractEpisodes({...c,messages:[{...c.messages[0],text:'仅这一次，按本任务临时要求处理。'},...c.messages.slice(1)]});assert.equal(once[0].steps.length,0);
});
test('user edits are preserved as generation proposes a revision, version rollback material stays available',async()=>{
  const {store}=await fixture();const collector:Collector=async function*(source){for(const conversation of demoConversations().filter(c=>c.source===source))yield {type:'conversation',conversation};};const p=new Pipeline(store,null,()=>{},()=>'',collector);p.start({sources:['chatgpt','claude']});await p.wait();
  const s=store.skills()[0];const edited=store.saveSkill({...s,markdown:s.markdown+'\nMy additional scoped note.\n',userEdited:true},'user edit');assert.equal(store.versions(s.id).length,2);
  p.start({sources:['chatgpt','claude']});await p.wait();const preserved=store.skill(s.id);assert.equal(preserved.markdown,edited.markdown);assert.ok(preserved.proposedRevision);assert.equal(store.versions(s.id).length,2);assert.equal(store.versions(s.id).find(v=>v.version===1)!.markdown,s.markdown);store.close();
});
test('one failed source and cancellation preserve already imported records and allow safe rerun',async()=>{
  const {store}=await fixture();let interrupt=true;
  const collector:Collector=async function*(source,options){if(source==='claude')throw new Error('fixture failure');for(const conversation of demoConversations().filter(c=>c.source===source)){yield {type:'conversation',conversation};if(interrupt){await new Promise(r=>setTimeout(r,20));options.signal.throwIfAborted();}}};
  const p=new Pipeline(store,null,()=>{},()=>'',collector);p.start({sources:['chatgpt','claude']});await p.wait();assert.equal(p.run!.sourceProgress.claude!.status,'error');assert.equal(p.run!.status,'completed');assert.ok(store.stats().conversations>0);
  p.start({sources:['chatgpt']});p.cancel();await p.wait();assert.equal(p.run!.status,'cancelled');interrupt=false;p.start({sources:['chatgpt'],resume:true});await p.wait();assert.equal(p.run!.status,'completed');assert.equal(store.stats().conversations,2);store.close();
});
test('portable export is structurally valid, redacts keys, and installation refuses overwrite',async()=>{
  const {store,dir}=await fixture();const eps=extractEpisodes(normalizeConversation(demoConversations()[0]));const s=discoverSkills(eps,[]).skills[0];assert.ok(s);
  const zip=unzipSync(exportSkills([s]));const md=strFromU8(zip[`${s.name}/SKILL.md`]);assert.ok(validateSkill(md,s.name).valid);assert.ok(!md.includes('request'));assert.ok(!Object.keys(zip).some(k=>k.includes('histories')));
  const fakeHome=path.join(dir,'fake-home');await mkdir(path.join(fakeHome,'.codex'),{recursive:true});const destination=(await detectDestinations(fakeHome))[0];assert.equal(destination.verified,true);const target=await installSkill(s,destination);assert.ok((await readFile(path.join(target,'SKILL.md'),'utf8')).includes(s.name));await assert.rejects(installSkill(s,destination),/already exists/);store.close();
});
test('format validation, local-only provider gate and redaction reject unsafe boundaries',()=>{
  assert.equal(validateSkill('hello').valid,false);assert.equal(validateSkill('---\nname: ../bad\ndescription: a\n---\n').valid,false);
  assert.throws(()=>assertSafeUrl('http://example.com/v1',true));assert.throws(()=>assertSafeUrl('https://example.com/v1',true));assert.throws(()=>assertSafeUrl('https://a:b@example.com/v1'));assertSafeUrl('http://127.0.0.1:11434/v1',true);
  assert.ok(!redact('api_key=sk-abcdefghijklmnopqrstuvwxyz user@example.com').includes('abcdefghijklmnopqrstuvwxyz'));
});
test('remote model requires explicit consent and budget is enforced before transmitting',async()=>{
  const {store}=await fixture();const c=normalizeConversation(demoConversations()[0]);const settings={...store.settings(),analysisMode:'remote' as const,endpoint:'https://example.com/v1',model:'test',remoteConsent:false};
  const analyzer=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:0,maxChars:1},()=> '');await assert.rejects(analyzer.extract(c,new AbortController().signal),/consent/);
  const local=new ModelAnalyzer({...settings,remoteConsent:true,endpoint:'http://127.0.0.1:11434/v1',analysisMode:'local'},{calls:0,inputChars:0,maxCalls:0,maxChars:1},()=> '');await assert.rejects(local.extract(c,new AbortController().signal),/budget/);store.close();
});
test('forgetting raw histories removes derived evidence, preserves skill edits and invalidates provenance',async()=>{
  const {store}=await fixture();const c=normalizeConversation(demoConversations()[0]);store.import(c);store.setEpisodes(c,extractEpisodes(c));for(const s of discoverSkills(store.episodes(),[]).skills)store.saveSkill(s);store.forget('history');assert.deepEqual(store.stats(),{conversations:0,messages:0,episodes:0,skills:1});assert.equal(store.skills()[0].validation.valid,false);assert.equal(store.versions(store.skills()[0].id).length,1);store.close();
});
test('routing selects enabled active skills only; archive remains recoverable in library',()=>{
  const eps=extractEpisodes(normalizeConversation(demoConversations()[0]));const s=discoverSkills(eps,[]).skills[0];assert.equal(routeSkills(s.title,[s]).length,0);assert.equal(routeSkills(s.title,[{...s,enabled:true,state:'active'}]).length,1);assert.equal(routeSkills(s.title,[{...s,enabled:true,state:'archived'}]).length,0);
});
test('generated skills omit auxiliary materials and provenance clutter while explicit resources still export cleanly',async()=>{
  const {store,dir}=await fixture();
  const base=normalizeConversation(demoConversations()[0]);
  base.messages[1]={...base.messages[1],text:base.messages[1].text+'\n```powershell\n$items = Get-ChildItem -Path ./docs -Filter *.md\n$items | ForEach-Object { Write-Output $_.FullName }\n```'};
  const eps=extractEpisodes(base);
  const s=discoverSkills(eps,[],true,'zh',undefined,[base]).skills[0];
  assert.equal(s.resources?.length||0,0);
  assert.ok(!s.markdown.includes('## 辅助材料'));
  assert.ok(!s.markdown.includes('## 依据和验证'));
  assert.ok(!s.markdown.includes('## Bundled resources'));
  assert.ok(!s.markdown.includes('## Evidence and validation'));
  const zip=unzipSync(exportSkills([s]));
  assert.ok(zip[`${s.name}/SKILL.md`]);
  assert.equal(zip[`${s.name}/references/PROVENANCE.md`],undefined);
  const fakeHome=path.join(dir,'fake-home-res');await mkdir(path.join(fakeHome,'.codex'),{recursive:true});await mkdir(path.join(fakeHome,'.gemini','antigravity'),{recursive:true});await mkdir(path.join(fakeHome,'.openclaw'),{recursive:true});await mkdir(path.join(fakeHome,'.hermes'),{recursive:true});await mkdir(path.join(fakeHome,'.deepseek'),{recursive:true});
  const destinations=await detectDestinations(fakeHome);
  assert.equal(destinations.find(d=>d.id==='codex')?.verified,true);
  assert.equal(destinations.find(d=>d.id==='antigravity')?.verified,true);
  assert.equal(destinations.find(d=>d.id==='openclaw')?.verified,true);
  assert.equal(destinations.find(d=>d.id==='hermes')?.verified,true);
  assert.equal(destinations.find(d=>d.id==='deepseek-harness')?.verified,true);
  const target=await installSkill(s,destinations[0]);
  assert.ok((await readFile(path.join(target,'SKILL.md'),'utf8')).includes(s.name));
  store.close();
});
test('extractive pipeline filters status reports and forked session duplicates while promoting generalizable SOPs',async()=>{
  const statusConv=normalizeConversation({
    source:'codex',externalId:'status-only-1',title:'Status report',completeness:'full',warnings:[],
    messages:[
      {id:'u1',role:'user',text:'请检查当前编译状态并汇报结果'},
      {id:'a1',role:'assistant',text:'1. 已经完成了所有模块的编译并生成了产物。\n2. 单元测试全部通过：128 passed。\n3. 修复了 Table 1 的对齐问题。\n4. 如果你想继续优化，也可以帮你看日志。'}
    ]
  });
  const statusEps=extractEpisodes(statusConv);
  assert.equal(statusEps[0].steps.length,0);
  assert.equal(discoverSkills(statusEps,[]).skills.length,0);

  const rootTurn=[
    {id:'r1',role:'user' as const,text:'Initialize workspace audit session'},
    {id:'r2',role:'assistant' as const,text:'Workspace audit session initialized.'}
  ];
  const forkA=normalizeConversation({
    source:'codex',externalId:'fork-a',title:'Fork A',completeness:'full',warnings:[],
    messages:[
      ...rootTurn,
      {id:'u2',role:'user',text:'更新当前项目的实验日志记录'},
      {id:'a2',role:'assistant',text:'1. 读取当前目录下的配置文件。\n2. 检查实验参数列表。\n3. 对齐本地输出目录结构。'},
      {id:'u3',role:'user',text:'好的，继续'}
    ]
  });
  const forkB=normalizeConversation({
    source:'codex',externalId:'fork-b',title:'Fork B',completeness:'full',warnings:[],
    messages:[
      ...rootTurn,
      {id:'u2b',role:'user',text:'更新当前项目的实验日志记录'},
      {id:'a2b',role:'assistant',text:'1. 读取当前目录下的配置文件。\n2. 检查实验参数列表。\n3. 对齐本地输出目录结构。\n4. 补充额外的备注信息。'}
    ]
  });
  const plan=await selectMaterials([forkA,forkB],new AbortController().signal);
  const allForkEps=[...(plan.local.get(forkA.id!)||[]),...(plan.local.get(forkB.id!)||[])];
  assert.equal(discoverSkills(allForkEps,[]).skills.length,0);

  const sopConv=normalizeConversation({
    source:'codex',externalId:'sop-general-1',title:'Skill audit SOP',completeness:'full',warnings:[],
    messages:[
      {id:'s1',role:'user',text:'Explain where installed AI-assistant skills are stored and why different runtimes/\nPlease audit the local skill directories.'},
      {id:'s2',role:'assistant',toolName:'shell',text:'ls ~/.codex/skills ~/.agents/skills'},
      {id:'s3',role:'tool',text:'found directories'},
      {id:'s3b',role:'tool',text:'counted skills'},
      {id:'s4',role:'assistant',text:'1. For any local audit request, return a non-empty report: inspect the relevant local paths before answering and include either concrete findings or an explicit not-found result.\n2. When auditing AI-assistant skill directories, inspect common roots such as `~/.codex/skills`, `~/.agents/skills`, project `.codex/skills`, project `.agents/skills`, and any AGENTS.md-listed skill roots, then report a count for each directory found.\n3. For skill-directory audits, compute and report both `per-directory` counts and `deduplicated counts`; deduplicate by stable skill name when available, otherwise by normalized directory name.\n4. For read-only audits, explicitly state `no files were changed` unless a write actually occurred, and do not modify files while gathering counts.'}
    ]
  });
  const sopEps=extractEpisodes(sopConv);
  const discovered=discoverSkills(sopEps,[]).skills;
  assert.equal(discovered.length,1);
  assert.equal(discovered[0].title,'Explain where installed AI-assistant skills are stored');
  assert.equal(discovered[0].validation.valid,true);
});
