import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Episode, TaskQuality } from '../src/shared/types';
import { discoverSkills } from '../src/core/skills';
import { hash } from '../src/core/util';

const common=[
  '确认用户的用途和预算，记录必须满足的条件以及需要交付的评估报告。',
  '读取项目官方文档和许可证，整理可核实的功能与使用限制。',
  '比较安装维护成本与已有方案，明确每项判断的证据和适用条件。',
  '编写说明采用理由及限制的报告，区分仓库声明和实际验证结果。'
];
const offline='检查离线环境下的安装依赖，列出需要预先下载的文件。';
const versions='核对实际发布版本与文档版本，记录两者之间的差异。';
function episode(id:string,steps=common,extra:Partial<Episode>={}):Episode {
  return {id,conversationId:`conversation-${id}`,source:id==='a'?'chatgpt':'claude',goal:'评估开源工具的适用性与实际采用成本',steps,inputs:['项目链接与使用场景'],outputs:['评估报告'],preferences:[],corrections:[],outcome:'accepted',evidence:steps.map(quote=>({messageId:`message-${id}`,quote})),contentHash:hash([id,steps]),analysis:'extractive',scope:'general',updatedAt:'2026-10-29T00:00:00Z',...extra};
}
const procedure=(markdown:string)=>markdown.split('\n').filter(line=>/^\d+\. /.test(line)).map(line=>line.replace(/^\d+\. /,''));

test('portable procedures preserve exact acceptance arguments omitted by natural-language descriptions',()=>{
  const checks:TaskQuality['checks']=[
    {op:'contains',arg:'PUBLIC-ANONYMIZED',description:'Include the required classification label.',messageId:'request',quote:'PUBLIC-ANONYMIZED'},
    {op:'not_contains',arg:'INTERNAL-RESTRICTED',description:'Exclude the restricted classification label.',messageId:'request',quote:'INTERNAL-RESTRICTED'},
    {op:'max_chars',arg:500,description:'Keep the agreed length.',messageId:'request',quote:'500'}
  ];
  const [skill]=discoverSkills([episode('a',common,{quality:{basis:'rules',checks},outputLanguage:'en'})],[]).skills;
  const steps=procedure(skill.markdown);assert.deepEqual(steps.slice(0,4),common);
  assert.match(steps.at(-1)!,/confirm.*apply.*Output must contain: "PUBLIC-ANONYMIZED"/);
  assert.match(steps.at(-1)!,/Output must not contain: "INTERNAL-RESTRICTED"/);
  assert.match(steps.at(-1)!,/Maximum output characters: 500/);
  assert.equal(skill.validation.valid,true);
});

test('complementary sources retain both unique steps, criteria and partial-order disclosure',()=>{
  const quality=(text:string):TaskQuality=>({basis:'rubric',rubric:{text,messageId:'request',quote:text},checks:[]});
  const episodes=[episode('a',[...common,offline],{quality:quality('报告中应说明离线安装准备。')}),episode('b',[...common,versions],{quality:quality('报告中应明确核对的发布版本。')})];
  const result=discoverSkills(episodes,[]);assert.equal(result.skills.length,1);
  const skill=result.skills[0],steps=procedure(skill.markdown);
  assert.deepEqual(steps.slice(0,4),common);assert.equal(steps.length,6);
  assert.ok(steps.includes(offline));assert.ok(steps.includes(versions));
  assert.ok(skill.markdown.includes('报告中应说明离线安装准备。'));assert.ok(skill.markdown.includes('报告中应明确核对的发布版本。'));
  assert.ok(skill.validation.warnings.some(warning=>warning.includes('no evidenced relative order')));
  assert.deepEqual(new Set(skill.evidenceIds),new Set(['a','b']));assert.equal(skill.sources.length,2);
});

test('anchored insertions preserve each historical ordering without duplicate shared steps',()=>{
  const left=episode('a',[common[0],offline,...common.slice(1)]),right=episode('b',[...common.slice(0,3),versions,common[3]]);
  const skills=discoverSkills([left,right],[]).skills;assert.equal(skills.length,1);
  const steps=procedure(skills[0].markdown);assert.equal(steps.length,6);
  assert.ok(steps.indexOf(common[0])<steps.indexOf(offline));assert.ok(steps.indexOf(offline)<steps.indexOf(common[1]));
  assert.ok(steps.indexOf(common[2])<steps.indexOf(versions));assert.ok(steps.indexOf(versions)<steps.indexOf(common[3]));
  assert.ok(!skills[0].validation.warnings.some(warning=>warning.includes('no evidenced relative order')));
});

test('opposite orders and similar conditional alternatives stay separate',()=>{
  const reversed=discoverSkills([episode('a'),episode('b',[common[1],common[0],...common.slice(2)])],[]).skills;
  assert.equal(reversed.length,2);assert.ok(reversed.some(skill=>procedure(skill.markdown)[0]===common[1]));
  const alternative=discoverSkills([episode('a',[...common,'Upload the original records to the archive.']),episode('b',[...common,'Do not upload the original records to the archive.'])],[]).skills;
  assert.equal(alternative.length,2);
  const operator=discoverSkills([episode('a',[...common,'Install the package only when version < 3.']),episode('b',[...common,'Install the package only when version > 3.'])],[]).skills;
  assert.equal(operator.length,2);
});

test('a matching topic does not merge unrelated procedures',()=>{
  const unrelated=['Interview the support team about staffing and training requirements.','Run a customer workshop and score usability feedback.','Summarize workshop findings and the staffing estimate.'];
  const skills=discoverSkills([episode('a'),episode('b',unrelated)],[]).skills;
  assert.equal(skills.length,2);assert.ok(skills.some(skill=>procedure(skill.markdown).join('\n')===unrelated.join('\n')));
});

test('exact anchors preserve case-sensitive literal values',()=>{
  const upper='Verify the exported item has SKU 00A.';
  const lower='Verify the exported item has SKU 00a.';
  const skills=discoverSkills([episode('a',[...common,upper]),episode('b',[...common,lower])],[]).skills;
  assert.equal(skills.length,2);
  assert.ok(skills.some(skill=>procedure(skill.markdown).includes(upper)));
  assert.ok(skills.some(skill=>procedure(skill.markdown).includes(lower)));
  assert.ok(skills.every(skill=>!(procedure(skill.markdown).includes(upper)&&procedure(skill.markdown).includes(lower))));
});

test('failed evidence cannot restore rejected steps or rejected success criteria',()=>{
  const correction='先前的上传步骤已被否定，不应继续沿用。';
  const failed=episode('failed',[...common,'Upload private source records to a public archive.'],{outcome:'failed',corrections:[correction],quality:{basis:'rubric',rubric:{text:'Require all private records in the final public archive.',messageId:'old-request',quote:'old requirement'},checks:[]}});
  const result=discoverSkills([episode('a'),episode('b',[...common,versions]),failed],[]);
  assert.equal(result.skills.length,1);assert.ok(!result.skills[0].markdown.includes('Upload private source records'));
  assert.ok(!result.skills[0].markdown.includes('Require all private records'));assert.ok(result.skills[0].markdown.includes(correction));
  assert.ok(!result.skills[0].evidenceIds.includes('failed'));
});

test('incompatible deterministic acceptance conditions are not combined',()=>{
  const quality=(op:'min_chars'|'max_chars',arg:number):TaskQuality=>({basis:'format-only',checks:[{op,arg,description:`${op}: ${arg}`,messageId:'request',quote:`${op}: ${arg}`}]});
  const result=discoverSkills([episode('a',common,{quality:quality('max_chars',100)}),episode('b',common,{quality:quality('min_chars',200)})],[]);
  assert.equal(result.skills.length,2);assert.equal(new Set(result.skills.map(skill=>skill.id)).size,2);assert.equal(new Set(result.skills.map(skill=>skill.name)).size,2);
  assert.ok(result.skills.every(skill=>!(skill.markdown.includes('max_chars: 100')&&skill.markdown.includes('min_chars: 200'))));
});

test('rejected project procedures do not leak corrections into another project',()=>{
  const own=episode('a',common,{scope:'project'});
  const other=episode('b',common,{scope:'project',outcome:'failed',corrections:['OTHER_PROJECT_CORRECTION']});
  const result=discoverSkills([own,other],[]);assert.equal(result.skills.length,1);assert.ok(!result.skills[0].markdown.includes('OTHER_PROJECT_CORRECTION'));
});

test('three-source ordering cycles do not create an invalid combined sequence',()=>{
  const prefix=common.slice(0,2),suffix=common.slice(2);
  const x='Record offline dependencies.',y='Inventory archive permissions.',z='Capture installed versions.';
  const episodes=[episode('a',[...prefix,x,y,...suffix]),episode('b',[...prefix,y,z,...suffix]),episode('c',[...prefix,z,x,...suffix])];
  const result=discoverSkills(episodes,[]);assert.ok(result.skills.length>1);
  for(const skill of result.skills)for(const id of skill.evidenceIds){const original=episodes.find(e=>e.id===id)!.steps;const output=procedure(skill.markdown);for(let i=1;i<original.length;i++)assert.ok(output.indexOf(original[i-1])<output.indexOf(original[i]));}
});

test('input ordering and unchanged reruns preserve identities/content and user edits',()=>{
  const episodes=[episode('a',[...common,offline]),episode('b',[...common,versions])];
  const first=discoverSkills(episodes,[]).skills;const shuffled=discoverSkills([...episodes].reverse(),[]).skills;
  assert.equal(first.length,1);assert.equal(first[0].id,shuffled[0].id);assert.equal(first[0].markdown,shuffled[0].markdown);
  const repeated=discoverSkills([...episodes].reverse(),first).skills[0];assert.equal(repeated.id,first[0].id);assert.equal(repeated.markdown,first[0].markdown);
  const edited={...first[0],markdown:first[0].markdown+'\nMy scoped clarification.\n',userEdited:true};
  const revised=discoverSkills(episodes,[edited]).skills[0];assert.equal(revised.markdown,edited.markdown);assert.equal(revised.proposedRevision,first[0].markdown);
});
