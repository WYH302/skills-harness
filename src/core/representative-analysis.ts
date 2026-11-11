import type { Conversation, Episode, Run, SelectionSummary, Settings } from '../shared/types';
import { ModelAnalyzer, BudgetError, MINER_VERSION, MODEL_VALIDATION_VERSION, modelFailure } from './mining';
import { restoreOrigins, selectMaterials, SELECTION_VERSION } from './selection';
import { Store } from './store';
import { hash, unique } from './util';
import { matchesOutputLanguage } from '../shared/localization';

export async function analyzeRepresentatives(store:Store,run:Run,settings:Settings,model:ModelAnalyzer|null,conversations:Conversation[],signal:AbortSignal,update:()=>void):Promise<void> {
  run.stage='preparing';run.analysisTotal=conversations.length;run.processedConversations=0;update();
  const initiallyPending=new Set(store.pendingIds());const localCached=conversations.filter(c=>!initiallyPending.has(c.id!)).length;
  const corpusSig=hash([SELECTION_VERSION,MINER_VERSION,run.outputLanguage,conversations.map(c=>[c.id,c.updatedAt,c.messages.length,c.messages[0]?.id,c.messages.at(-1)?.id,c.messages[0]?.text.length,c.messages.at(-1)?.text.length])]);
  if(!model&&settings.incremental&&conversations.length>=20&&initiallyPending.size===0&&store.getMeta('selectionCorpusSig','')===corpusSig){
    const cachedSummary=store.getMeta<SelectionSummary|null>('selectionSummaryCache',null);
    const savedEpisodes=store.episodes();
    if(cachedSummary&&savedEpisodes.length>0){
      run.selection={...cachedSummary,plannedCalls:0,plannedInputChars:0,pendingGroups:0};
      run.processedConversations=0;run.cached=conversations.length;run.episodes=savedEpisodes.length;run.pendingAnalysis=0;
      if(cachedSummary.deferredGroups)run.warnings.push(`${cachedSummary.deferredGroups} 组包含超出取样窗口的纠正或例外，已保留，未提交模型。 / ${cachedSummary.deferredGroups} groups retain more correction/exception context than the window permits and were not submitted.`);
      run.warnings.push('先本地整理并选择代表材料；未选中的片段仍在本机，不代表全部历史已由模型逐字分析。TF-IDF 按词汇和操作相似度分组，可能漏掉跨语言近义方法。 / Local preparation precedes generation. Unselected episodes remain local; this is not exhaustive model reading. Lexical TF-IDF can miss cross-language equivalents.');
      update();return;
    }
  }
  const plan=await selectMaterials(conversations,signal,count=>{run.processedConversations=count;update();});
  run.selection=plan.summary;run.processedConversations=conversations.length;
  const identity=hash([SELECTION_VERSION,MINER_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.redactSensitive,settings.generationConsentIdentity,settings.maxOutputTokens,settings.skillOutputLanguage,MODEL_VALIDATION_VERSION]);
  const previousIdentity=hash([SELECTION_VERSION,MINER_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.redactSensitive,settings.generationConsentIdentity,settings.maxOutputTokens,settings.skillOutputLanguage]);
  const legacyIdentity=hash([SELECTION_VERSION,MINER_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.redactSensitive,settings.generationConsentIdentity,settings.maxOutputTokens]);
  const keys=new Map(plan.groups.map(group=>[group.id,'representatives:'+hash([identity,group.id])]));
  const models:Episode[]=[];const completed=new Set<string>();const synthesizedTasks=new Set<string>();
  const ownTasks=(group:typeof plan.groups[number],result:Episode[])=>{if(result.some(e=>e.steps.length>=3))for(const item of group.items)synthesizedTasks.add(hash(item.messages.map(m=>[m.role,m.text])));};
  const cache=new Map<string,Episode[]>();
  for(const group of plan.groups){
    let saved=settings.incremental?store.cache<Episode[]>(keys.get(group.id)!):undefined;
    if(!saved&&settings.incremental){const legacy=store.cache<Episode[]>('representatives:'+hash([previousIdentity,group.id]))||store.cache<Episode[]>('representatives:'+hash([legacyIdentity,group.id]));if(legacy&&matchesOutputLanguage(legacy,run.outputLanguage)&&!model?.hasCachedResponses(group.conversation,true)){saved=legacy.map(e=>({...e,outputLanguage:run.outputLanguage}));store.putCache(keys.get(group.id)!,saved);}}
    if(saved&&saved.every(e=>e.evidence.every(ref=>conversations.some(c=>c.id===(ref.conversationId||e.conversationId)&&c.messages.some(m=>m.id===ref.messageId&&m.text.includes(ref.quote)))))){
      cache.set(group.id,saved);group.view.status='cached';plan.summary.cachedGroups++;models.push(...saved);completed.add(group.id);
      ownTasks(group,saved);
    }else if(group.completeContext&&model){
      const estimate=model.estimate(group.conversation,true);plan.summary.plannedCalls+=estimate.calls;
      plan.summary.plannedInputChars+=estimate.inputChars;
    }
  }
  const persist=()=>{store.setMeta('selectedMaterialPlan',{runId:run.id,groups:plan.groups.map(group=>group.view)});update();};
  plan.summary.pendingGroups=model?plan.groups.filter(g=>g.completeContext&&!completed.has(g.id)).length:0;
  persist();run.stage='analyzing';run.analysisTotal=plan.groups.length;run.processedConversations=0;update();
  // Leave a bounded share for organizing the methods just generated. Otherwise
  // a large library can spend the entire default budget extracting forever,
  // never reaching cross-language consolidation in the one-click workflow.
  const limits=model?{calls:model.budget.maxCalls,chars:model.budget.maxChars}:null;
  const reserve=!!model&&settings.autoConsolidate&&plan.groups.filter(g=>g.completeContext).length>=2&&model.budget.maxCalls-model.budget.calls>=3&&plan.summary.plannedCalls>0;
  if(reserve&&model){model.budget.maxCalls--;model.budget.maxChars-=Math.min(24000,Math.floor(Math.max(0,model.budget.maxChars-model.budget.inputChars)*.25));}
  let unavailable=false;
  try {
  if(!model){
    run.processedConversations=plan.groups.length;run.cached=localCached;plan.summary.pendingGroups=0;update();
  }else{
  for(const group of plan.groups){
    signal.throwIfAborted();
    let groupChanged=false;
    if(!cache.has(group.id)&&model&&group.completeContext&&!unavailable){
      groupChanged=true;
      try{
        const result=restoreOrigins(await model.extract(group.conversation,signal,true),group);
        // Validate again at the raw-history boundary after virtual IDs are mapped.
        if(result.some(e=>e.evidence.some(ref=>!conversations.some(c=>c.id===ref.conversationId&&c.messages.some(m=>m.id===ref.messageId&&m.text.includes(ref.quote))))))throw new Error('Model returned unsupported evidence');
        store.putCache(keys.get(group.id)!,result);models.push(...result);completed.add(group.id);group.view.status='completed';plan.summary.completedGroups++;
        ownTasks(group,result);
      }catch(error){
        if(signal.aborted)throw error;const failure=modelFailure(error);store.setMeta('lastModelFailure',failure);
        if(error instanceof BudgetError)group.view.reason=reserve?'本轮分析预算已用完，剩余份额用于方法归并；代表材料已保存。 / Extraction allocation reached; a remaining share is reserved for procedure alignment. Materials saved.':'本轮剩余预算不足，代表材料已保存。 / Remaining workflow budget is insufficient; materials saved.';
        else if(failure.kind==='tool-or-connection'||failure.kind==='request-schema'){unavailable=true;group.view.reason='生成服务中断，已保存本地整理结果与用量。 / Generation service interrupted; local results and usage saved.';}
        else group.view.reason='本组模型输出未通过原文引用或格式核对，已保留原文并继续下一组。 / Model output for this group did not pass source-quote or schema validation; source retained.';
        if(error instanceof BudgetError&&error.partial.length)models.push(...restoreOrigins(error.partial,group));
      }
    }
    run.processedConversations!++;run.cached=model?plan.summary.cachedGroups:localCached;
    plan.summary.pendingGroups=model?plan.groups.filter(g=>g.completeContext&&!completed.has(g.id)).length:0;
    if(groupChanged){persist();await new Promise<void>(resolve=>setImmediate(resolve));}
    else if(run.processedConversations!%25===0||run.processedConversations===plan.groups.length){update();await new Promise<void>(resolve=>setImmediate(resolve));}
  }
  }
  }finally{if(model&&limits){model.budget.maxCalls=limits.calls;model.budget.maxChars=limits.chars;}}
  const prior=store.episodes().filter(e=>e.analysis==='model');const byId=new Map(conversations.map(c=>[c.id!,c]));
  store.batch(()=>{
    for(const c of conversations){
      const sourceHash=hash(c.messages.map(m=>[m.id,m.role,m.text]));
      const priorHash=store.getMeta<string|undefined>('selection-source:'+c.id,undefined);
      // A strategy migration or exhausted budget must not erase an existing,
      // unchanged model result. Changed source messages invalidate that fallback.
      const keep=prior.filter(e=>e.conversationId===c.id&&(!priorHash||priorHash===sourceHash)&&!models.some(m=>m.conversationId===c.id)&&e.evidence.every(ref=>{
        const origin=byId.get(ref.conversationId||e.conversationId)||store.conversation(ref.conversationId||e.conversationId);return origin?.messages.some(m=>m.id===ref.messageId&&m.text.includes(ref.quote));
      }));
      const generated=models.filter(e=>e.conversationId===c.id);
      const local=plan.local.get(c.id!)||[];
      // Model synthesis owns its cited procedure; avoid creating a duplicate local
      // skill from the exact same task while retaining unrelated local episodes.
      const combined=[...generated,...keep,...local.filter(e=>!synthesizedTasks.has(e.contentHash)&&(!keep.length||!e.steps.length))];
      store.setEpisodes(c,combined);store.setMeta('selection-source:'+c.id,sourceHash);
    }
    store.setMeta('selectionCorpusSig',corpusSig);
    store.setMeta('selectionSummaryCache',plan.summary);
  });
  run.episodes=conversations.reduce((n,c)=>n+(plan.local.get(c.id!)?.length||0),0);
  if(!model)run.processedConversations=conversations.length-localCached;
  const pendingGroups=plan.groups.filter(g=>model&&g.completeContext&&!completed.has(g.id));
  run.pendingAnalysis=unique(pendingGroups.flatMap(g=>g.chosen.map(item=>item.c.id!))).length;
  if(pendingGroups.length)run.warnings.push(`${pendingGroups.length} 组代表材料待生成；原文、进度与用量已保存。继续处理沿用本轮累计预算。 / ${pendingGroups.length} evidence groups await generation; source data, progress and usage saved. Resume shares the workflow budget.`);
  if(plan.summary.deferredGroups)run.warnings.push(`${plan.summary.deferredGroups} 组包含超出取样窗口的纠正或例外，已保留，未提交模型。 / ${plan.summary.deferredGroups} groups retain more correction/exception context than the window permits and were not submitted.`);
  run.warnings.push('先本地整理并选择代表材料；未选中的片段仍在本机，不代表全部历史已由模型逐字分析。TF-IDF 按词汇和操作相似度分组，可能漏掉跨语言近义方法。 / Local preparation precedes generation. Unselected episodes remain local; this is not exhaustive model reading. Lexical TF-IDF can miss cross-language equivalents.');
  persist();
}
