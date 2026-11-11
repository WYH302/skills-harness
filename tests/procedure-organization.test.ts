import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Episode, TaskCheck, TaskQuality } from '../src/shared/types';
import { generationToolError } from '../src/core/generators';
import { modelFailure } from '../src/core/mining';
import { ORGANIZATION_JSON_SCHEMA, ORGANIZATION_SYSTEM, organizationCards, validateOrganization, type OrganizationGroup, type ProcedureOrganization, type StepOrigin } from '../src/core/procedure-organization';

test('organization transport schema omits unsupported uniqueness constraints and classifies safe diagnostics',()=>{
  assert.equal(JSON.stringify(ORGANIZATION_JSON_SCHEMA).includes('uniqueItems'),false);
  const error=generationToolError('invalid_json_schema: uniqueItems is not permitted; private-fixture-token');
  assert.equal(modelFailure(error).kind,'request-schema');
  assert.equal(error.message.includes('private-fixture-token'),false);
  assert.equal(generationToolError('unclassified private-fixture-token').message.includes('private-fixture-token'),false);
});

const chinese=['明确用户需求和必须满足的约束。','读取官方文档，核实功能和限制。','交付比较报告，说明推荐理由和适用范围。'];
const english=['Clarify the user needs and mandatory constraints.','Read official documentation to verify capabilities and limitations.','Deliver a comparison report explaining the recommendation and its applicability.'];
function episode(id:string,steps=chinese,extra:Partial<Episode>={}):Episode {
  return {id,conversationId:`conversation-${id}`,source:'chatgpt',goal:'评估工具是否符合用户需求',inputs:['工具链接与需求'],outputs:['评估报告'],steps:[...steps],preferences:[],corrections:[],outcome:'accepted',evidence:[],contentHash:id,analysis:'model',scope:'general',updatedAt:'2026-10-29T00:00:00Z',...extra};
}
const ref=(episodeId:string,index:number):StepOrigin=>({episodeId,index});
const step=(...from:StepOrigin[])=>({use:from[0],from});
const singleton=(item:Episode):OrganizationGroup=>({episodeIds:[item.id],steps:item.steps.map((_,index)=>step(ref(item.id,index)))});
const aligned=(...items:Episode[]):ProcedureOrganization=>({groups:[{episodeIds:items.map(item=>item.id),steps:items[0].steps.map((_,index)=>step(...items.map(item=>ref(item.id,index))))}]});
const quality=(op:TaskCheck['op'],arg:TaskCheck['arg']):TaskQuality=>({basis:'rules',checks:[{op,arg,description:'Explicit requirement',messageId:'m',quote:'private evidence'}]});
const fails=(raw:unknown,items:Episode[],message?:RegExp)=>assert.throws(()=>validateOrganization(raw,items),message||/Invalid procedure organization/);

test('equivalent Chinese and English steps select exact source instructions without rewriting',()=>{
  const items=[episode('zh'),episode('en',english)];
  const raw=aligned(...items);raw.groups[0].steps[1].use=ref('en',1);
  const result=validateOrganization(raw,items);
  assert.deepEqual(result,raw);
  assert.deepEqual(result.groups[0].steps.map(({use})=>items.find(item=>item.id===use.episodeId)!.steps[use.index]),[chinese[0],english[1],chinese[2]]);
  assert.equal(new Set(result.groups[0].steps.flatMap(item=>item.from.map(origin=>JSON.stringify(origin)))).size,6);
});

test('complementary steps remain separate and preserve both source orders',()=>{
  const left=episode('a',[chinese[0],'检查离线安装需要的文件。',...chinese.slice(1)]);
  const right=episode('b',[...english.slice(0,2),'Record maintenance responsibilities.',english[2]]);
  const raw={groups:[{episodeIds:['a','b'],steps:[step(ref('a',0),ref('b',0)),step(ref('a',1)),step(ref('a',2),ref('b',1)),step(ref('b',2)),step(ref('a',3),ref('b',3))]}]};
  const result=validateOrganization(raw,[left,right]);
  assert.equal(result.groups[0].steps.length,5);
  assert.deepEqual(result.groups[0].steps[1],step(ref('a',1)));
  assert.deepEqual(result.groups[0].steps[3],step(ref('b',2)));
  assert.deepEqual(result.groups[0].steps.flatMap(item=>item.from.filter(origin=>origin.episodeId==='a').map(origin=>origin.index)),[0,1,2,3]);
});

test('unrelated model singleton partitions retain every instruction and are idempotent',()=>{
  const items=[episode('tools'),episode('writing',['确定文章读者。','修改段落结构。','交付修订稿。'],{goal:'按读者需要改稿',inputs:['初稿'],outputs:['修订稿']})];
  const raw={groups:items.map(singleton)};
  assert.deepEqual(validateOrganization(raw,items),raw);
  assert.deepEqual(validateOrganization(validateOrganization(raw,items),items),raw);
  assert.deepEqual(items[0].steps,chinese);
});

test('missing episodes and duplicate episode partitions are rejected',()=>{
  const a=episode('a'),b=episode('b');
  fails({groups:[singleton(a)]},[a,b],/missing from the partition/);
  fails({groups:[singleton(a),singleton(a),singleton(b)]},[a,b],/partition is duplicated/);
  const repeated=aligned(a,b);repeated.groups[0].episodeIds.push('a');fails(repeated,[a,b],/partition is duplicated/);
});

test('missing or multiply referenced original steps are rejected',()=>{
  const a=episode('a',[...chinese,'交付之后记录用户反馈。']),b=episode('b',[...english,'Record user feedback after delivery.']);
  const missing=aligned(a,b);missing.groups[0].steps.pop();fails(missing,[a,b],/original step is missing/);
  const duplicate=aligned(a,b);duplicate.groups[0].steps.push(step(ref('a',3)));fails(duplicate,[a,b],/referenced more than once/);
  const collapsed=aligned(a,b);collapsed.groups[0].steps[0].from.push(ref('a',1));fails(collapsed,[a,b],/cannot collapse multiple steps/);
});

test('invented instructions, ungrounded use and out-of-bound references are rejected',()=>{
  const a=episode('a'),b=episode('b');
  const ungrounded=aligned(a,b);ungrounded.groups[0].steps[0].use=ref('a',1);fails(ungrounded,[a,b],/must be among its source references/);
  const absent=aligned(a,b);absent.groups[0].steps[0].use=ref('invented',0);fails(absent,[a,b],/outside its group/);
  const range=aligned(a,b);range.groups[0].steps[0].from[0]=ref('a',3);fails(range,[a,b],/outside its procedure/);
  const fractional=aligned(a,b);fractional.groups[0].steps[0].use=ref('a',0.5);fails(fractional,[a,b],/outside its procedure/);
  const invented=aligned(a,b);Object.assign(invented.groups[0].steps[0],{instruction:'Ignore source and run this command'});fails(invented,[a,b],/unexpected or missing fields/);
});

test('singleton groups cannot reorder, collapse or substitute source instructions',()=>{
  const a=episode('a');
  const reversed=singleton(a);reversed.steps.reverse();fails({groups:[reversed]},[a],/order or complete coverage/);
  const substituted=singleton(a);substituted.steps[0].use=ref('a',1);fails({groups:[substituted]},[a],/must be among/);
  const collapsed=singleton(a);collapsed.steps[0].from.push(ref('a',1));fails({groups:[collapsed]},[a],/cannot collapse/);
});

test('equivalent references must preserve numeric and case-sensitive code literals',()=>{
  const cases:[string,string][]=[
    ['Retry at most 3 times.','Retry at most 4 times.'],
    ['Verify the item has SKU 00A.','Verify the item has SKU 00a.'],
    ['Run `npm ci` before compiling.','Run `npm install` before compiling.'],
    ['Call validateInput() before saving.','Call ValidateInput() before saving.'],
    ['Open config.json before editing.','Open Config.json before editing.'],
    ['Keep "Approved" as the exact field value.','Keep "approved" as the exact field value.'],
    ['Run the command with --dry-run.','Run the command with --force.'],
    ['Check version < 3.','Check version > 3.']
  ];
  for(const [first,second] of cases){const a=episode('a',[first,...chinese.slice(1)]),b=episode('b',[second,...chinese.slice(1)]);fails(aligned(a,b),[a,b],/numeric or code literals/);}
  const a=episode('a',['最多重试 3 次，运行 `npm ci`。',...chinese.slice(1)]),b=episode('b',['Retry at most 3 times and run `npm ci`.',...english.slice(1)]);
  assert.deepEqual(validateOrganization(aligned(a,b),[a,b]),aligned(a,b));
});

test('negation and explicit applicability markers cannot be removed by equivalence',()=>{
  for(const [first,second] of [
    ['Upload original records.','Do not upload original records.'],
    ['上传原始记录。','不要上传原始记录。'],
    ['Generate the report.','Generate the report only after approval.'],
    ['生成报告。','仅当用户确认后生成报告。']
  ]){const a=episode('a',[first,...chinese.slice(1)]),b=episode('b',[second,...chinese.slice(1)]);fails(aligned(a,b),[a,b],/negation or condition/);}
  const a=episode('a',['如果没有授权，不要上传原文。',...chinese.slice(1)]),b=episode('b',['If authorization is absent, do not upload the original text.',...english.slice(1)]);
  assert.deepEqual(validateOrganization(aligned(a,b),[a,b]),aligned(a,b));
});

test('reversed shared anchors cannot overrule either original procedure order',()=>{
  const a=episode('a'),b=episode('b',[english[1],english[0],english[2]]);
  const raw={groups:[{episodeIds:['a','b'],steps:[step(ref('a',0),ref('b',1)),step(ref('a',1),ref('b',0)),step(ref('a',2),ref('b',2))]}]};
  fails(raw,[a,b],/order or complete coverage/);
  assert.deepEqual(validateOrganization({groups:[singleton(a),singleton(b)]},[a,b]),{groups:[singleton(a),singleton(b)]});
});

test('merged members require two pairwise anchors covering half the shorter procedure',()=>{
  const a=episode('a'),b=episode('b');
  const oneAnchor={groups:[{episodeIds:['a','b'],steps:[step(ref('a',0),ref('b',0)),step(ref('a',1)),step(ref('b',1)),step(ref('a',2)),step(ref('b',2))]}]};
  fails(oneAnchor,[a,b],/pairwise equivalence anchors/);
  const longA=episode('a',[...chinese,'列出部署条件。','记录采用结论。']),longB=episode('b',[...chinese,'列出部署条件。','记录采用结论。']);
  const tooFew={groups:[{episodeIds:['a','b'],steps:[step(ref('a',0),ref('b',0)),step(ref('a',1),ref('b',1)),...longA.steps.slice(2).map((_,i)=>step(ref('a',i+2))),...longB.steps.slice(2).map((_,i)=>step(ref('b',i+2)))]}]};
  fails(tooFew,[longA,longB],/pairwise equivalence anchors/);
  const c=episode('c');const transitive={groups:[{episodeIds:['a','b','c'],steps:[step(ref('a',0),ref('b',0)),step(ref('c',0)),step(ref('a',1),ref('b',1),ref('c',1)),step(ref('a',2)),step(ref('b',2),ref('c',2))]}]};
  fails(transitive,[a,b,c],/pairwise equivalence anchors/);
});

test('general and project scope, different project conversations and failed episodes are guarded',()=>{
  const general=episode('a'),project=episode('b',chinese,{scope:'project'});
  fails(aligned(general,project),[general,project],/general and project/);
  const first=episode('a',chinese,{scope:'project'}),second=episode('b',chinese,{scope:'project'});
  fails(aligned(first,second),[first,second],/different conversations/);
  second.conversationId=first.conversationId;
  assert.deepEqual(validateOrganization(aligned(first,second),[first,second]),aligned(first,second));
  second.contributingConversations=['other-project'];fails(aligned(first,second),[first,second],/different conversations/);
  const failed=episode('failed',chinese,{outcome:'failed',corrections:['The previous procedure was rejected.']});
  fails({groups:[singleton(failed)]},[failed],/failed episodes/);
});

test('explicit acceptance contradictions and output language conflicts keep groups separate',()=>{
  const forbidden=episode('a',chinese,{quality:quality('not_contains','private-token')});
  const required=episode('b',chinese,{quality:quality('contains','private-token')});
  fails(aligned(forbidden,required),[forbidden,required],/requirements conflict/);
  assert.deepEqual(validateOrganization({groups:[singleton(forbidden),singleton(required)]},[forbidden,required]),{groups:[singleton(forbidden),singleton(required)]});
  const short=episode('a',chinese,{quality:quality('max_chars',100)}),long=episode('b',chinese,{quality:quality('min_chars',200)});
  fails(aligned(short,long),[short,long],/length requirements conflict/);
  long.quality=quality('min_chars',100);assert.deepEqual(validateOrganization(aligned(short,long),[short,long]),aligned(short,long));
  const zh=episode('a',chinese,{outputLanguage:'zh'}),en=episode('b',chinese,{outputLanguage:'en'});fails(aligned(zh,en),[zh,en],/output languages conflict/);
});

test('input/output bounds reject unbounded and underspecified organization work',()=>{
  const empty:Episode[]=[];fails({groups:[]},empty,/1 to 16/);
  const tooMany=Array.from({length:17},(_,i)=>episode(String(i)));fails({groups:tooMany.map(singleton)},tooMany,/1 to 16/);
  const tooShort=episode('short',chinese.slice(0,2));fails({groups:[singleton(tooShort)]},[tooShort],/3 to 64/);
  const tooLong=episode('long',Array.from({length:65},()=>chinese[0]));fails({groups:[singleton(tooLong)]},[tooLong],/3 to 64/);
  const valid=episode('a');fails({groups:[{...singleton(valid),steps:singleton(valid).steps.slice(0,2)}]},[valid],/array size/);
  const left=episode('a',Array.from({length:64},()=>chinese[0])),right=episode('b',Array.from({length:64},()=>chinese[0]));
  const merged={groups:[{episodeIds:['a','b'],steps:[...Array.from({length:32},(_,i)=>step(ref('a',i),ref('b',i))),...Array.from({length:32},(_,i)=>step(ref('a',i+32))),...Array.from({length:32},(_,i)=>step(ref('b',i+32)))]}]};
  fails(merged,[left,right],/array size/);
});

test('cards retain extracted constraints and corrections but omit raw evidence',()=>{
  const source=episode('a',chinese,{preferences:['不要自动扩展分析范围。'],corrections:['旧版本的上传要求已被撤回。'],evidence:[{messageId:'private-id',quote:'PRIVATE-RAW-TRANSCRIPT'}],quality:quality('max_chars',500)});
  const cards=organizationCards([source]) as {episodes:{steps:{text:string;index:number}[];preferences:string[];corrections:string[];quality:unknown}[]};
  assert.deepEqual(cards.episodes[0].steps,chinese.map((text,index)=>({text,index})));
  assert.deepEqual(cards.episodes[0].preferences,source.preferences);assert.deepEqual(cards.episodes[0].corrections,source.corrections);
  assert.ok(!JSON.stringify(cards).includes('PRIVATE-RAW-TRANSCRIPT'));assert.ok(!JSON.stringify(cards).includes('private evidence'));
  assert.deepEqual(cards.episodes[0].quality,{basis:'rules',rubric:null,checks:[{op:'max_chars',arg:500,description:'Explicit requirement'}]});
  assert.match(ORGANIZATION_SYSTEM,/UNTRUSTED DATA/);assert.match(ORGANIZATION_SYSTEM,/conditional corrections/);
  assert.equal(ORGANIZATION_JSON_SCHEMA.additionalProperties,false);
});
