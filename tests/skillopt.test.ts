import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { stripCodexMeta, isCodexReplay, extractJsonObject } from '../src/vendor/skillopt/history';
import { charBound, cleanTaskQuality, isShapeOnly } from '../src/vendor/skillopt/task-contract';
import { extractEpisodes, ModelAnalyzer } from '../src/core/mining';
import { discoverSkills } from '../src/core/skills';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { normalizeConversation } from '../src/core/util';
import { demoConversations } from '../src/core/demo-data';

const userQuote='验收标准：结论必须区分仓库声明与已经核实的证据，并说明安装维护成本。';
const ref={messageId:'request',quote:userQuote};
const supports=(e:{messageId:string;quote:string})=>e.messageId===ref.messageId&&userQuote.includes(e.quote);

test('SkillOpt harvest port recovers appended tasks while excluding harness-only context',()=>{
  assert.equal(stripCodexMeta('# AGENTS.md instructions\n<INSTRUCTIONS>private harness</INSTRUCTIONS>\n<environment_context>paths</environment_context>\n评估开源工具的实际用途'), '评估开源工具的实际用途');
  assert.equal(stripCodexMeta('# AGENTS.md instructions\n<INSTRUCTIONS>private harness</INSTRUCTIONS>'),'');
  assert.equal(stripCodexMeta('<environment_context>paths</environment_context>\n保留真正的任务请求'),'保留真正的任务请求');
  assert.equal(stripCodexMeta('<codex_internal_context>internal only</codex_internal_context>'),'');
  assert.equal(stripCodexMeta('  Normal user request  '),'Normal user request');
});

test('SkillOpt replay exclusion prevents synthetic optimization runs becoming personal evidence',()=>{
  assert.ok(isCodexReplay(['[skillopt-sleep:codex-engine:v1]\n\nsynthetic task']));
  assert.ok(isCodexReplay(['Complete the task. Apply the skill and memory rules EXACTLY, please\n# Skill\nx\n# Memory\ny\n# Task\nz']));
  assert.equal(isCodexReplay(['Complete the task. Apply the skill and memory rules EXACTLY, please']),false);
  const c=normalizeConversation(demoConversations()[0]);c.messages[0].text='[skillopt-sleep:codex-engine:v1]\n\n'+c.messages[0].text;
  assert.deepEqual(extractEpisodes(c),[]);
});

test('SkillOpt response extraction accepts fenced/chatty JSON without executing malformed output',()=>{
  assert.deepEqual(extractJsonObject('Here is the result:\n```json\n{"episodes":[]}\n```'),{episodes:[]});
  assert.throws(()=>extractJsonObject('{"episodes":[]} {"episodes":[]}'));
  assert.throws(()=>extractJsonObject('process.exit(0)'));
});

test('SkillOpt integer-bound parser rejects boolean, fractional and nonfinite pseudo-limits',()=>{
  for(const value of [0,14,'14','  +14 '])assert.equal(charBound(value),Number(value));
  for(const value of [true,false,null,undefined,2.5,'2.5','',NaN,Infinity,{},[]])assert.throws(()=>charBound(value));
});

test('SkillOpt task criteria prefer substantive rubrics and remove malformed or unsupported checks',()=>{
  const quality=cleanTaskQuality({rubric:{text:'区分声明与核实证据，并解释安装维护成本。',...ref},checks:[
    {op:'contains',arg:' 成本 ',description:'说明维护成本',...ref},
    {op:'max_chars',arg:true,description:'invalid boolean',...ref},
    {op:'min_chars',arg:-1,description:'negative',...ref},
    {op:'unknown',description:'unsupported operator',...ref},
    {op:'contains',arg:'secret',description:'invented criterion',messageId:'other',quote:'invented source'},
    {op:'regex',arg:'  cost  ',description:'说明有关成本的证据',...ref}
  ]},supports)!;
  assert.equal(quality.basis,'rubric');assert.equal(quality.checks.length,2);
  assert.equal(quality.checks[0].arg,'成本');assert.equal(quality.checks[1].arg,'  cost  ');
  assert.equal(cleanTaskQuality({rubric:{text:null,...ref},checks:[]},supports),undefined);
  assert.equal(cleanTaskQuality({checks:[{op:'regex',arg:'cost.*',description:'Use cost.*',...ref}]},supports),undefined);
});

test('SkillOpt shape-only checks are distinguished from substantive evaluation criteria',()=>{
  assert.equal(isShapeOnly([]),false);assert.equal(isShapeOnly([{op:'max_chars'},{op:'section_present'}]),true);
  assert.equal(isShapeOnly([{op:'max_chars'},{op:'contains'}]),false);
  const quality=cleanTaskQuality({checks:[{op:'max_chars',arg:'500',description:'输出不超过五百字。',...ref}]},supports)!;
  assert.equal(quality.basis,'format-only');
  const episode=extractEpisodes(normalizeConversation(demoConversations()[0]))[0];
  const skill=discoverSkills([{...episode,quality}],[]).skills[0];
  assert.ok(skill.markdown.includes('Success criteria'));assert.ok(skill.validation.warnings.some(w=>w.includes('Only formatting')));
  assert.ok(!skill.markdown.includes('max_chars'));assert.ok(!skill.markdown.includes('task passed'));
});

test('corrected shorter procedures replace longer rejected answers, with original source traceability',()=>{
  const c=normalizeConversation(demoConversations()[0]);
  const corrected='1. 确认工具能否完成当前任务，并记录需要的输入。\n2. 核对许可证及实际运行证据，区分事实与假设。\n3. 比较安装维护成本，给出有依据的采用建议。';
  c.messages=[c.messages[0],c.messages[1],{id:'reject',role:'user',text:'不对，前一套方法不满意，改成更短的流程。'},{id:'fixed',role:'assistant',text:corrected},{id:'approve',role:'user',text:'很好，这个方法符合要求，以后就这样。'}];
  const episodes=extractEpisodes(c);assert.equal(episodes.length,1);
  assert.equal(episodes[0].outcome,'accepted');assert.equal(episodes[0].steps.length,3);
  assert.ok(episodes[0].steps[0].includes('当前任务'));assert.ok(episodes[0].evidence.some(e=>e.messageId==='fixed'));
  assert.ok(!episodes[0].evidence.some(e=>e.messageId===c.messages[1].id));
  for(const e of episodes[0].evidence)assert.ok(c.messages.some(m=>m.id===e.messageId&&m.text.includes(e.quote)));
});

test('explicit local acceptance requirements enter generated skills without model calls',()=>{
  const c=normalizeConversation(demoConversations()[0]);c.messages[0].text+='\n'+userQuote;
  const e=extractEpisodes(c)[0];assert.equal(e.quality?.basis,'rubric');
  const s=discoverSkills([e],[]).skills[0];assert.ok(s.markdown.includes(userQuote));assert.ok(!s.markdown.includes('## 依据和验证'));
});

test('model pipeline uses SkillOpt guidance and cites only user-supported substantive criteria',async()=>{
  const store=new Store(await mkdtemp(path.join(tmpdir(),'skillharbor-skillopt-model-')));
  const c=normalizeConversation(demoConversations()[0]);c.messages[0].text='# AGENTS.md instructions\n<INSTRUCTIONS>HARNESS_PRIVATE_MARKER</INSTRUCTIONS>\n'+c.messages[0].text+'\n'+userQuote;
  let calls=0;let invented=false;
  const server=createServer(async(req,res)=>{
    calls++;const pieces:Buffer[]=[];for await(const part of req)pieces.push(part);
    const body=JSON.parse(Buffer.concat(pieces).toString());
    assert.match(body.messages[0].content,/rubric is the primary criterion/);assert.ok(!body.messages[1].content.includes('HARNESS_PRIVATE_MARKER'));
    const chunk=JSON.parse(body.messages[1].content);const assistant=chunk.messages.find((m:{role:string})=>m.role==='assistant');const user=chunk.messages.find((m:{role:string})=>m.role==='user');
    const steps=extractEpisodes(normalizeConversation(demoConversations()[0]))[0].steps.map(text=>({text,messageId:assistant.id,quote:text}));
    const quality={rubric:{text:'区分工具声明和实际核实证据，解释部署成本。',messageId:invented?assistant.id:user.id,quote:invented?steps[0].quote:userQuote},checks:[]};
    const result={episodes:[{goal:'面向新手评估开源工具的实际价值',steps,quality,outcome:'accepted'}]};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:'Result:\n```json\n'+JSON.stringify(result)+'\n```'}}]}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const settings={...store.settings(),analysisMode:'local' as const,endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`,model:'local-fixture'};
    const miner=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:3,maxChars:200000},()=> '');
    const first=await miner.extract(c,new AbortController().signal);assert.equal(first[0].quality?.basis,'rubric');assert.equal(first[0].outcome,'accepted');
    invented=true;const second=await miner.extract(c,new AbortController().signal);assert.equal(second[0].quality,undefined);
    c.messages.push({id:'late-rejection',role:'user',text:'不行，这个流程仍然失败，不要这样做。'});
    const third=await miner.extract(c,new AbortController().signal);assert.equal(third[0].outcome,'failed');assert.equal(calls,3);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}
});

test('SkillOpt-backed extraction persists criteria and stays incremental across unchanged runs',async()=>{
  const store=new Store(await mkdtemp(path.join(tmpdir(),'skillharbor-skillopt-pipeline-')));
  const c=demoConversations()[0];c.messages[0].text='# AGENTS.md instructions\n<INSTRUCTIONS>harness</INSTRUCTIONS>\n'+c.messages[0].text+'\n'+userQuote;
  const collector:Collector=async function*(){yield {type:'conversation',conversation:c};};
  try {
    const pipeline=new Pipeline(store,null,()=>{},()=>'',collector);pipeline.start({sources:[c.source]});await pipeline.wait();
    assert.equal(pipeline.run!.status,'completed');assert.equal(store.skills().length,1);assert.equal(store.episodes()[0].quality?.basis,'rubric');
    assert.ok(!store.skills()[0].title.includes('AGENTS'));
    pipeline.start({sources:[c.source]});await pipeline.wait();
    assert.equal(pipeline.run!.cached,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(store.skills()[0].version,1);
  }finally{store.close();}
});
