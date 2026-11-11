import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EvaluationLedger } from '../scripts/evaluation-runtime';
import { transferCases } from '../scripts/transfer-fixtures';
import { normalizeBlockerSources } from '../scripts/transfer-rescore';

test('evaluation graders reject empty and known incorrect task outputs',()=>{
  for(const c of transferCases){assert.ok(c.grade({}).every(r=>!r.passed));assert.ok(c.grade(null).every(r=>!r.passed));}
  const research=transferCases.find(c=>c.id==='document-evidence')!;
  assert.equal(research.grade({independentStudyCount:4,causalBenefitEstablished:true,roiPercent:30,contraryEvidenceSources:[],decision:'rollout'}).filter(r=>r.passed).length,0);
  assert.ok(research.grade({independentStudyCount:2,causalBenefitEstablished:false,roiPercent:null,contraryEvidenceSources:['S4'],decision:'defer'}).every(r=>r.passed));
});
test('source normalization accepts prefixed IDs without treating explanation mentions as references',()=>{
  const grade=transferCases.find(c=>c.id==='tool-adoption')!.grade;
  const answer={decision:'defer',commercialRedistributionCleared:false,offlineReadyVerified:false,installationActuallyTested:false,documentationVersion:'4.0',releaseVersion:'3.2',blockerSources:['LICENSE: Missing agreement','FILES: Weights absent']};
  assert.ok(grade(normalizeBlockerSources(answer)).every(c=>c.passed));
  assert.equal(grade(normalizeBlockerSources({...answer,blockerSources:['OTHER: mentions LICENSE and FILES here']})).filter(c=>c.passed).length,3);
});
test('evaluation calls reserve cumulatively, cache replies and charge failures before retry',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-eval-budget-'));let calls=0;
  const upstream={id:'fixture',estimateInput:()=>10,complete:async()=>{calls++;if(calls===2)throw new Error('fixture failure');return '{"ok":true}';}};
  const ledger=new EvaluationLedger(dir,2,20,true,upstream);const signal=new AbortController().signal;
  assert.equal(await ledger.transport.complete('s','a',signal,{}),'{"ok":true}');
  assert.equal(await ledger.transport.complete('s','a',signal,{}),'{"ok":true}');assert.equal(calls,1);
  await assert.rejects(ledger.transport.complete('s','b',signal,{}),/fixture failure/);
  const resumed=new EvaluationLedger(dir,2,20,true,upstream);
  await assert.rejects(resumed.transport.complete('s','b',signal,{}),/budget/);assert.equal(calls,2);
  const replay=new EvaluationLedger(dir,2,20,false);
  assert.equal(replay.transport.estimateInput!('s','a',{}),10);
  assert.equal(await replay.transport.complete('s','a',signal,{}),'{"ok":true}');
  await assert.rejects(replay.transport.complete('s','c',signal,{}),/requires --live/);assert.equal(calls,2);
});
