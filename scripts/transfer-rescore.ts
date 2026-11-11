// Explicit scoring correction: the frozen schema allowed source strings with
// explanations, but the initial grader demanded bare IDs. Preserve raw grades.
import { readFileSync, writeFileSync } from 'node:fs';
import { transferCases } from './transfer-fixtures';

export function normalizeBlockerSources(answer:any):any {
  if(!answer||!Array.isArray(answer.blockerSources))return answer;
  return {...answer,blockerSources:answer.blockerSources.flatMap((value:unknown)=>typeof value==='string'?value.split(':',1)[0].split('/').map(v=>v.trim()):[])};
}
export function rescoreTransfer(){
  const file='examples/transfer-evaluation/RESULTS.json';const original=JSON.parse(readFileSync(file,'utf8'));
  const report=structuredClone(original);report.scoringCorrection={id:'source-prefix-v1',reason:'The task schema allowed descriptive source strings. Initial exact-ID grading incorrectly rejected LICENSE: explanation and FILES: explanation. Correction is applied uniformly to all conditions; original outputs and original grades are retained.',modelCalls:0,originalReport:'RESULTS.json'};
  for(const row of report.cases)for(const condition of row.conditions){if(row.id!=='tool-adoption'||!condition.answer)continue;condition.originalChecks=condition.checks;condition.originalPassed=condition.passed;condition.checks=transferCases.find(c=>c.id===row.id)!.grade(normalizeBlockerSources(condition.answer));condition.passed=condition.checks.filter((c:any)=>c.passed).length;}
  writeFileSync('examples/transfer-evaluation/CORRECTED_RESULTS.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({scoringCorrection:report.scoringCorrection,cases:report.cases.map((c:any)=>({id:c.id,conditions:c.conditions.map((r:any)=>({condition:r.condition,passed:r.passed,total:r.total,originalPassed:r.originalPassed}))}))},null,2));
}
if(process.argv.includes('--rescore'))rescoreTransfer();
