// Authored synthetic histories and independent held-out tasks. No real people,
// repositories, files or user transcripts. Freeze fixtures before inference.
import type { Conversation } from '../src/shared/types';
import { normalizeConversation } from '../src/core/util';

export interface CheckResult {name:string;passed:boolean}
export interface TransferCase {id:string;training:Conversation[];task:unknown;schema:unknown;grade:(answer:any)=>CheckResult[]}
const string={type:'string'};const bool={type:'boolean'};
const array=(items:unknown)=>({type:'array',items});
const object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const check=(name:string,passed:boolean):CheckResult=>({name,passed});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sorted=(value:unknown)=>Array.isArray(value)?[...value].sort():[];

function training(id:string,goal:string,input:string,steps:string[],outputs:string,correction?:string):Conversation[]{
  return ['chatgpt','claude'].map((source,index)=>normalizeConversation({source:source as 'chatgpt'|'claude',externalId:`transfer-train-${id}-${index}`,title:`Synthetic training: ${goal}`,completeness:'full',warnings:['Authored synthetic history, not a real user trace.'],messages:[
    {id:'u',role:'user',text:`Please ${goal}. Input: ${input}. Use case ${index===0?'Alder':'Birch'}, a fictional example. Output: ${outputs}. These are my standing preferences for this workflow.`},
    ...(correction?[{id:'old',role:'assistant' as const,text:'I would combine conflicting records by keeping the latest value.'},{id:'fix',role:'user' as const,text:`That is wrong. ${correction}`}]:[]),
    {id:'a',role:'assistant',text:`Completed the ${index===0?'Alder':'Birch'} example using this method:\n${steps.map((s,i)=>`${i+1}. ${s}`).join('\n')}\nDelivered ${outputs} for this example; original inputs are preserved.`},
    {id:'ok',role:'user',text:'Approved, that works. Keep using this procedure and retain uncertainty when the source does not support a conclusion.'}
  ]}));
}

const csv:TransferCase={id:'inventory-reconciliation',training:training('inventory','reconcile inventory exports without losing conflicting records','rows with row ID, warehouse, SKU and quantity',[
  'Read row IDs and preserve warehouse and SKU as text, including leading zeros and case; trim surrounding spaces only.',
  'Build the comparison key from warehouse and SKU together, so the same SKU in different warehouses remains independent.',
  'Remove exact duplicate rows first, recording each duplicate row ID and its earliest original row ID in the ledger.',
  'Quarantine every remaining row sharing a key with conflicting quantities; never select the latest quantity or add quantities together.',
  'Quarantine rows with a missing warehouse or SKU and record the reason without inventing an identifier.',
  'Write the uncontested rows to a new output and account for every input row as kept, duplicate or quarantined; retain the original input unchanged.'
 ],'a new inventory table and a row-by-row disposition ledger','Do not keep the latest conflicting value. Quarantine both distinct values; deduplicate exact copies first.'),
 task:{instruction:'Reconcile this new inventory export using my usual workflow. Produce an output table and a disposition ledger. Do not modify any files.',rows:[
  {id:'r1',warehouse:'north',sku:'007',quantity:10},{id:'r2',warehouse:'north',sku:'007',quantity:10},{id:'r3',warehouse:'north',sku:'007',quantity:11},
  {id:'r4',warehouse:'south',sku:'007',quantity:7},{id:'r5',warehouse:'north',sku:'008',quantity:5},{id:'r6',warehouse:'north',sku:'00a',quantity:4},{id:'r7',warehouse:'north',sku:'00A',quantity:6},{id:'r8',warehouse:'north',sku:'',quantity:3}]},
 schema:object({output:array(object({warehouse:string,sku:string,quantity:{type:'number'}})),ledger:array(object({id:string,status:{type:'string',enum:['kept','duplicate','quarantined']},duplicateOf:{anyOf:[string,{type:'null'}]},reason:string}))}),
 grade:a=>{const ledger=Array.isArray(a?.ledger)?a.ledger:[];const status=(id:string)=>ledger.find((r:any)=>r.id===id);const output=Array.isArray(a?.output)?a.output:[];return [
  check('Every input row accounted for exactly once',same(sorted(ledger.map((r:any)=>r.id)),['r1','r2','r3','r4','r5','r6','r7','r8'])),
  check('Conflicting quantities quarantined, not overwritten',status('r1')?.status==='quarantined'&&status('r3')?.status==='quarantined'&&!output.some((r:any)=>r.warehouse==='north'&&r.sku==='007')),
  check('Exact duplicate has an explicit original',status('r2')?.status==='duplicate'&&status('r2')?.duplicateOf==='r1'),
  check('Missing identifier quarantined',status('r8')?.status==='quarantined'),
  check('Leading zeros, case and warehouse keys retained',same(output.map((r:any)=>`${r.warehouse}|${r.sku}|${r.quantity}`).sort(),['north|008|5','north|00A|6','north|00a|4','south|007|7'].sort()))
 ];}
};

const research:TransferCase={id:'document-evidence',training:training('evidence','assess evidence across document excerpts without overstating conclusions','numbered source excerpts, study identifiers and a decision question',[
  'Read the decision question and extract each measurable claim together with its source identifier.',
  'Group reports about the same primary study as one independent evidence unit; repeated press coverage is not another study.',
  'Compare methods and outcomes across independent studies, retaining contrary results instead of selecting the most favorable claim.',
  'Separate observational associations from causal evidence; record when nonrandomized results cannot establish causality.',
  'Calculate a financial return only when both benefits and all relevant costs are supplied; use unknown rather than a guessed return.',
  'Write an evidence table with source identifiers, a bounded decision and specific unresolved facts needed for that decision.'
 ],'an evidence summary separating independent studies, causal support, return and missing information'),
 task:{instruction:'Assess whether the supplied excerpts justify rolling out the scheduling assistant. Use my usual evidence workflow; do not browse.',sources:[
  {id:'S1',study:'Orchard',text:'Nonrandomized pilot of 18 users reports a 15% reduction in scheduling time. Costs were not measured.'},
  {id:'S2',study:'Orchard',text:'Press release discussing the same Orchard pilot claims time savings up to 30%; no additional measurements are reported.'},
  {id:'S3',study:'Orchard',text:'A review cites the same 18-user Orchard pilot and repeats the 15% reduction.'},
  {id:'S4',study:'Harbor',text:'Independent nonrandomized pilot of 12 users reports scheduling time increased by 3%. Costs were not measured.'}]},
 schema:object({independentStudyCount:{type:'integer'},causalBenefitEstablished:bool,roiPercent:{anyOf:[{type:'number'},{type:'null'}]},contraryEvidenceSources:array(string),decision:{type:'string',enum:['rollout','defer']},explanation:string}),
 grade:a=>[
  check('Repeated reports not counted as independent studies',a?.independentStudyCount===2),
  check('Observational evidence not labeled causal proof',a?.causalBenefitEstablished===false),
  check('Missing costs produce unknown ROI',a?.roiPercent===null),
  check('Contrary evidence retained with its source',same(sorted(a?.contraryEvidenceSources),['S4'])),
  check('Broad rollout deferred on mixed limited evidence',a?.decision==='defer')]
};

const repository:TransferCase={id:'tool-adoption',training:training('repository','evaluate an open-source tool against deployment constraints','official documentation, shipped artifacts, license and intended use',[
  'Confirm the deployment constraints and maintenance budget before interpreting a repository feature list.',
  'Read the official license and identify unresolved redistribution or commercial-use restrictions before recommending adoption.',
  'Compare the documentation version with the shipped release version and mark features not evidenced in that release as unverified.',
  'Inspect the supplied offline artifact inventory for model weights and dependencies; a README claim alone does not establish offline readiness.',
  'Separate repository claims from actually verified capabilities and never state that an installation was tested without a test result.',
  'Write an adopt or defer recommendation with the specific blockers and the evidence needed to resolve each one.'
 ],'a deployment recommendation, release evidence table, license and offline blockers'),
 task:{instruction:'Decide whether to adopt the fictional Cedar assistant for an offline commercial redistribution next week. Use my usual tool evaluation method. Work only from the supplied evidence.',constraints:{offline:true,commercialRedistribution:true},sources:[
  {id:'README',text:'Documentation version 4.0 says fully offline use is supported.'},
  {id:'RELEASE',text:'Latest shipped release is 3.2. Its notes do not mention offline inference.'},
  {id:'LICENSE',text:'Research use only. Commercial redistribution requires a separate written agreement. No agreement is supplied.'},
  {id:'FILES',text:'The archive contains client.js, package.json and README.md. No model weights or dependency archive is included.'},
  {id:'TESTS',text:'No installation or runtime test results have been supplied.'}]},
 schema:object({decision:{type:'string',enum:['adopt','defer']},commercialRedistributionCleared:bool,offlineReadyVerified:bool,installationActuallyTested:bool,documentationVersion:string,releaseVersion:string,blockerSources:array(string),nextChecks:array(string)}),
 grade:a=>[
  check('Adoption deferred pending blockers',a?.decision==='defer'),
  check('License restriction retained',a?.commercialRedistributionCleared===false&&a?.blockerSources?.includes('LICENSE')),
  check('Offline claim not treated as verification',a?.offlineReadyVerified===false&&a?.blockerSources?.includes('FILES')),
  check('No fabricated installation test',a?.installationActuallyTested===false),
  check('Release/documentation mismatch retained',a?.documentationVersion==='4.0'&&a?.releaseVersion==='3.2')]
};

export const transferCases:TransferCase[]=[csv,research,repository];
