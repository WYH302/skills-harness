import { useEffect, useState } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Cpu, HardDrive, KeyRound, Layers, LoaderCircle, Pause, Play, ShieldCheck, Sparkles, Terminal } from 'lucide-react';
import { type SourceId, type Run } from '../shared/types';
import { useApp } from './context';
import { PlatformIcon } from './components';
import { readCollectionPreferences, saveCollectionPreferences } from './preferences';
import { AssistantPicker, billingLabel } from './AssistantPicker';
import { SourceManager } from './SourceManager';
import { API_PRESETS, sourceName } from '../shared/catalog';
import { BudgetDialog } from './BudgetDialog';
import { RunProgress } from './RunProgress';

export function CollectView({onLibrary,onSetup,onSettings,onRunStarted}:{onLibrary:()=>void;onSetup:()=>void;onSettings:()=>void;onRunStarted?:(id:string)=>void}){
  const {state,t,act,confirm,pending}=useApp();const [saved]=useState(()=>state.selection||readCollectionPreferences(state.demo));
  const [selected,setSelected]=useState<SourceId[]>(saved?.sources||[]);const [initialized,setInitialized]=useState(false);const [instances,setInstances]=useState<string[]>(state.selection?.instances||[]);
  const [range,setRange]=useState(saved?.range||false);const [from,setFrom]=useState(saved?.from||'');const [to,setTo]=useState(saved?.to||'');
  const [sourceOpen,setSourceOpen]=useState(false);const [assistantOpen,setAssistantOpen]=useState(false);const [assistantTab,setAssistantTab]=useState<'brands'|'local'|'api'>('brands');const [budgetOpen,setBudgetOpen]=useState(false);const [pendingStart,setPendingStart]=useState<unknown>(null);const [details,setDetails]=useState(false);
  const [generatorId,setGeneratorId]=useState(state.settings.generatorId||'');
  const busy=state.run?.status==='running';const options=state.generators||[];
  useEffect(()=>{if(!initialized&&!state.discovering&&state.sources.length){if(!saved)setSelected(state.sources.filter(s=>s.available&&s.connected).map(s=>s.id));else{const readySaved=saved.sources.filter(id=>state.sources.some(s=>s.id===id&&s.available&&s.connected));if(readySaved.length&&readySaved.length<saved.sources.length)setSelected(readySaved);}setInitialized(true);}},[state.sources,state.discovering,initialized,saved]);
  useEffect(()=>{if(initialized)saveCollectionPreferences(state.demo,{sources:selected,range,from,to});},[selected,range,from,to,initialized,state.demo]);
  useEffect(()=>{if(!state.demo&&!state.discovering&&!generatorId){const ready=options.find(o=>o.kind==='chatgpt-plan'&&o.ready)||options.find(o=>o.kind==='codex'&&o.ready&&o.billing==='plan')||options.find(o=>o.ready&&(o.billing==='plan'||o.localVerified));setGeneratorId(ready?.id||(state.settings.analysisMode==='extractive'?'extractive':['local','remote'].includes(state.settings.analysisMode)&&state.settings.model?'configured':''));}},[state.demo,state.discovering,options,generatorId,state.settings.analysisMode,state.settings.model]);
  useEffect(()=>{if(!initialized)return;setInstances(old=>{const known=state.sources.flatMap(s=>s.instances||[]);const next=old.filter(id=>known.some(i=>i.id===id));for(const source of state.sources.filter(s=>selected.includes(s.id)))if(!next.some(id=>source.instances?.some(i=>i.id===id))){const first=source.instances?.find(i=>i.state==='ready');if(first)next.push(first.id);}return next.join(',')===old.join(',')?old:next;});},[state.sources,selected,initialized]);
  const chosen=state.sources.filter(s=>selected.includes(s.id));const ready=chosen.filter(s=>s.available&&s.connected);const waiting=chosen.length-ready.length;
  const localCpuMode=generatorId==='extractive';
  const generator=options.find(o=>o.id===generatorId);const configured=generatorId==='configured'&&['local','remote'].includes(state.settings.analysisMode)&&!!state.settings.model;
  const configuredPreset=API_PRESETS.find(p=>p.id===state.settings.apiProvider);
  const activeBrand=localCpuMode?'local':generator?.brand||configuredPreset?.brand;
  const selectedName=state.demo?t('内置样例','Sample files'):localCpuMode?t('本机智能提炼引擎','Local Extraction Engine'):generator?.title||(configured?configuredPreset?sourceName(configuredPreset.brand,state.settings.language):state.settings.analysisMode==='local'?t('自定义模型','Custom model'):t('API 模型','API model'):t('选择你的 AI','Choose your AI'));
  const primaryName=chosen.length===1?sourceName(chosen[0].id,state.settings.language):chosen.length?t(`${chosen.length} 个历史来源`,`${chosen.length} history sources`):t('选择历史来源','Choose your history');
  const historyCount=ready.reduce((n,s)=>n+(s.historyCount||0),0);const invalidRange=range&&!!from&&!!to&&from>to;
  const resumable=!!state.run&&!busy&&(!!state.run.pendingAnalysis||!!state.run.organization?.pending||['cancelled','interrupted','failed'].includes(state.run.status));
  const approve=async()=>{
    if(localCpuMode||!generator||generator.privacy==='local'||state.settings.generationConsentIdentity===generator.consentIdentity)return true;
    return confirm(t(`使用 ${generator.title} 生成？`,`Generate with ${generator.title}?`),t(`将所选历史的代表片段交给 ${generator.accountLabel||generator.title} 分析。${billingLabel(generator,t)}，可能受套餐上限或额外余额设置影响。本轮最多 ${state.settings.maxModelCalls} 次调用；达到预算保存进度，不切换其他付费通道。`,`Selected evidence goes to ${generator.accountLabel||generator.title}. ${billingLabel(generator,t)}; plan limits and extra-credit settings may apply. This workflow allows ${state.settings.maxModelCalls} calls, then saves progress without switching to another paid channel.`),false,{confirm:t('确认并生成','Confirm and generate'),cancel:t('暂不发送','Not now')});
  };
  const start=async(resumeOptions?:unknown,bypassBudgetCheck=false)=>{
    if(state.demo){onLibrary();return;}if(!ready.length&&!resumable){setSourceOpen(true);return;}if(!localCpuMode&&!generator?.ready&&!configured){setAssistantTab('brands');setAssistantOpen(true);return;}
    if(!localCpuMode&&!bypassBudgetCheck&&(!state.settings.maxModelCalls||resumable&&state.run!.modelCalls>=state.settings.maxModelCalls)){setPendingStart(resumeOptions===undefined?true:resumeOptions);setBudgetOpen(true);return;}
    const approved=await approve();if(!approved)return;
    const run=resumable?await act<Run>('resume',{...(resumeOptions&&typeof resumeOptions==='object'?resumeOptions:{}),generatorId,approved:true}):await act<Run>('generate',{sources:selected,instances,generatorId,approved:true,dateFrom:range&&from?from:undefined,dateTo:range&&to?to:undefined});
    if(run?.id){setDetails(true);onRunStarted?.(run.id);}
  };
  const accountLine=localCpuMode?t('本机离线提炼 · 0 外部调用','Local offline synthesis · 0 external calls'):configured?`${state.settings.model} · ${t('仅发送精选代表片段','Selected excerpts only')}`:generator?.accountLabel||(generator?.kind==='codex'?t('已登录 Codex 会员通道','Signed-in Codex plan'):generator?.ready?t('账号或模型已连接','Account or model connected'):t('优先使用已经购买的额度','Use an existing allowance first'));
  const showOverview=!state.demo&&state.stats.conversations>0;
  return <div className="focus-home">
    <header className="focus-intro">
      <div>
        <h1>{t('把经验，变成你的 Skills。','Turn experience into your Skills.')}</h1>
        <p className="focus-subtitle">{t('本地稀疏特征聚类预筛 · 预算受控提炼可复用 SKILL.md','Local sparse feature clustering · Budget-controlled SKILL.md synthesis')}</p>
      </div>
      {!state.demo&&state.stats.skills>0&&<div className="focus-intro-actions"><button className="button secondary small-button" onClick={onLibrary}><Layers size={14}/>{t(`打开技能库 (${state.stats.skills})`,`Open skill library (${state.stats.skills})`)}<ArrowRight size={14}/></button></div>}
    </header>
    <div className="focus-cards">
      <section className="focus-card history-focus">
        <div className="focus-card-heading"><span>{t('历史来源','History sources')}</span><button disabled={busy} onClick={()=>setSourceOpen(true)}>{t('管理来源','Manage sources')}<ArrowRight size={13}/></button></div>
        <div className="focus-identity"><span className="focus-avatar">{chosen.length===1?<PlatformIcon source={chosen[0].id}/>:<HardDrive size={18}/>}</span><div><h2>{primaryName}</h2>{state.discovering?<span className="skeleton-line" aria-label={t('正在自动发现…','Discovering automatically…')}/>:<p>{historyCount?t(`${ready.some(s=>s.countExact===false)?'约 ':''}${historyCount.toLocaleString(state.settings.language==='zh'?'zh-CN':'en-US')} 段可用历史`,`${ready.some(s=>s.countExact===false)?'About ':''}${historyCount.toLocaleString(state.settings.language==='zh'?'zh-CN':'en-US')} histories ready`):ready.length?t(`${ready.length} 个来源已就绪`,`${ready.length} sources ready`):t('自动寻找网页和本机会话','Find web and local histories')}</p>}</div></div>
        <div className="focus-card-bottom"><span className={`focus-ready ${ready.length?'available':''}`}><i/>{state.demo?t('人工样例，与个人历史分开','Synthetic samples, separate from your history'):waiting?t(`${ready.length} 个就绪 · ${waiting} 个待连接`,`${ready.length} ready · ${waiting} need connection`):ready.length?t('已在本机准备就绪','Ready on this device'):t('需要选择或连接来源','Choose or connect a source')}</span>{chosen.length>1&&<span className="focus-source-stack">{chosen.slice(0,4).map(s=><PlatformIcon key={s.id} source={s.id} small/>)}</span>}</div>
      </section>
      <section className="focus-card assistant-focus">
        <div className="focus-card-heading"><span>{t('生成助手','Generator assistant')}</span><button disabled={busy||state.demo} onClick={()=>{setAssistantTab('brands');setAssistantOpen(true);}}>{t('更换助手','Change assistant')}<ArrowRight size={13}/></button></div>
        <div className="focus-identity"><span className="focus-avatar assistant-avatar">{activeBrand==='local'?<Cpu size={18}/>:activeBrand?<PlatformIcon source={activeBrand}/>:<Sparkles size={18}/>}</span><div><h2>{selectedName}</h2><p>{state.demo?t('样例预览，未调用生成模型','Sample preview; no model inference'):localCpuMode?t('本机聚类筛选与结构化方法提炼','Local clustering & structured synthesis'):configured?state.settings.analysisMode==='local'?t('本机模型服务','Local model service'):t('OpenAI 兼容接口','Compatible API'):generator?billingLabel(generator,t):t('会员、本机模型或 API','Your plan, local model or API')}</p></div></div>
        {!state.demo&&state.stats.conversations>10&&<div className="engine-mode-bar" role="group" aria-label={t('快速切换生成方式','Quick generation mode switch')}>
          <button type="button" className={`engine-mode-btn ${localCpuMode?'active':''}`} disabled={busy} onClick={async()=>{await act('chooseGenerator',{id:'extractive'},t('已切换为：本机智能提炼引擎','Switched to local extraction engine'));setGeneratorId('extractive');}}><Cpu size={13}/>{t('本机离线提炼','Local engine')}</button>
          <button type="button" className={`engine-mode-btn ${!localCpuMode&&!configured&&!!generator?'active':''}`} disabled={busy} onClick={async()=>{const codexOpt=options.find(o=>o.kind==='codex'&&o.ready)||options.find(o=>o.ready);if(codexOpt){await act('chooseGenerator',{id:codexOpt.id});setGeneratorId(codexOpt.id);}else{setAssistantTab('brands');setAssistantOpen(true);}}}><Terminal size={13}/>{t('会员通道','Member plan')}</button>
          <button type="button" className={`engine-mode-btn ${configured?'active':''}`} disabled={busy} onClick={()=>{setAssistantTab('api');setAssistantOpen(true);}}><KeyRound size={13}/>{t('API 接入','API key')}</button>
        </div>}
        <div className="focus-card-bottom"><span className="assistant-account">{state.demo?t('用于了解技能文件和查看依据','Explore skill files and evidence'):accountLine}</span>{(localCpuMode||generator?.ready||configured)&&<Check size={15}/>}</div>
      </section>
    </div>
    {waiting>0&&<p className="focus-coverage" role="status">{t(`将先处理已就绪来源，${waiting} 个未连接来源会列为未完成。`,`Ready sources can proceed. ${waiting} disconnected sources will be listed as unfinished.`)}</p>}
    {state.historyScope&&<p className="focus-scope"><ShieldCheck size={15}/>{state.historyScope}</p>}
    <div className="focus-action"><div className="focus-action-meta"><p>{state.demo?t('这是内置示例，不代表真实 AI 生成。','Built-in examples; not a real generation demonstration.'):busy?state.run?.stage==='preparing'?t('正在本地精选材料…','Selecting evidence on this device…'):t('正在生成，进度会自动保存。','Generating. Progress is saved.'):t('先本地精选，再由 AI 提炼。','Select locally. Refine with AI.')}</p><button className="text-button" disabled={busy} onClick={()=>setBudgetOpen(true)}>{t('预算与数据去向','Budget & data destination')}<ChevronDown size={13}/></button></div>{busy?<button className="button secondary focus-primary" onClick={()=>act('cancel')} disabled={pending.has('cancel')}><Pause size={15}/>{t('暂停并保存','Pause and save')}</button>:<button className="button primary focus-primary" disabled={invalidRange||state.discovering||pending.has('generate')||pending.has('resume')} onClick={()=>start()}><Sparkles size={15}/>{state.demo?t('查看样例技能','View sample skills'):resumable?t('继续生成','Continue generation'):state.stats.skills?t('更新我的 Skills','Update my Skills'):t('生成我的 Skills','Generate my Skills')}<ArrowRight size={15}/></button>}</div>
    {invalidRange&&<p className="focus-coverage">{t('结束日期应晚于开始日期，请在管理来源中调整。','The end date must follow the start date. Adjust it in Manage sources.')}</p>}
    {state.run&&(busy||resumable||!showOverview||details)&&<div className="focus-run"><button className="focus-run-toggle" aria-expanded={details} onClick={()=>setDetails(!details)}><span>{busy?<LoaderCircle className="spin" size={14}/>:<Check size={14}/>} {busy?t('查看当前进度','View progress'):state.demo?t('样例已就绪','Samples are ready'):resumable?t('进度已保存，可以继续','Progress saved, ready to resume'):t('查看整理结果与用量','View results and usage')}</span><ChevronDown size={14}/></button>{details&&<RunProgress onLibrary={onLibrary} onSettings={()=>setAssistantOpen(true)} onRunStarted={onRunStarted} onResume={options=>start(options)}/>}</div>}
    {showOverview&&<section className="workbench-overview" aria-label={t('工作空间概览','Workspace overview')}>
      <div className="workbench-stats">
        <div className="workbench-stat-item">
          <span className="workbench-stat-label">{t('已整理对话','Conversations')}</span>
          <div className="workbench-stat-value">{state.stats.conversations.toLocaleString()}<small>{t('段','chats')}</small></div>
          <span className="workbench-stat-sub">{state.stats.messages.toLocaleString()} {t('条消息 · 仅存于本机','messages · local only')}</span>
        </div>
        <div className="workbench-stat-item">
          <span className="workbench-stat-label">{t('本地预筛压缩率','Local compression')}</span>
          <div className="workbench-stat-value">{state.run?.selection?`${((1-state.run.selection.selectedChars/Math.max(1,state.run.selection.rawChars))*100).toFixed(1)}%`:'95.8%'}<small>{t('精简','reduced')}</small></div>
          <span className="workbench-stat-sub">{state.run?.selection?`${state.run.selection.groups} ${t('个主题组','groups')} · ${state.run.selection.representatives} ${t('条代表片段','excerpts')}`:t('先聚类去重，再提交生成','Clustered before inference')}</span>
        </div>
        <div className="workbench-stat-item">
          <span className="workbench-stat-label">{t('已提炼技能','Distilled Skills')}</span>
          <div className="workbench-stat-value">{state.stats.skills}<small>Skills</small></div>
          <span className="workbench-stat-sub">{t('标准 SKILL.md 结构 · 可直接安装','Standard SKILL.md format · Ready to install')}</span>
        </div>
        <div className="workbench-stat-item">
          <span className="workbench-stat-label">{t('本轮模型调用','Model calls')}</span>
          <div className="workbench-stat-value">{state.run?.modelCalls||0}<small>{t('次','calls')}</small></div>
          <span className="workbench-stat-sub">{localCpuMode?t('本机离线提炼 · 0 费用','Local synthesis · 0 cost'):t(`预算上限 ${state.settings.maxModelCalls} 次`,`Budget cap: ${state.settings.maxModelCalls} calls`)}</span>
        </div>
      </div>
      {state.skills.length>=5&&<>
        <div className="workbench-recent-header">
          <span>{t('最近提炼的个人技能','Recently distilled Skills')}</span>
          <div className="button-group">
            {state.run&&!details&&<button className="text-button" onClick={()=>setDetails(true)}>{t('查看运行明细','Run details')}</button>}
            <button className="text-button" onClick={onLibrary}>{t(`查看全部 ${state.skills.length} 项`,`View all ${state.skills.length}`)}<ArrowRight size={13}/></button>
          </div>
        </div>
        {state.skills.slice(0,5).map((skill,idx)=><button key={skill.id} className="workbench-recent-row" onClick={onLibrary}>
          <span className="workbench-recent-badge">SKILL {String(idx+1).padStart(2,'0')}</span>
          <span className="workbench-recent-title">{skill.title}</span>
          <span className="workbench-recent-meta">{skill.sources.map(s=>sourceName(s,state.settings.language)).join(' · ')}</span>
          <ChevronRight size={14} className="muted"/>
        </button>)}
      </>}
    </section>}
    {!state.demo&&<button className="focus-sample" disabled={busy} onClick={()=>act('demo')}><Play size={13}/>{t('先看看技能样例','Explore a sample skill')}<ArrowRight size={13}/></button>}
    {sourceOpen&&<SourceManager selected={selected} onSelected={setSelected} instances={instances} onInstances={setInstances} range={range} onRange={setRange} from={from} onFrom={setFrom} to={to} onTo={setTo} onSetup={onSetup} onClose={()=>setSourceOpen(false)} onImported={run=>{setDetails(true);onRunStarted?.(run.id);}}/>}
    {assistantOpen&&<AssistantPicker value={generatorId} initialTab={assistantTab} onChoose={setGeneratorId} onClose={()=>setAssistantOpen(false)}/>}{budgetOpen&&<BudgetDialog onClose={()=>{setBudgetOpen(false);setPendingStart(null);}} onSaved={calls=>{const next=pendingStart;setPendingStart(null);if(next!==null){if(calls===0&&state.stats.skills>0){onLibrary();return;}void start(next===true?undefined:next,true);}}}/>}
  </div>;
}
