// Adapted from microsoft/SkillOpt, skillopt_sleep/llm_miner.py (_mk_task)
// and skillopt_sleep/judges.py (char_bound, is_shape_only).
// Copyright (c) 2026 Microsoft Corporation. MIT; see third_party/skillopt/LICENSE.
import type { Evidence, TaskCheck, TaskQuality } from '../../shared/types';

const stringArgs=new Set(['section_present','section_contains','regex','contains','not_contains','tool_called']);
const shapeOps=new Set(['section_present','section_contains','max_chars','min_chars']);

export function charBound(value:unknown):number {
  // Python's parser accepts integer strings but rejects bools and fractions.
  if(typeof value==='boolean'||value===null||value===undefined||typeof value==='object')throw new Error('Integer bound required');
  if(typeof value==='string'&&!/^[+-]?\d+$/.test(value.trim()))throw new Error('Integer bound required');
  const bound=Number(value);
  if(!Number.isSafeInteger(bound))throw new Error('Integer bound required');
  return bound;
}

export function isShapeOnly(checks:Pick<TaskCheck,'op'>[]):boolean {
  return checks.length>0&&checks.every(check=>shapeOps.has(check.op));
}

function record(value:unknown):Record<string,unknown>|undefined {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
}
function citation(value:Record<string,unknown>):Evidence|undefined {
  return typeof value.messageId==='string'&&typeof value.quote==='string'&&value.quote.length>=8?{messageId:value.messageId,quote:value.quote}:undefined;
}

export function cleanTaskQuality(value:unknown,supported:(ref:Evidence)=>boolean):TaskQuality|undefined {
  const obj=record(value);if(!obj)return undefined;
  const rubricObject=record(obj.rubric);const rubricRef=rubricObject&&citation(rubricObject);
  // Upstream gives a substantive rubric priority over literal string checks.
  // Here both kinds additionally require an exact USER-message citation.
  const rubric=rubricObject&&typeof rubricObject.text==='string'&&rubricObject.text.trim().length>=8&&rubricRef&&supported(rubricRef)?{text:rubricObject.text.trim().slice(0,650),...rubricRef}:undefined;
  const checks:TaskCheck[]=[];
  for(const item of Array.isArray(obj.checks)?obj.checks.slice(0,12):[]) {
    const c=record(item);if(!c||typeof c.op!=='string')continue;
    const ref=citation(c);if(!ref||!supported(ref))continue;
    const description=typeof c.description==='string'?c.description.trim().slice(0,400):'';
    if(!description)continue;
    let arg:TaskCheck['arg'];
    if(stringArgs.has(c.op)) {
      if(typeof c.arg!=='string'||!c.arg.trim()||c.arg.length>650)continue;
      arg=c.op==='regex'?c.arg:c.arg.trim();
      // Keep verifier syntax out of reusable instructions, as upstream does.
      if(c.op==='regex'&&description.includes(arg))continue;
    }else if(c.op==='max_chars'||c.op==='min_chars') {
      try {arg=charBound(c.arg);}catch{continue;}
      if(arg<0)continue;
    }else if(c.op==='no_refusal')arg=null;
    else continue;
    checks.push({op:c.op as TaskCheck['op'],arg,description,...ref});
  }
  if(!rubric&&!checks.length)return undefined;
  return {rubric,checks,basis:rubric?'rubric':isShapeOnly(checks)?'format-only':'rules'};
}
