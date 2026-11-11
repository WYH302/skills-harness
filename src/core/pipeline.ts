import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Conversation, Run, RunRequest, SourceId, CollectionOptions, CollectorEvent } from '../shared/types';
import { WEB_SOURCES, SOURCE_NAMES, IMPORT_SOURCES } from '../shared/types';
import { resolveOutputLanguage } from '../shared/localization';
import { collectLocal } from '../adapters/local';
import { importHistory } from '../adapters/import';
import { Store } from './store';
import type { BrowserBridge } from './bridge';
import { conversationSchema } from './bridge';
import { extractEpisodes, MINER_VERSION, ModelAnalyzer, BudgetError, type ModelBudget, type ModelTransport, modelView, modelFailure } from './mining';
import { discoverSkills, reconcileSkills } from './skills';
import { hash, inDateRange, now, safeError, unique } from './util';
import { analyzeRepresentatives } from './representative-analysis';
import { organizeProcedures } from './organization-analysis';

export type Collector=(source:SourceId,options:CollectionOptions)=>AsyncGenerator<CollectorEvent>;
export interface PipelineRuntime {requireModel?:boolean;transport?:(settings:import('../shared/types').Settings)=>Promise<ModelTransport|undefined>;roots?:()=>Partial<Record<SourceId,string[]>>;availability?:()=>import('../shared/types').SourceAvailability[];projectPath?:string;stableBefore?:number}
export class Pipeline {
  private aborter:AbortController|null=null;
  private active:Promise<void>|null=null;
  run:Run|null;
  constructor(readonly store:Store,readonly bridge:BrowserBridge|null,readonly notify:()=>void,private apiKey:()=>string=()=>'',private overrideCollector?:Collector,private runtime:PipelineRuntime={}) {this.run=store.latestRun();}
  get busy():boolean {return !!this.active;}
  cancel():void {this.aborter?.abort();}
  async wait():Promise<void> {await this.active;}
  private update():void {if(this.run)this.store.saveRun(this.run);this.notify();}
  resume(options:{failedOnly?:boolean;analysisOnly?:boolean}={}):Run {
    if(this.busy)throw new Error('A run is already active');
    const previous=this.run;
    if(!previous)throw new Error('No previous run to resume / 没有可继续的运行');
    const failedSources=previous.sources.filter(id=>previous.sourceProgress[id]?.status==='error'||(previous.sourceProgress[id]?.failed||0)>0);
    if(options.failedOnly&&!failedSources.length)throw new Error('No failed sources to retry / 没有需要重试的来源');
    const analysisOnly=!options.failedOnly&&(options.analysisOnly||previous.collectionComplete||previous.stage!=='collecting');
    const request:RunRequest={sources:options.failedOnly?failedSources:previous.sources,dateFrom:previous.dateFrom,dateTo:previous.dateTo,resume:true};
    if(analysisOnly)return this.start(request,undefined,true);
    if(previous.input==='import') {
      const saved=this.store.getMeta<{runId:string;file:{path:string;source?:SourceId}}|null>('lastImport',null);
      if(saved?.runId!==previous.id||!existsSync(saved.file.path))throw new Error('Original import file unavailable. Choose it again using Import. / 原导入文件不可用，请重新选择该文件。');
      return this.start({...request,sources:[]},saved.file);
    }
    return this.start(request);
  }
  start(request:RunRequest,importFile?:{path:string;source?:SourceId},analysisOnly=false):Run {
    if(this.busy)throw new Error('A run is already active');
    if(!request.sources.length&&!importFile&&!analysisOnly)throw new Error('Select at least one source');
    const previousRun=this.run;
    this.aborter=new AbortController();
    this.run={id:randomUUID(),outputLanguage:request.resume&&previousRun?.outputLanguage||resolveOutputLanguage(this.store.settings()),status:'running',stage:analysisOnly?'analyzing':'collecting',startedAt:now(),sources:unique(request.sources),sourceProgress:{},episodes:0,skills:0,modelCalls:0,inputChars:0,cached:0,warnings:[],dateFrom:request.dateFrom,dateTo:request.dateTo,input:analysisOnly?'analysis':importFile?'import':'collect',collectionComplete:analysisOnly,processedConversations:0};
    this.run.budgetSessionId=request.resume&&previousRun?previousRun.budgetSessionId||previousRun.id:this.run.id;
    this.run.usage=request.resume&&previousRun?structuredClone(previousRun.usage||[]):[];
    if(request.resume&&previousRun){this.run.modelCalls=previousRun.modelCalls;this.run.inputChars=previousRun.inputChars;this.run.outputChars=previousRun.outputChars||0;}
    if(importFile)this.store.setMeta('lastImport',{runId:this.run.id,file:importFile});
    for(const id of request.sources)this.run.sourceProgress[id]=analysisOnly&&previousRun?.sourceProgress[id]?structuredClone(previousRun.sourceProgress[id]):{discovered:0,imported:0,skipped:0,failed:0,messages:0,status:analysisOnly?'done':'pending',detail:analysisOnly?'Reusing imported records / 继续分析已导入记录':''};
    this.update();
    // Keep run() non-blocking so UI immediately receives progress and can cancel.
    this.active=this.execute(request,this.aborter.signal,importFile,analysisOnly).finally(()=>{this.active=null;this.aborter=null;this.notify();});
    return this.run;
  }
  private async consume(source:SourceId,event:CollectorEvent,request:RunRequest):Promise<void> {
    const run=this.run!;
    const p=run.sourceProgress[source]??={discovered:0,imported:0,skipped:0,failed:0,messages:0,status:'running',detail:''};
    if(event.type==='conversation') {
      const parsed=conversationSchema.safeParse(event.conversation);
      if(!parsed.success){p.failed++;run.warnings.push(`${SOURCE_NAMES[source]}: invalid record / 记录格式无效`);return;}
      const c=parsed.data as Conversation;
      if(c.source!==source){p.failed++;return;}
      p.discovered=Math.max(p.discovered,p.imported+p.skipped+p.failed+1);
      if(!inDateRange(c,request.dateFrom,request.dateTo)){p.skipped++;return;}
      if((request.dateFrom||request.dateTo)&&!c.updatedAt&&!c.createdAt)run.warnings.push(`${SOURCE_NAMES[source]}: undated records included / 无日期记录已保留`);
      const result=this.store.import(c);p[result.status]++;if(result.status==='imported')p.messages+=c.messages.length;
      if(c.completeness!=='full'){p.status='partial';run.warnings.push(`${SOURCE_NAMES[source]}: partial/unknown content / 内容为部分或未知范围`);}
      for(const warning of c.warnings)run.warnings.push(`${SOURCE_NAMES[source]}: ${warning}`);
      if(result.status==='skipped'&&(p.imported+p.skipped+p.failed)%25!==0)return;
    }else if(event.type==='progress') {
      if(event.discovered!==undefined)p.discovered=Math.max(p.discovered,event.discovered);
      // Local adapters emit per-file deltas; the extension reports cumulative counts.
      if(event.failed!==undefined)p.failed=WEB_SOURCES.includes(source)?Math.max(p.failed,event.failed):p.failed+event.failed;
      if(event.skipped!==undefined)p.skipped=WEB_SOURCES.includes(source)?Math.max(p.skipped,event.skipped):p.skipped+event.skipped;
      if(event.detail)p.detail=event.detail;
      if(event.skipped===1&&event.discovered===undefined&&event.failed===undefined&&(p.imported+p.skipped+p.failed)%25!==0)return;
    }else if(event.type==='checkpoint')this.store.checkpoint(source,event.cursor);
    else if(event.type==='warning'){p.status='partial';run.warnings.push(event.message);}
    run.warnings=unique(run.warnings).slice(-150);this.update();
    await new Promise<void>(resolve=>setImmediate(resolve));
  }
  private async execute(request:RunRequest,signal:AbortSignal,importFile?:{path:string;source?:SourceId},analysisOnly=false):Promise<void> {
    const run=this.run!;
    let budget:ModelBudget|undefined;
    try {
      if(analysisOnly) {
        // Resume analysis from persisted history without requiring a website login or original export.
      }else if(importFile) {
        for await(const c of importHistory(importFile.path,importFile.source)) {signal.throwIfAborted();if(!run.sources.includes(c.source))run.sources.push(c.source);await this.consume(c.source,{type:'conversation',conversation:c},request);}
        for(const p of Object.values(run.sourceProgress))if(p)p.status=p.status==='partial'?'partial':'done';
      }else {
        const pending=[...run.sources];
        const worker=async()=>{
          while(pending.length) {
            signal.throwIfAborted();const id=pending.shift()!;const p=run.sourceProgress[id]!;p.status='running';this.update();
            if(IMPORT_SOURCES.includes(id)&&!this.overrideCollector){const imported=this.store.conversations().filter(c=>c.source===id);p.discovered=imported.length;p.skipped=imported.length;p.status=imported.length?'done':'error';p.failed=imported.length?0:1;p.detail=imported.length?'复用已导入历史；此来源未自动采集新记录。 / Reusing imported history; no automatic collection for this source.':'此来源仅支持文件导入，请先导入已有记录。 / This source requires a history file import first.';if(!imported.length)run.warnings.push(`${SOURCE_NAMES[id]}: ${p.detail}`);this.update();continue;}
            const unavailable=this.runtime.availability?.().find(source=>source.id===id&&(!source.available||!source.connected));
            if(unavailable){p.status='error';p.failed=1;p.detail=unavailable.detail;run.warnings.push(`${SOURCE_NAMES[id]}: ${p.detail}`);this.update();continue;}
            const existingExtIds=new Set((this.store.db.prepare('SELECT external_id FROM conversations WHERE source=?').all(id) as {external_id:string}[]).map(r=>r.external_id));
            const sessionSigs=this.store.getMeta<Record<string,string>>('localSessionSigs:'+id,{});
            const metaCache=this.store.getMeta<Record<string,{size:number;mtimeMs:number;meta:{cwd?:string;subThread?:boolean;selfGenerated?:boolean}}>>('localMetaCache:'+id,{});
            const options:CollectionOptions={signal,dateFrom:request.dateFrom,dateTo:request.dateTo,cursor:request.resume?this.store.checkpoint(id):undefined,roots:this.runtime.roots?.(),projectPath:this.runtime.projectPath,stableBefore:this.runtime.stableBefore,isUnchangedSession:(!request.dateFrom&&!request.dateTo)?(sid,sig)=>existingExtIds.has(sid)&&sessionSigs[sid]===sig:undefined,onSessionSignature:(sid,sig)=>{sessionSigs[sid]=sig;},metaCache};
            try {
              const events=this.overrideCollector?this.overrideCollector(id,options):WEB_SOURCES.includes(id)?this.bridge!.collect(id,options):collectLocal(id,options);
              for await(const event of events){signal.throwIfAborted();await this.consume(id,event,request);}
              if(!WEB_SOURCES.includes(id)){this.store.setMeta('localSessionSigs:'+id,sessionSigs);this.store.setMeta('localMetaCache:'+id,metaCache);}
              p.status=(run.sourceProgress[id]!.status as string)==='partial'||p.failed>0?'partial':'done';
            }catch(e){if(signal.aborted)throw e;p.status='error';p.failed++;p.detail=safeError(e);run.warnings.push(`${SOURCE_NAMES[id]}: ${p.detail}`);}
            this.update();
          }
        };
        const outcomes=await Promise.allSettled(Array.from({length:Math.min(3,pending.length)},()=>worker()));
        const failed=outcomes.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
      }
      run.collectionComplete=true;signal.throwIfAborted();run.stage='analyzing';this.update();
      const settings={...this.store.settings(),skillOutputLanguage:run.outputLanguage};
      const modeKey=hash([MINER_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.redactSensitive,settings.generationConsentIdentity,settings.analysisDetail,settings.skillOutputLanguage]);
      if(settings.processingStrategy==='full'&&(this.store.getMeta('analysisModeKey','')!==modeKey||!settings.incremental)){this.store.invalidateAnalysis();this.store.setMeta('analysisModeKey',modeKey);}
      run.budget={maxCalls:settings.maxModelCalls,maxChars:settings.maxInputChars};
      budget={calls:run.modelCalls,inputChars:run.inputChars,maxCalls:settings.maxModelCalls,maxChars:settings.maxInputChars,outputChars:run.outputChars||0,entries:run.usage||[],onChange:()=>{run.modelCalls=budget!.calls;run.inputChars=budget!.inputChars;run.outputChars=budget!.outputChars;run.usage=budget!.entries;this.update();}};
      const transport=['chatgpt-plan','codex','claude-code','antigravity','gemini-cli','openclaw','hermes','deepseek-cli','cursor-cli'].includes(settings.analysisMode)?await this.runtime.transport?.(settings):undefined;
      const model=settings.analysisMode==='extractive'?null:new ModelAnalyzer(settings,budget,this.apiKey,{get:key=>this.store.cache(key),put:(key,value)=>this.store.putCache(key,value)},transport,{get:key=>this.store.cache<string>(key),put:(key,value)=>this.store.putCache(key,value)});
      const scoped=this.store.conversations().filter(c=>run.sources.includes(c.source)&&inDateRange(c,request.dateFrom,request.dateTo));
      if(settings.processingStrategy!=='full')await analyzeRepresentatives(this.store,run,settings,model,scoped,signal,()=>this.update());
      else {
      let modelUnavailable=false;
      const scopeIds=new Set(scoped.map(c=>c.id));const pending=this.store.pendingIds().filter(id=>scopeIds.has(id));run.analysisTotal=pending.length;run.cached=scoped.length-pending.length;this.update();
      if(model&&settings.analysisDetail!=='full'&&pending.some(id=>{const view=modelView(this.store.conversation(id)!);return view.omitted>0||view.excerpted>0;}))run.warnings.push('重点分析：完整原文保存在本机；模型跳过系统及大段重复输出，保留部分工具操作和错误片段，对超长消息抽取首、中、尾片段。引用可回查原文，未逐字分析全部内容。 / Focused analysis keeps full originals locally, excludes system/bulk repeated output, retains selected tool/error excerpts, and samples across very long messages; it is not an exhaustive full-text analysis.');
      for(const id of pending) {
        const c=this.store.conversation(id)!;
        signal.throwIfAborted();const key=this.store.analysisKey(c,modeKey);let episodes=this.store.cache<ReturnType<typeof extractEpisodes>>(key);let complete=true;
        if(episodes){run.cached++;}
        else if(model&&!modelUnavailable) {
          try {episodes=await model.extract(c,signal);this.store.putCache(key,episodes);}
          catch(e){if(signal.aborted)throw e;this.store.setMeta('lastModelFailure',modelFailure(e));modelUnavailable=true;complete=false;run.warnings.push(e instanceof BudgetError?e.message:'Model analysis unavailable; conservative local extraction used. Retry later to complete model analysis. / 模型暂不可用，已使用保守本地提取，可稍后重试。');episodes=e instanceof BudgetError&&e.partial.length?e.partial:extractEpisodes(c);}
        }else {episodes=extractEpisodes(c);if(model)complete=false;else this.store.putCache(key,episodes);}
        this.store.setEpisodes(c,episodes,complete);run.processedConversations!++;run.episodes+=episodes.length;run.modelCalls=budget.calls;run.inputChars=budget.inputChars;this.update();
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      }
      signal.throwIfAborted();run.stage='generating';this.update();
      const episodes=this.store.episodes();const previous=this.store.skills();
      const organization=await organizeProcedures(this.store,run,settings,model,episodes,scoped,signal,()=>this.update());
      const discovery=discoverSkills(this.runtime.requireModel?episodes.filter(e=>e.analysis==='model'):episodes,previous,settings.autoConsolidate,run.outputLanguage,organization,scoped);
      const resourceFiles=discovery.skills.reduce((n,s)=>n+(s.resources?.length||s.proposedResources?.length||0),0);
      run.resources={skills:discovery.skills.filter(s=>(s.resources?.length||s.proposedResources?.length||0)>0).length,completed:discovery.skills.length,cached:0,pending:0,files:resourceFiles,plannedCalls:0,plannedInputChars:0};
      if(this.runtime.requireModel&&!model){if(run.selection)run.selection.pendingGroups=Math.max(0,run.selection.groups-run.selection.deferredGroups);run.pendingAnalysis=run.selection?.representatives||0;run.warnings.push('尚未进行 AI 生成，请连接会员、本机大模型或 API。规则仅用于本地整理。 / AI generation has not run. Connect an account, local model or API; rules only prepare evidence.');}
      this.store.batch(()=>{for(const skill of [...discovery.skills].reverse()){signal.throwIfAborted();this.store.saveSkill(skill,skill.proposedRevision?'proposed revision; user edit preserved':'evidence consolidation');}});
      this.store.batch(()=>{for(const skill of reconcileSkills(previous,discovery.skills,episodes))this.store.saveSkill(skill,'evidence reconciliation');});
      run.supportedSkills=discovery.skills.length;
      run.skills=discovery.skills.filter(skill=>{const old=previous.find(s=>s.id===skill.id);return !old||old.markdown!==skill.markdown||JSON.stringify(old.resources||[])!==JSON.stringify(skill.resources||[])||old.proposedRevision!==skill.proposedRevision;}).length;
      if(settings.processingStrategy==='full')run.pendingAnalysis=this.store.pendingIds().filter(id=>scoped.some(c=>c.id===id)).length;run.warnings.push(...discovery.conflicts);run.warnings=unique(run.warnings);
      this.store.setMeta('lastRejectedCandidates',discovery.rejected);
      run.status='completed';run.stage='done';run.finishedAt=now();
      for(const id of run.sources)if(run.sourceProgress[id]?.status==='done')this.store.clearCheckpoint(id);
      this.update();
    }catch(e) {
      if(budget){run.modelCalls=budget.calls;run.inputChars=budget.inputChars;}
      run.status=signal.aborted?'cancelled':'failed';run.pendingAnalysis=this.store.pendingIds().length;run.finishedAt=now();if(!signal.aborted)run.warnings.push(safeError(e));this.update();
    }
  }
}
