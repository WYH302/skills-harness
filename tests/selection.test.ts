import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Conversation } from '../src/shared/types';
import { selectMaterials, evaluateSelectionMethods } from '../src/core/selection';
import { ModelAnalyzer, type ModelBudget, type ModelTransport } from '../src/core/mining';
import { normalizeConversation } from '../src/core/util';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';

const signal=()=>new AbortController().signal;
const steps=['核实项目的许可证和可复用功能，记录原始证据与限制。','比较候选工具的安装和维护成本，根据需求列出取舍。','运行小型代表任务验证能力，将实际观察写进交付报告。'];
function history(i:number,source:Conversation['source']='codex'):Conversation{return normalizeConversation({source,externalId:'selection-'+i,title:'Unrelated title '+i,messages:[{id:'u',role:'user',text:`评估第 ${i} 个开源工具，确认用途和安装成本。`},{id:'a',role:'assistant',text:steps.map((s,n)=>`${n+1}. ${s}`).join('\n')},{id:'ok',role:'user',text:'很好，就按这个方法。'}],completeness:'full',warnings:[]});}
function reply(content:string):string{
  const {messages}=JSON.parse(content) as {messages:{id:string;role:string;text:string}[]};
  const assistants=messages.filter(m=>m.role==='assistant');
  return JSON.stringify({episodes:[{goal:'根据任务需求核实开源工具能力与安装维护成本',inputs:['工具地址和用途'],outputs:['证据与取舍报告'],steps:steps.map((text,i)=>{const m=assistants[i%assistants.length];return {text,messageId:m.id,quote:text};}),preferences:[],corrections:[],outcome:'unknown',scope:'general'}]});
}
test('local selection is offline, counts independent episodes and caps representatives before any model call',async()=>{
  const conversations=Array.from({length:80},(_,i)=>history(i));
  const plan=await selectMaterials(conversations,signal());
  assert.equal(plan.summary.preprocessingModelCalls,0);assert.equal(plan.summary.histories,80);assert.equal(plan.summary.groups,1);
  assert.equal(plan.groups[0].view.conversations,80);assert.ok(plan.summary.representatives>=3&&plan.summary.representatives<=6);
  assert.ok(plan.summary.selectedChars<plan.summary.rawChars*.15);
  for(const group of plan.groups)for(const material of group.view.materials)assert.ok(conversations.find(c=>c.id===material.conversationId)!.messages.some(m=>m.id===material.messageId&&m.text.includes(material.text)));
});
test('repeated copies and hundreds of tool log repetitions do not become independent methods',async()=>{
  const c=history(1);const duplicate=normalizeConversation({...c,source:'chatgpt',externalId:'copy'});
  const noisy={...c,messages:[...c.messages,{id:'log',role:'tool' as const,text:'检查 测试 验证 重试 '.repeat(10000)}]};
  const plan=await selectMaterials([noisy,duplicate],signal());assert.equal(plan.summary.duplicates,1);assert.equal(plan.summary.groups,1);
  assert.equal(plan.groups[0].view.conversations,1);assert.ok(plan.groups[0].conversation.messages.filter(m=>m.role==='tool').reduce((n,m)=>n+m.text.length,0)<=400);
});
test('sampling keeps a shorter correction, its response and conditional exception; rejected long output stays local',async()=>{
  const c=history(2);c.messages=[c.messages[0],{id:'wrong',role:'assistant',text:('1. 直接采用未经核实的结论并要求始终简短。\n').repeat(600)},{id:'fix',role:'user',text:'不对，不要这样。普通问题别写太长；重要分析要深入完整。'},{id:'correct',role:'assistant',text:steps.map((s,n)=>`${n+1}. ${s}`).join('\n')},c.messages[2]];
  const plan=await selectMaterials([c],signal());const selected=plan.groups[0].conversation.messages;
  assert.ok(selected.some(m=>m.id.endsWith(':fix')&&m.text.includes('重要分析')));assert.ok(selected.some(m=>m.id.endsWith(':correct')));
  assert.ok(!selected.some(m=>m.id.endsWith(':wrong')));assert.equal(plan.groups[0].completeContext,true);
});
test('topics and one-time instructions are retained locally without generating filler groups',async()=>{
  const topic=history(1);topic.messages=[{id:'u',role:'user',text:'我喜欢电脑和显卡，有哪些颜色？'},{id:'a',role:'assistant',text:'有黑色和白色。'}];
  const once=history(2);once.messages[0].text='仅限这次，按临时目录做这项任务。';
  const plan=await selectMaterials([topic,once],signal());assert.equal(plan.groups.length,0);assert.equal(plan.local.size,2);
});
test('initial context followed by a long brief remains sampleable and keeps actual tool evidence',async()=>{
  const c=history(3);c.messages=[{id:'context',role:'user',text:'这是项目上下文，请继续处理后面的任务。'},{id:'task',role:'user',text:c.messages[0].text+'\n'+('背景材料：如果网页不支持记录，不要假设可以恢复。\n').repeat(200)},c.messages[1],{id:'tool',role:'assistant',toolName:'inspect',text:'Read the project license and compare documented features.'},{id:'result',role:'tool',text:'MIT license; partial provider coverage.'},c.messages[2]];
  const plan=await selectMaterials([c],signal());assert.equal(plan.summary.deferredGroups,0);assert.ok(plan.groups[0].conversation.messages.some(m=>m.id.endsWith(':task')));assert.ok(plan.groups[0].conversation.messages.some(m=>m.toolName==='inspect'||m.role==='tool'));assert.ok(plan.summary.selectedChars<6000);
});
test('too many essential exceptions defer a group instead of silently dropping context',async()=>{
  const records=Array.from({length:8},(_,i)=>{const c=history(i);c.messages[0].text+=` 如果在第 ${i} 种条件下，需要保留详细依据。`;return c;});
  const plan=await selectMaterials(records,signal());assert.equal(plan.groups.length,1);assert.equal(plan.summary.deferredGroups,1);assert.equal(plan.groups[0].view.status,'deferred');
});
test('one grouped request synthesizes traceable evidence; unchanged rerun is zero calls; source change updates a group',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-selection-'));const store=new Store(dir);let calls=0;
  const records=Array.from({length:12},(_,i)=>history(i,i%2?'chatgpt':'codex'));
  const transport:ModelTransport={id:'synthetic-no-inference',complete:async(_system,content)=>{calls++;return reply(content);}};
  store.saveSettings({analysisMode:'codex',model:'synthetic',maxModelCalls:2});
  const collector:Collector=async function*(source){for(const conversation of records.filter(c=>c.source===source))yield {type:'conversation',conversation};};
  const pipeline=new Pipeline(store,null,()=>{},()=>'',collector,{transport:async()=>transport});
  try{
    pipeline.start({sources:['codex','chatgpt']});await pipeline.wait();assert.equal(pipeline.run!.status,'completed');assert.equal(calls,1);assert.equal(store.skills().length,1);
    assert.equal(pipeline.run!.selection!.preprocessingModelCalls,0);assert.equal(pipeline.run!.usage!.length,1);assert.equal(pipeline.run!.usage![0].status,'completed');
    assert.ok(store.episodes().some(e=>(e.contributingConversations?.length||0)>=2));
    for(const e of store.episodes())for(const ref of e.evidence)assert.ok(store.conversation(ref.conversationId||e.conversationId)!.messages.some(m=>m.id===ref.messageId&&m.text.includes(ref.quote)));
    pipeline.start({sources:['codex','chatgpt']});await pipeline.wait();assert.equal(calls,1);assert.equal(pipeline.run!.modelCalls,0);assert.equal(pipeline.run!.skills,0);assert.equal(pipeline.run!.selection!.cachedGroups,1);
    records[0].messages.push({id:'extra',role:'user',text:'另外补充，如果工具只支持部分来源，必须在报告中写明限制。'});
    pipeline.start({sources:['codex','chatgpt']});await pipeline.wait();assert.equal(calls,2);assert.equal(store.skills().length,1);
  }finally{store.close();}
});
test('failed requests reserve the shared workflow budget and resume cannot reset it',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-ledger-'));let store=new Store(dir);let calls=0;
  store.saveSettings({analysisMode:'codex',model:'synthetic',maxModelCalls:1});
  const transport:ModelTransport={id:'synthetic-failure',complete:async()=>{calls++;throw new Error('Synthetic unavailable');}};
  const collector:Collector=async function*(){yield {type:'conversation',conversation:history(1)};};
  let pipeline=new Pipeline(store,null,()=>{},()=>'',collector,{transport:async()=>transport});
  pipeline.start({sources:['codex']});await pipeline.wait();assert.equal(calls,1);assert.equal(pipeline.run!.usage![0].status,'failed');assert.equal(pipeline.run!.selection!.pendingGroups,1);
  store.close();store=new Store(dir);pipeline=new Pipeline(store,null,()=>{},()=>'',collector,{transport:async()=>transport});
  try{pipeline.resume({analysisOnly:true});await pipeline.wait();assert.equal(calls,1);assert.equal(pipeline.run!.modelCalls,1);assert.equal(pipeline.run!.usage!.length,1);assert.equal(pipeline.run!.selection!.pendingGroups,1);}finally{store.close();}
});
test('concurrent requests reserve from one budget before sending; zero budget sends nothing',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-reserve-'));const store=new Store(dir);let calls=0;
  const settings={...store.settings(),analysisMode:'codex' as const};const budget:ModelBudget={calls:0,inputChars:0,maxCalls:1,maxChars:100000};
  const transport:ModelTransport={id:'synthetic',complete:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return '{"episodes":[]}';}};
  try{
    const model=new ModelAnalyzer(settings,budget,()=>'',undefined,transport);
    const outcomes=await Promise.allSettled([model.extract(history(1),signal()),model.extract(history(2),signal())]);
    assert.equal(calls,1);assert.equal(outcomes.filter(o=>o.status==='rejected').length,1);assert.equal(budget.calls,1);
    const zero=new ModelAnalyzer(settings,{calls:0,inputChars:0,maxCalls:0,maxChars:100000},()=>'',undefined,transport);await assert.rejects(zero.extract(history(3),signal()),/budget/);assert.equal(calls,1);
  }finally{store.close();}
});
test('erasing source or derived data also removes representative excerpts and provenance metadata',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-material-erasure-'));const store=new Store(dir);
  try{for(const scope of ['derived','history'] as const){store.import(history(1));store.setMeta('selectedMaterialPlan',{groups:[{text:'synthetic private excerpt'}]});store.setMeta('selection-source:any','hash');store.forget(scope);assert.equal(store.getMeta('selectedMaterialPlan',null),null);assert.equal(store.getMeta('selection-source:any',null),null);}}finally{store.close();}
});
test('transport wrapper and schema overhead are budgeted before a request can be sent',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-wrapper-cost-'));const store=new Store(dir);let sent=0;
  const transport:ModelTransport={id:'synthetic-overhead',estimateInput:()=>9000,complete:async()=>{sent++;return '{"episodes":[]}';}};
  try{const model=new ModelAnalyzer({...store.settings(),analysisMode:'codex'},{calls:0,inputChars:0,maxCalls:3,maxChars:8000},()=>'',undefined,transport);assert.equal(model.estimate(history(1)).inputChars,9000);await assert.rejects(model.extract(history(1),signal()),/budget/);assert.equal(sent,0);assert.equal(model.budget.calls,0);}finally{store.close();}
});
test('CTSS contrastive trajectory submodular selection outperforms legacy TF-IDF cosine, frequency-only and random baselines under fixed budget',()=>{
  const pool:Conversation[]=[];
  for(let i=0;i<30;i++){
    // 20 repetitive verbose boilerplate histories
    if(i<20){
      const c=history(i);
      c.messages=[
        {id:'u',role:'user',text:`请检查并测试服务模块 ${i} 的常规启动状态，确认构建配置与输出日志。`},
        {id:'a',role:'assistant',text:`1. 检查服务模块常规启动配置文件与环境变量。\n2. 运行本地构建命令验证模块编译结果。\n3. 记录测试输出日志并保存常规验证报告。\n`+('常规检查日志输出正常。\n').repeat(12)},
        {id:'ok',role:'user',text:'很好，就按这个方法。'}
      ];
      pool.push(normalizeConversation(c));
    }else{
      // 10 diverse high-value corrective trajectories with unique action primitives
      const idx=i-20;
      const c=history(i);
      c.messages=[
        {id:'u',role:'user',text:`定位并修复分布式流水线任务 ${idx} 的数据库锁冲突与迁移脚本回滚异常。`},
        {id:'bad',role:'assistant',text:`1. 直接重启数据库服务并跳过锁检查。`},
        {id:'fix',role:'user',text:`不对，不要这样做！仅当存在活跃事务锁时，必须先提取阻塞快照并验证只读探针，严禁跳过迁移校验。`},
        {id:'good',role:'assistant',text:`1. 提取数据库事务锁快照并定位阻塞会话标识 (${idx})。\n2. 运行只读迁移探针核对 schema 版本兼容性 (${idx})。\n3. 编写幂等回滚补丁并验证事务隔离级别设置 (${idx})。\n4. 保存审计核对清单与修复验证记录 (${idx})。`},
        {id:'ok',role:'user',text:'成功了，解决了问题！'}
      ];
      pool.push(normalizeConversation(c));
    }
  }
  const metrics=evaluateSelectionMethods(pool,4500);
  const byMode=new Map(metrics.map(m=>[m.mode,m]));
  const ctss=byMode.get('ctss')!;
  const legacy=byMode.get('legacy-tfidf-cosine')!;
  const freq=byMode.get('frequency-only')!;
  const rand=byMode.get('random-sampling')!;
  assert.equal(ctss.llmCalls,0);
  assert.ok(ctss.actionCoveragePct>=legacy.actionCoveragePct,'CTSS action coverage should beat or tie legacy cosine');
  assert.ok(ctss.correctionRetentionPct>legacy.correctionRetentionPct,'CTSS correction retention should strictly beat legacy cosine');
  assert.ok(ctss.correctionRetentionPct>freq.correctionRetentionPct,'CTSS correction retention should strictly beat frequency-only');
  assert.ok(ctss.submodularObjective>rand.submodularObjective,'CTSS objective should beat random sampling');
});
