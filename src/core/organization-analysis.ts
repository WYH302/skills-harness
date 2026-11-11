import type { Conversation, Episode, Run, Settings } from '../shared/types';
import { BudgetError, ModelAnalyzer, modelFailure } from './mining';
import { Store } from './store';
import { hash, redact } from './util';
import { extractJsonObject } from '../vendor/skillopt/history';
import { ORGANIZATION_VERSION, ORGANIZATION_SYSTEM, ORGANIZATION_JSON_SCHEMA, organizationCards, validateOrganization, type ProcedureOrganization, type OrganizationGroup } from './procedure-organization';

interface SavedOrganization {hashes:Record<string,string>;groups:OrganizationGroup[]}
const fingerprint=(episode:Episode)=>hash([episode.contentHash,organizationCards([episode])]);
const ids=(group:OrganizationGroup)=>group.episodeIds;
function methodFingerprint(episode:Episode):string {
  const {id,conversationId,source,outcome,...method}=(organizationCards([episode]) as {episodes:Record<string,unknown>[]}).episodes[0];
  return hash(method);
}

/** This stage sees derived procedure cards, never every transcript. Scope, cost and
 * retries use the same consent/budget as extraction; previous decisions are local. */
export async function organizeProcedures(store:Store,run:Run,settings:Settings,model:ModelAnalyzer|null,episodes:Episode[],scoped:Conversation[],signal:AbortSignal,update:()=>void):Promise<ProcedureOrganization|undefined> {
  const current=new Map(episodes.map(e=>[e.id,e]));
  const old=store.getMeta<SavedOrganization>('procedureOrganization',{hashes:{},groups:[]});
  const retained:OrganizationGroup[]=[];
  for(const group of old.groups){
    const members=ids(group).map(id=>current.get(id));
    if(members.some(e=>!e||e.outcome==='failed'||e.steps.length<3||e.steps.length>64||old.hashes[e.id]!==fingerprint(e)))continue;
    try{retained.push(...validateOrganization({groups:[group]},members as Episode[]).groups);}catch{/* Stale/invalid derived data is not an instruction to merge. */}
  }
  const scopeIds=new Set(scoped.map(c=>c.id));
  const eligible=episodes.filter(e=>e.analysis==='model'&&e.outcome!=='failed'&&e.steps.length>=3&&e.steps.length<=64&&(e.executionEvidence||0)>=2&&
    (e.contributingConversations||[e.conversationId]).every(id=>scopeIds.has(id))&&
    e.evidence.every(ref=>scoped.some(c=>c.id===(ref.conversationId||e.conversationId)&&c.messages.some(m=>m.id===ref.messageId&&m.text.includes(ref.quote)))));
  if(!model||!settings.autoConsolidate||eligible.length<2)return retained.length?{groups:retained}:undefined;

  const partitions=new Map<string,Episode[]>();
  for(const e of [...eligible].sort((a,b)=>a.id.localeCompare(b.id))){const key=e.scope==='project'?`project:${e.conversationId}`:'general';const list=partitions.get(key)||[];list.push(e);partitions.set(key,list);}
  const batches:Episode[][]=[];let bounded=false;let deferred=0;const locallyExact=new Set<string>();
  const withUnreviewed=(groups:OrganizationGroup[]):ProcedureOrganization=>{
    const covered=new Set(groups.flatMap(ids));
    const separate=eligible.filter(e=>!covered.has(e.id)&&!locallyExact.has(e.id)).map(e=>({episodeIds:[e.id],steps:e.steps.map((_,index)=>({use:{episodeId:e.id,index},from:[{episodeId:e.id,index}]}))}));
    return {groups:[...groups,...separate]};
  };
  for(const partition of partitions.values()){
    // Exact procedures with identical triggers/constraints already merge locally.
    // Do not spend a model request merely to repeat that deterministic decision.
    if(new Set(partition.map(methodFingerprint)).size===1){partition.forEach(e=>locallyExact.add(e.id));continue;}
    let batch:Episode[]=[];let size=0;let count=0;
    for(const e of partition){
      const chars=JSON.stringify(organizationCards([e])).length;
      if(batch.length&&(batch.length>=16||size+chars>24000)){if(batch.length>1){batches.push(batch);count++;}else deferred+=Number(partition.length>1);batch=[];size=0;}
      batch.push(e);size+=chars;
    }
    if(batch.length>1){batches.push(batch);count++;}else deferred+=Number(partition.length>1);bounded ||= count>1||partition.length>16;
  }
  if(deferred){bounded=true;run.warnings.push(`${deferred} 个方法未能纳入同批比较，保留为独立方法。 / ${deferred} procedures could not fit a comparison batch and remain separate.`);}
  if(!batches.length)return withUnreviewed(retained);
  const system=ORGANIZATION_SYSTEM+`\nPreferred existing step language: ${run.outputLanguage||'source'}. Select an existing step; do not translate or write new text.`;
  const namespace=`organization:${ORGANIZATION_VERSION}`;
  const plans=batches.map(batch=>{
    const content=JSON.stringify(organizationCards(batch),(_key,value)=>settings.redactSensitive&&typeof value==='string'?redact(value):value);
    const key='procedure-alignment:'+hash([ORGANIZATION_VERSION,settings.analysisMode,settings.model,settings.endpoint,settings.generationConsentIdentity,system,content]);
    const saved=settings.incremental?store.cache<ProcedureOrganization>(key):undefined;
    let valid:ProcedureOrganization|undefined;try{if(saved)valid=validateOrganization(saved,batch);}catch{/* Recheck before reuse. */}
    return {batch,content,key,saved:valid,estimate:valid?{calls:0,inputChars:0}:model.estimateRequest(system,content,ORGANIZATION_JSON_SCHEMA,namespace)};
  });
  run.organization={episodes:eligible.length,batches:plans.length,completed:0,cached:0,pending:plans.length,mergedGroups:0,plannedCalls:plans.reduce((n,p)=>n+p.estimate.calls,0),plannedInputChars:plans.reduce((n,p)=>n+p.estimate.inputChars,0),bounded};update();
  const fresh:OrganizationGroup[]=[];const decided=new Set<string>();
  const persist=()=>{
    const groups=[...fresh,...retained.filter(group=>!ids(group).some(id=>decided.has(id)))];
    store.setMeta('procedureOrganization',{groups,hashes:Object.fromEntries(groups.flatMap(group=>ids(group).map(id=>[id,fingerprint(current.get(id)!)])))} satisfies SavedOrganization);
    return groups;
  };
  let unavailable=false;
  for(const plan of plans){
    signal.throwIfAborted();
    if(unavailable&&!plan.saved&&plan.estimate.calls>0)continue;
    try{
      const result=plan.saved||validateOrganization(extractJsonObject(await model.request(system,plan.content,signal,ORGANIZATION_JSON_SCHEMA,namespace)),plan.batch);
      if(!plan.saved)store.putCache(plan.key,result);
      fresh.push(...result.groups);result.groups.flatMap(ids).forEach(id=>decided.add(id));
      run.organization.completed++;run.organization.cached+=Number(!!plan.saved);
      run.organization.pending--;run.organization.mergedGroups+=result.groups.filter(g=>g.episodeIds.length>1).length;
      persist();update();
    }catch(error){
      if(signal.aborted)throw error;
      store.setMeta('lastModelFailure',modelFailure(error));
      run.warnings.push(error instanceof BudgetError?'方法归并达到本轮累计预算；已有技能和对齐结果已保留，可继续处理。 / Procedure organization reached the workflow budget; existing skills and alignments are saved for resume.':'方法归并暂未完成，未通过校验的对齐没有应用；已有步骤和技能已保留。 / Procedure organization is unfinished. Invalid alignments were not applied; existing steps and skills are retained.');
      unavailable=true;update();
    }
  }
  if(bounded)run.warnings.push('方法卡片分批比较；不同批次之间仍可能存在重复方法，不能视为全库语义去重已完成。 / Procedure cards were compared in bounded batches; cross-batch duplicates may remain.');
  // Pending model decisions must not be replaced by a weaker lexical merge.
  // Completed/retained alignments stay authoritative; other methods remain separate.
  return withUnreviewed(persist());
}
