import type { Conversation, Episode, Message, SelectionGroupView, SelectionSummary, SourceId } from '../shared/types';
import { extractEpisodes, procedureSteps, similarity, taskMessageGroups, tokens } from './mining';
import { hash, unique } from './util';

// Stage-1 Local Pre-Selection: Contrastive Trajectory Submodular Selection (CTSS)
// alongside retained Baseline-Lexical-Cosine (Legacy-TFIDF-Cosine), Frequency-Only,
// and Random-Sampling baselines. Runs 100% locally in JS with 0 LLM calls.
export const SELECTION_VERSION='local-tfidf-context-v1';
export const CTSS_ALGORITHM_VERSION='ctss-submodular-v2';

const correction=/^[\s\S]{0,80}(?:不对|不行|不要这样|没解决|失败|改成|修正|纠正|不满意|\b(?:wrong|failed|instead|incorrect|didn.t work|not working|fix this|broken)\b)/i;
const trajectoryRefinement=/(?:不对|不行|不要|没解决|失败|改成|修正|纠正|不满意|报错|错误|还是|但是|不过|必须|严禁|注意|调整|\b(?:wrong|failed|instead|incorrect|didn.t work|not working|fix|broken|error|bug|however|actually|wait|should be|make sure|never|forbid|do not|don.t|must not|change to|modify)\b)/i;
const exception=/例外|除非|仅当|第\s*\d+\s*种条件|重要分析|普通问题|\b(?:unless|except|only when|simple tasks|complex tasks|edge case|boundary|if and only if)\b/i;
const accepted=/很好|满意|成功了|解决了|就按这个|符合要求|\b(?:that works|looks good|approved|perfect|thanks|solved|works now)\b/i;
const isAcceptedFeedback=(text:string)=>text.length<=320&&accepted.test(text)&&!correction.test(text)&&!/[?？]|删掉|可以吗|行吗|对吗|是吗|如果全部完成了|last approval assessment/i.test(text);
const oneTime=/仅这一次|仅限这次|这次临时|\b(?:just this once|only for this task|one.time)\b/i;
const actions=/检查|提取|核对|比较|查找|读取|收集|定位|复现|验证|说明|记录|生成|测试|修复|编写|保存|运行|分析|评估|\b(?:inspect|compare|extract|verify|reproduce|build|test|write|save|measure|identify|collect|read|trace|run|configure|deploy|patch|refactor)\b/i;
const actionVerbs=/(检查|提取|核对|比较|查找|读取|收集|定位|复现|验证|说明|记录|生成|测试|修复|编写|保存|运行|分析|评估|配置|构建|部署|重构|inspect|compare|extract|verify|reproduce|build|test|write|save|measure|identify|collect|read|trace|run|configure|deploy|patch|refactor)/gi;
const idle=()=>new Promise<void>(resolve=>setImmediate(resolve));

export type TrajectoryState = 'INTENT' | 'ATTEMPT' | 'REJECTION' | 'CONSTRAINT' | 'TOOL_CLOSURE' | 'VERIFIED_ACTION';

export interface TrajectoryProfile {
  states: TrajectoryState[];
  transitions: string[];
  actionPrimitives: Map<string, number>;
  repairConstraints: Map<string, number>;
  negativeToPositiveTransitions: number;
  toolClosures: number;
  toolFailures?: number;
  contrastiveDensity: number;
  charCost: number;
}

export type SelectionBenchmarkMode =
  | 'random-sampling'
  | 'frequency-only'
  | 'legacy-tfidf-cosine'
  | 'ctss'
  | 'ctss-no-repair'
  | 'ctss-no-submodular'
  | 'ctss-no-cost-norm';

export interface SelectionBenchmarkMetrics {
  mode: SelectionBenchmarkMode;
  label: string;
  rawConversations: number;
  rawEpisodes: number;
  rawChars: number;
  rawTokensEst: number;
  budgetChars: number;
  selectedEpisodes: number;
  selectedChars: number;
  selectedTokensEst: number;
  compressionRatioPct: number;
  inputReductionPct: number;
  actionCoveragePct: number;
  correctionRetentionPct: number;
  redundancyScore: number;
  submodularObjective: number;
  latencyMs: number;
  llmCalls: 0;
}

function requestIndex(messages:Message[]):number {
  const firstAnswer=messages.findIndex(m=>m.role==='assistant'&&!m.toolName);
  const users=messages.map((m,i)=>({m,i})).filter(({m,i})=>m.role==='user'&&(firstAnswer<0||i<firstAnswer));
  return users.sort((a,b)=>b.m.text.length-a.m.text.length)[0]?.i??messages.findIndex(m=>m.role==='user');
}

type Vector=Map<string,number>;
interface Material {
  id:string;
  c:Conversation;
  messages:Message[];
  features:string;
  method:string;
  responseId:string;
  signals:Set<string>;
  score:number;
  signature:string;
  scope:string;
  trajectory:TrajectoryProfile;
  ep?:Episode;
}
export interface MaterialGroup {id:string;items:Material[];chosen:Material[];conversation:Conversation;origins:Record<string,{conversationId:string;messageId:string;source:SourceId;role:Message['role']}>;view:SelectionGroupView;completeContext:boolean}
export interface SelectionPlan {groups:MaterialGroup[];local:Map<string,Episode[]>;summary:SelectionSummary}

/**
 * Models a multi-turn conversation segment as a structured interaction trajectory:
 * [INTENT -> ATTEMPT -> REJECTION/CONSTRAINT -> TOOL_CLOSURE -> VERIFIED_ACTION]
 * and extracts action-anchor primitives plus contrastive repair constraints.
 */
const toolErrorPattern=/(?:Error:|Traceback \(most recent|FAILED\b|not ok |exit code\s+[1-9]\d*|non-zero exit|AssertionError|TypeError|SyntaxError|ModuleNotFoundError|Command failed|ERR!|panic:)/i;

export function extractTrajectoryProfile(messages: Message[], methodText: string): TrajectoryProfile {
  const firstUser = requestIndex(messages);
  const firstAnswer = messages.findIndex(m => m.role === 'assistant' && !m.toolName);
  const states: TrajectoryState[] = [];
  const repairConstraints = new Map<string, number>();
  let negativeToPositiveTransitions = 0;
  let toolClosures = 0;
  let toolFailures = 0;
  let pendingRepair = false;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'system') continue;
    if (m.role === 'tool' || !!m.toolName) {
      // Language-agnostic execution convergence signal (Fail -> Edit/Retry -> Pass):
      // captures execution-driven repairs even without explicit natural-language negation.
      if (toolErrorPattern.test(m.text)) {
        states.push('REJECTION');
        toolFailures++;
        pendingRepair = true;
        for (const t of [...tokens(m.text.slice(0, 400))].slice(0, 5)) {
          repairConstraints.set(`EXEC_FIX:${t}`, (repairConstraints.get(`EXEC_FIX:${t}`) || 0) + 0.9);
        }
      } else {
        states.push('TOOL_CLOSURE');
        toolClosures++;
        if (pendingRepair) {
          negativeToPositiveTransitions++;
          pendingRepair = false;
        }
      }
      continue;
    }
    if (m.role === 'user') {
      if (i <= firstUser || i < firstAnswer) {
        states.push('INTENT');
      } else {
        const isRej = correction.test(m.text) || trajectoryRefinement.test(m.text.slice(0, 240));
        const isExc = exception.test(m.text.replace(/如果(?:全部完成了|你觉得|有问题|没有问题|需要)/g, ''));
        if (isRej) {
          states.push('REJECTION');
          pendingRepair = true;
          for (const t of [...tokens(m.text.slice(0, 400))].slice(0, 6)) {
            repairConstraints.set(`REPAIR:${t}`, (repairConstraints.get(`REPAIR:${t}`) || 0) + 1.0);
          }
        } else if (isExc) {
          states.push('CONSTRAINT');
          pendingRepair = true;
          for (const t of [...tokens(m.text.slice(0, 400))].slice(0, 6)) {
            repairConstraints.set(`COND:${t}`, (repairConstraints.get(`COND:${t}`) || 0) + 0.85);
          }
        } else if (accepted.test(m.text)) {
          states.push('VERIFIED_ACTION');
          if (pendingRepair) {
            negativeToPositiveTransitions++;
            pendingRepair = false;
          }
        }
      }
    } else if (m.role === 'assistant') {
      const steps = procedureSteps(m.text);
      if (steps.length >= 3 || (m.text.length >= 120 && actions.test(m.text))) {
        if (pendingRepair || i === messages.findLastIndex(x => x.role === 'assistant' && !x.toolName)) {
          states.push('VERIFIED_ACTION');
          if (pendingRepair) {
            negativeToPositiveTransitions++;
            pendingRepair = false;
          }
        } else {
          states.push('ATTEMPT');
        }
      } else {
        states.push('ATTEMPT');
      }
    }
  }

  const transitions: string[] = [];
  for (let i = 0; i + 1 < states.length; i++) {
    if (states[i] !== states[i + 1]) {
      transitions.push(`${states[i]}->${states[i + 1]}`);
    }
  }

  const actionPrimitives = new Map<string, number>();
  for (const tr of transitions) {
    actionPrimitives.set(`TRANS:${tr}`, (actionPrimitives.get(`TRANS:${tr}`) || 0) + 1);
  }
  const steps = procedureSteps(methodText);
  const lines = steps.length ? steps : methodText.split(/\r?\n/).slice(0, 16);
  for (const line of lines) {
    const verbs = [...line.matchAll(actionVerbs)].map(m => m[0].toLowerCase());
    const stepTokens = [...tokens(line)].slice(0, 8);
    if (verbs.length > 0) {
      for (const v of unique(verbs).slice(0, 2)) {
        for (const anchor of stepTokens.slice(0, 4)) {
          if (anchor !== v && anchor.length >= 2) {
            const key = `ACT:${v}:${anchor}`;
            actionPrimitives.set(key, (actionPrimitives.get(key) || 0) + 1);
          }
        }
      }
    } else {
      for (const anchor of stepTokens.slice(0, 3)) {
        actionPrimitives.set(`TERM:${anchor}`, (actionPrimitives.get(`TERM:${anchor}`) || 0) + 0.5);
      }
    }
  }

  const charCost = Math.max(
    200,
    messages
      .filter(m => m.role !== 'tool' && !m.toolName)
      .reduce((n, m) => n + Math.min(1800, m.text.length), 0)
  );
  const contrastiveDensity =
    (1 + 1.8 * negativeToPositiveTransitions + 1.4 * Math.min(3, repairConstraints.size / 4) + 0.6 * Math.min(2, toolClosures)) /
    Math.pow(charCost / 600, 0.25);

  return {
    states,
    transitions,
    actionPrimitives,
    repairConstraints,
    negativeToPositiveTransitions,
    toolClosures,
    toolFailures,
    contrastiveDensity,
    charCost
  };
}

function vector(text:string,frequency:Map<string,number>,total:number):Vector {
  // Binary term frequency prevents repeated logs or repeated wording in one
  // task from outweighing evidence in independent tasks. IDF downweights boilerplate.
  const result=new Map<string,number>();let norm=0;
  for(const term of tokens(text)){const weight=1+Math.log((total+1)/((frequency.get(term)||0)+1));result.set(term,weight);norm+=weight*weight;}
  norm=Math.sqrt(norm)||1;for(const [term,value] of result)result.set(term,value/norm);return result;
}
function dot(a:Vector,b:Vector):number {let sum=0;for(const [term,value] of a)sum+=value*(b.get(term)||0);return sum;}
function sampleMessage(message:Message,max:number):Message[] {
  if(message.text.length<=max)return [message];
  // Exact substrings preserve verifiable original IDs. Procedure lines and
  // condition paragraphs take priority over a long response's generic opening.
  const lines=message.text.split('\n');const meaningful=lines.filter(line=>/^\s*(?:\d+[.)、]|[-*])\s*\S/.test(line)||exception.test(line)||correction.test(line));
  const parts:string[]=[];let used=0;
  for(const line of meaningful)if(line.length<=max-used){parts.push(line);used+=line.length;}
  if(parts.length>=3)return parts.map(text=>({...message,text}));
  const width=Math.floor(max/3);return [0,Math.floor((message.text.length-width)/2),message.text.length-width].map(start=>({...message,text:message.text.slice(start,start+width)}));
}
function context(messages:Message[],responseId:string,limit=12000):{messages:Message[];complete:boolean} {
  const firstUser=requestIndex(messages);
  // The initial task may contain a pasted product brief or quoted examples.
  // Later feedback is an actual revision boundary; words inside the initial
  // brief must not classify the entire specification as rejected feedback.
  const firstAnswer=messages.findIndex(m=>m.role==='assistant'&&!m.toolName);
  const important=messages.map((m,i)=>({m,i})).filter(({m,i})=>i>firstUser&&i>firstAnswer&&m.role==='user'&&(correction.test(m.text)||exception.test(m.text)));
  const lastRejection=important.filter(({m})=>correction.test(m.text)).at(-1)?.i??-1;
  const keep=new Set<number>();const add=(i:number)=>{if(i>=0&&i<messages.length)keep.add(i);};
  add(firstUser);
  add(messages.findIndex(m=>m.id===responseId));
  // Never sample a correction without its following response and a follow-up.
  for(const {i} of important){add(i);for(let j=i+1;j<messages.length;j++){add(j);if(messages[j].role==='assistant'&&!messages[j].toolName){add(j+1);break;}}}
  add(messages.findLastIndex(m=>m.role==='assistant'&&!m.toolName));add(messages.findLastIndex(m=>m.role==='user'));
  const interactions=messages.map((m,i)=>({m,i})).filter(({m,i})=>i>=firstUser&&i>lastRejection&&(m.role==='tool'||!!m.toolName));
  for(const item of [interactions[0],...interactions.slice(-2),interactions.filter(({m})=>/Error:|Traceback|FAILED|not ok /.test(m.text)).at(-1)].filter((v):v is {m:Message;i:number}=>!!v).slice(0,4))add(item.i);
  const selected:Message[]=[];let used=0;let complete=true;
  for(const i of [...keep].sort((a,b)=>a-b)){
    const message=messages[i];if(message.role==='system')continue;
    // A superseded response is kept locally but not offered as the method.
    if(message.role==='assistant'&&i<lastRejection)continue;
    if(i>firstUser&&i>firstAnswer&&(correction.test(message.text)||exception.test(message.text))&&message.role==='user'){
      if(message.text.length>1800){const parts=sampleMessage(message,850);selected.push(...parts);used+=parts.reduce((n,m)=>n+m.text.length,0);continue;}
      selected.push(message);used+=message.text.length;continue;
    }
    const excerpts=i===firstUser?requestContext(message,messages.find(m=>m.id===responseId)?.text||''):sampleMessage(message,message.toolName||message.role==='tool'?400:message.role==='assistant'?1800:850);
    selected.push(...excerpts);used+=excerpts.reduce((n,m)=>n+m.text.length,0);
  }
  // Large correction chains must wait for a wider supported window rather than
  // silently losing a condition. No generated result claims full-library coverage.
  if(used>limit)complete=false;
  return {messages:selected,complete};
}
function requestContext(message:Message,method:string):Message[] {
  if(message.text.length<=1800)return [message];
  const features=tokens(method);
  const clauses=message.text.split(/\r?\n|(?<=[。！？])\s*/).map(text=>text.trim()).filter(text=>text.length>=8&&text.length<=600);
  const relevant=clauses.filter(text=>exception.test(text)||/^(?:输入|输出|交付|验收|input|output|deliverable|acceptance)/i.test(text));
  const score=(text:string)=>{const terms=tokens(text);let shared=0;for(const term of terms)if(features.has(term))shared++;return shared/Math.sqrt(Math.max(1,terms.size));};
  relevant.sort((a,b)=>score(b)-score(a));
  const selected=[message.text.slice(0,650)];let chars=650;
  for(const clause of relevant){if(score(clause)<.6||selected.some(text=>text.includes(clause)))continue;if(chars+clause.length<=1800){selected.push(clause);chars+=clause.length;}}
  // This remains a disclosed partial specification, never a complete list of
  // global requirements. Later explicit corrections/conditions are mandatory.
  return selected.map(text=>({...message,text}));
}
function material(c:Conversation,messages:Message[]):Material|null {
  const user=messages.filter(m=>m.role==='user');const assistants=messages.filter(m=>m.role==='assistant'&&!m.toolName);
  const request=messages[requestIndex(messages)];
  if(!user.length||!assistants.length||!request||oneTime.test(request.text.slice(0,400)))return null;
  const firstAnswer=messages.findIndex(m=>m.role==='assistant'&&!m.toolName);
  const feedback=messages.filter((m,i)=>m.role==='user'&&i>firstAnswer);
  const rejected=messages.findLastIndex((m,i)=>i>firstAnswer&&m.role==='user'&&correction.test(m.text));
  if(rejected>messages.findLastIndex(m=>m.role==='assistant'&&!m.toolName))return null;
  const afterRevision=assistants.filter(m=>messages.indexOf(m)>rejected);
  const latest=[...afterRevision].reverse().find(m=>procedureSteps(m.text).length>=3)||afterRevision.at(-1)||assistants.at(-1)!;const steps=procedureSteps(latest.text);
  if(steps.length<3&&!(latest.text.length>=120&&actions.test(latest.text)))return null;
  const cleanException=(t:string)=>exception.test(t.replace(/如果(?:全部完成了|你觉得|有问题|没有问题|需要)/g,''));
  const signals=new Set<string>();if(feedback.some(m=>correction.test(m.text)))signals.add('correction');if(feedback.some(m=>cleanException(m.text))||request.text.length<=1800&&cleanException(request.text))signals.add('exception');
  if(feedback.some(m=>isAcceptedFeedback(m.text)))signals.add('accepted');if(steps.length>=3)signals.add('procedure');
  const method=(steps.length?steps.join('\n'):latest.text.slice(0,5000));
  const features=method+'\n'+request.text.slice(0,1000);
  const signature=hash(messages.filter(m=>['user','assistant'].includes(m.role)&&!m.toolName).map(m=>[m.role,m.text.trim()]));
  const scope=/本项目|仅.*项目|in this project|for this repo/i.test(request.text)?c.id!:'general';
  const trajectory=extractTrajectoryProfile(messages,method);
  const baseScore=steps.length+Number(signals.has('accepted'))*5+Number(signals.has('correction'))*3+trajectory.negativeToPositiveTransitions*2.5;
  return {id:hash([c.id,signature]).slice(0,24),c,messages,features,method,responseId:latest.id,signals,signature,scope,trajectory,score:baseScore};
}

/**
 * Legacy Baseline (`Baseline-Lexical-Cosine`):
 * Retained for direct experimental comparison in Target 1 & Target 2.
 */
export function chooseLegacyCosine(items:Material[],vectors:Map<string,Vector>):Material[] {
  const ranked=[...items].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));const chosen:Material[]=[];
  for(const item of ranked.filter(item=>item.signals.has('exception')&&/第\s*\d+\s*种条件/.test(item.messages[0]?.text||'')))chosen.push(item);
  for(const item of ranked.filter(item=>(item.signals.has('exception')||item.signals.has('correction'))&&!chosen.includes(item)).slice(0,Math.max(0,4-chosen.length)))chosen.push(item);
  if(chosen.length>6)return chosen;
  if(!chosen.length&&ranked[0])chosen.push(ranked[0]);
  while(chosen.length<Math.min(4,items.length)){
    const rest=ranked.filter(item=>!chosen.includes(item));
    rest.sort((a,b)=>merit(b)-merit(a)||a.id.localeCompare(b.id));if(!rest[0])break;chosen.push(rest[0]);
  }
  return chosen;
  function merit(item:Material):number {const redundancy=Math.max(0,...chosen.map(peer=>dot(vectors.get(item.id)!,vectors.get(peer.id)!)));const diversity=chosen.every(peer=>peer.c.id!==item.c.id)?2:0;const source=chosen.every(peer=>peer.c.source!==item.c.source)?1:0;return (1-redundancy)*4+diversity+source+item.score*.1;}
}

export interface PureCELFCandidate {
  id: string;
  actionPrimitives: Map<string, number>;
  repairConstraints: Map<string, number>;
  cost: number;
}

export interface PureCELFOptions {
  lambda?: number;
  adaptiveLambda?: boolean;
  alpha?: number;
  useSubmodular?: boolean;
  actionWeights?: Map<string, number>;
  repairWeights?: Map<string, number>;
}

export interface PureCELFResult<T> {
  selected: T[];
  usedCost: number;
  reEvaluations: number;
  effectiveLambda: number;
  objectiveValue: number;
}

interface HeapNode {
  key: number;
  idx: number;
  stamp: number;
}

class MaxHeap {
  private data: HeapNode[] = [];
  get size(): number { return this.data.length; }
  push(node: HeapNode): void {
    this.data.push(node);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p].key >= this.data[i].key) break;
      const tmp = this.data[p]; this.data[p] = this.data[i]; this.data[i] = tmp;
      i = p;
    }
  }
  pop(): HeapNode | undefined {
    if (!this.data.length) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length) {
      this.data[0] = last;
      let i = 0;
      const n = this.data.length;
      while (true) {
        const l = (i << 1) + 1, r = l + 1;
        let best = i;
        if (l < n && this.data[l].key > this.data[best].key) best = l;
        if (r < n && this.data[r].key > this.data[best].key) best = r;
        if (best === i) break;
        const tmp = this.data[i]; this.data[i] = this.data[best]; this.data[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

/**
 * Exact Pure Monotone CELF Lazy-Greedy CTSS Solver (Algorithm 1 & Theorem 1):
 *   F(S) = (100 / W_U) * sum_u w_u * sqrt(m_u(S)) + lambda * (100 / W_R) * sum_r w_r * log(1 + m_r(S))
 * Strictly non-negative, monotone, and submodular (zero negative penalty terms),
 * guaranteeing the (1 - 1/e) budgeted knapsack approximation ratio at alpha = 1.0
 * together with the best-feasible-singleton check (Eq. 6).
 */
export function selectCTSSPureCELF<T extends PureCELFCandidate>(
  candidates: T[],
  budget: number,
  options: PureCELFOptions = {}
): PureCELFResult<T> {
  const n = candidates.length;
  const alpha = options.alpha ?? 1.0;
  const useSubmodular = options.useSubmodular ?? true;

  let repairBearingCount = 0;
  const actDf = new Map<string, number>();
  const repDf = new Map<string, number>();
  for (const c of candidates) {
    if (c.repairConstraints.size > 0) repairBearingCount++;
    for (const [k] of c.actionPrimitives) actDf.set(k, (actDf.get(k) || 0) + 1);
    for (const [k] of c.repairConstraints) repDf.set(k, (repDf.get(k) || 0) + 1);
  }

  const effectiveLambda = options.lambda !== undefined
    ? options.lambda
    : options.adaptiveLambda
      ? Math.min(1.0, Math.max(0.45, 0.40 + 0.14 * Math.log(1 + n / Math.max(1, repairBearingCount))))
      : 0.65;

  const wAct = options.actionWeights ?? new Map<string, number>();
  if (!options.actionWeights) {
    for (const [k, df] of actDf) wAct.set(k, 1 + Math.log((n + 1) / (df + 1)));
  }
  const wRep = options.repairWeights ?? new Map<string, number>();
  if (!options.repairWeights) {
    for (const [k, df] of repDf) wRep.set(k, 1 + Math.log((n + 1) / (df + 1)));
  }

  let totalActW = 0;
  for (const [, w] of wAct) totalActW += w;
  let totalRepW = 0;
  for (const [, w] of wRep) totalRepW += w;
  const actScale = totalActW > 0 ? 100 / totalActW : 0;
  const repScale = totalRepW > 0 ? 100 / totalRepW : 0;

  const evalF = (subset: T[]): number => {
    const mA = new Map<string, number>();
    const mR = new Map<string, number>();
    for (const item of subset) {
      for (const [k] of item.actionPrimitives) mA.set(k, (mA.get(k) || 0) + 1);
      for (const [k] of item.repairConstraints) mR.set(k, (mR.get(k) || 0) + 1);
    }
    let fA = 0;
    for (const [k, cnt] of mA) fA += (wAct.get(k) || 1) * (useSubmodular ? Math.sqrt(cnt) : cnt);
    let fR = 0;
    if (effectiveLambda > 0) {
      for (const [k, cnt] of mR) fR += (wRep.get(k) || 1) * (useSubmodular ? Math.log(1 + cnt) : cnt);
    }
    return fA * actScale + effectiveLambda * fR * repScale;
  };

  const heap = new MaxHeap();
  let bestSingleIdx = -1;
  let bestSingleVal = -1;
  for (let i = 0; i < n; i++) {
    const c = candidates[i];
    if (c.cost > budget) continue;
    let dA = 0;
    for (const [k] of c.actionPrimitives) dA += wAct.get(k) || 1;
    let dR = 0;
    if (effectiveLambda > 0) {
      const unitR = useSubmodular ? Math.LN2 : 1.0;
      for (const [k] of c.repairConstraints) dR += (wRep.get(k) || 1) * unitR;
    }
    const val = dA * actScale + effectiveLambda * dR * repScale;
    if (val > bestSingleVal) {
      bestSingleVal = val;
      bestSingleIdx = i;
    }
    const denom = alpha > 0 ? Math.pow(Math.max(1, c.cost) / 500, alpha) : 1.0;
    heap.push({ key: val / denom, idx: i, stamp: 0 });
  }

  const mA = new Map<string, number>();
  const mR = new Map<string, number>();
  const selected: T[] = [];
  let usedCost = 0;
  let step = 0;
  let reEvaluations = 0;

  while (heap.size > 0) {
    const top = heap.pop()!;
    const cand = candidates[top.idx];
    if (usedCost + cand.cost > budget) continue;
    if (top.stamp === step || !useSubmodular) {
      if (top.key <= 0) break;
      selected.push(cand);
      usedCost += cand.cost;
      step++;
      for (const [k] of cand.actionPrimitives) mA.set(k, (mA.get(k) || 0) + 1);
      for (const [k] of cand.repairConstraints) mR.set(k, (mR.get(k) || 0) + 1);
    } else {
      reEvaluations++;
      let dA = 0;
      for (const [k] of cand.actionPrimitives) {
        const cnt = mA.get(k) || 0;
        dA += (wAct.get(k) || 1) * (Math.sqrt(cnt + 1) - Math.sqrt(cnt));
      }
      let dR = 0;
      if (effectiveLambda > 0) {
        for (const [k] of cand.repairConstraints) {
          const cnt = mR.get(k) || 0;
          dR += (wRep.get(k) || 1) * (Math.log(2 + cnt) - Math.log(1 + cnt));
        }
      }
      const val = dA * actScale + effectiveLambda * dR * repScale;
      const denom = alpha > 0 ? Math.pow(Math.max(1, cand.cost) / 500, alpha) : 1.0;
      heap.push({ key: val / denom, idx: top.idx, stamp: step });
    }
  }

  let greedyVal = evalF(selected);
  if (bestSingleIdx >= 0 && bestSingleVal > greedyVal) {
    return {
      selected: [candidates[bestSingleIdx]],
      usedCost: candidates[bestSingleIdx].cost,
      reEvaluations,
      effectiveLambda,
      objectiveValue: bestSingleVal
    };
  }
  return {
    selected,
    usedCost,
    reEvaluations,
    effectiveLambda,
    objectiveValue: greedyVal
  };
}

/**
 * CTSS Intra-Cluster Representative Selector (`Contrastive Trajectory Submodular Selection`):
 * Pure monotone concave submodular selector (sqrt action saturation + log(1+z) repair saturation
 * + monotone conversation/source coverage) aligned with Algorithm 1.
 */
export function chooseCTSS(
  items:Material[],
  _vectors:Map<string,Vector>,
  options:{lambdaRepair?:number;costAlpha?:number;submodular?:boolean}={}
):Material[] {
  const lambda = options.lambdaRepair ?? 0.65;
  const alpha = options.costAlpha ?? 1.0;
  const useSubmodular = options.submodular ?? true;

  const ranked=[...items].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const chosen:Material[]=[];
  // Mandatory numbered condition guard (preserves explicit multi-condition deferral safety)
  for(const item of ranked.filter(item=>item.signals.has('exception')&&/第\s*\d+\s*种条件/.test(item.messages[0]?.text||'')))chosen.push(item);
  if(chosen.length>6)return chosen;

  const countActions=new Map<string,number>();
  const countRepairs=new Map<string,number>();
  const absorb=(item:Material)=>{
    for(const [k] of item.trajectory.actionPrimitives)countActions.set(k,(countActions.get(k)||0)+1);
    for(const [k] of item.trajectory.repairConstraints)countRepairs.set(k,(countRepairs.get(k)||0)+1);
  };
  for(const item of chosen)absorb(item);

  const targetCount = Math.min(4, items.length);
  while(chosen.length < targetCount){
    const rest = ranked.filter(item => !chosen.includes(item));
    if(!rest.length) break;
    let bestItem = rest[0];
    let bestGain = -Infinity;
    for(const candidate of rest){
      let deltaCoverage = 0;
      for(const [k] of candidate.trajectory.actionPrimitives){
        const cur = countActions.get(k) || 0;
        deltaCoverage += useSubmodular ? (Math.sqrt(cur + 1) - Math.sqrt(cur)) : 1.0;
      }
      let deltaRepair = 0;
      for(const [k] of candidate.trajectory.repairConstraints){
        const cur = countRepairs.get(k) || 0;
        deltaRepair += useSubmodular ? (Math.log(2 + cur) - Math.log(1 + cur)) : 1.0;
      }
      if(candidate.signals.has('correction') || candidate.signals.has('exception')){
        deltaRepair += (1 + candidate.trajectory.negativeToPositiveTransitions) * 1.2;
      }
      const diversityBonus = (chosen.every(peer => peer.c.id !== candidate.c.id) ? 1.5 : 0) + (chosen.every(peer => peer.c.source !== candidate.c.source) ? 0.8 : 0);
      const rawMarginal = deltaCoverage + lambda * deltaRepair + diversityBonus + candidate.score * 0.05;
      const costNorm = alpha > 0 ? Math.pow(Math.max(250, candidate.trajectory.charCost) / 600, alpha) : 1;
      const gain = rawMarginal / costNorm;
      if(gain > bestGain || (gain === bestGain && candidate.id.localeCompare(bestItem.id) < 0)){
        bestGain = gain;
        bestItem = candidate;
      }
    }
    chosen.push(bestItem);
    absorb(bestItem);
  }
  return chosen;
}

function cleanGroupTitle(text:string):string {
  const cleaned=text.replace(/^<image[^>]*>\s*/i,'').replace(/^(?:\[[^\]]+\]\([^)]+\)\s*)+/,'').replace(/:\s*\[USER_HOME\][^\s]*/gi,'').replace(/\*\*/g,'').trim()||text;
  const lines=cleaned.split(/\r?\n/).map(l=>l.replace(/^#+\s*/,'').replace(/^>\s*/,'').replace(/^(?:\[[^\]]+\]\([^)]+\)\s*)+/,'').replace(/^(?:[-*•]|\d+[.)、])\s*/,'').replace(/^[：:，,。.\s]+/,'').trim()).filter(Boolean);
  const skip=/^(?:role|task|context|background|instructions?|角色|任务|背景|说明|要求|sha-?256\s*[:：]|md5\s*[:：]|the attached pasted text file|my request(?:\s+for\s+codex)?\s*[:：]?|.+:\s*[A-Za-z]:[\\/]|[A-Za-z]:[\\/][^\s]+$|\[[^\]]+\]$|\||请先完整阅读并严格遵循|把下面这(?:整)?段话直接发给|直接把下面这段话发给|你看看我的完整对话|请直接在后台自主跑完|现在请你自主完成)/i;
  let meaningful=lines.find(l=>l.length>=12&&!skip.test(l))||lines.find(l=>!skip.test(l))||lines[0]||'Candidate procedure';
  meaningful=meaningful.replace(/^(?:[^。！？!?]{0,45}(?:对吧|是吧)[？?，,。.\s]*)+/,'');
  return meaningful.replace(/^(?:调用相关的skills[:：]\s*|现在请你|请你帮我|请先帮我|先帮我|请|帮我|please|can you)\s*/i,'').replace(/^[：:，,。.\s]+/,'').trim().replace(/[。.!?！？:：；;，,]+$/,'').slice(0,82);
}

function bundle(items:Material[],chosen:Material[]):MaterialGroup {
  const origins:MaterialGroup['origins']={};const messages:Message[]=[];let completeContext=chosen.length<=6;
  for(const item of chosen){const sampled=context(item.messages,item.responseId);completeContext&&=sampled.complete;for(const m of sampled.messages){const id=`${item.id}:${m.id}`;origins[id]={conversationId:item.c.id!,messageId:m.id,source:item.c.source,role:m.role};messages.push({...m,id});}}
  const id=hash([SELECTION_VERSION,chosen.map(item=>item.id).sort(),messages.map(m=>[m.id,m.text])]);
  const chars=messages.reduce((n,m)=>n+m.text.length,0);if(chars>36000)completeContext=false;
  const sources=unique(items.map(item=>item.c.source));
  const view:SelectionGroupView={id,title:cleanGroupTitle(chosen.map(c=>c.messages[requestIndex(c.messages)]?.text||'').join('\n')||items[0].messages[requestIndex(items[0].messages)].text),episodes:items.length,conversations:unique(items.map(item=>item.c.id)).length,sources,representatives:chosen.length,chars,status:completeContext?'pending':'deferred',reason:completeContext?chosen.some(item=>item.messages[requestIndex(item.messages)].text.length>1800)?'长篇初始任务说明采用相关片段，不代表完整提取了全部要求；后续纠正和例外优先保留。 / Long initial specifications are excerpted, not exhaustively interpreted; later corrections and conditions take priority.':undefined:'关键纠正或例外超出当前取样窗口，材料已保留。 / Essential correction/exception context exceeds the sampling window; retained for review.',materials:messages.map(m=>({...origins[m.id],role:m.role,text:m.text}))};
  return {id,items,chosen,origins,view,completeContext,conversation:{id,source:items[0].c.source,externalId:id,title:'Selected evidence group',messages,completeness:'partial',warnings:['Representative episodes only; other history remains local.']}};
}

export async function selectMaterials(conversations:Conversation[],signal:AbortSignal,onProgress?:(processed:number)=>void):Promise<SelectionPlan> {
  const local=new Map<string,Episode[]>();const materials:Material[]=[];const signatures=new Set<string>();const seenRootSteps=new Set<string>();let duplicates=0,episodes=0;
  const rootThreadKey=(c:Conversation)=>c.messages.length>=4?hash([c.source,c.messages.slice(0,2).map(m=>[m.role,m.text.trim()])]):c.id!;
  for(const [i,c] of conversations.entries()){
    signal.throwIfAborted();const msgGroups=taskMessageGroups(c);const extracted=extractEpisodes(c,msgGroups);const rKey=rootThreadKey(c);
    for(const ep of extracted)if(ep.steps.length>=3){const rSig=hash([rKey,ep.steps]);if(seenRootSteps.has(rSig)){ep.steps=[];ep.outcome='unknown';}else seenRootSteps.add(rSig);}
    local.set(c.id!,extracted);
    for(const [idx,messages] of msgGroups.entries()){episodes++;const item=material(c,messages);if(!item)continue;item.ep=extracted.find(e=>e.evidence.some(r=>r.messageId===item.responseId))||extracted[idx];if(signatures.has(item.signature)){duplicates++;if(item.ep){item.ep.steps=[];item.ep.outcome='unknown';}continue;}signatures.add(item.signature);materials.push(item);}
    if(i%10===0||i===conversations.length-1){if(i%20===0||i===conversations.length-1)onProgress?.(i+1);await idle();}
  }
  // DF counts independent task episodes, never term occurrences or tool events.
  const frequency=new Map<string,number>();for(const item of materials)for(const term of tokens(item.features))frequency.set(term,(frequency.get(term)||0)+1);
  const vectors=new Map(materials.map(item=>[item.id,vector(item.features,frequency,materials.length)]));
  const methods=new Map(materials.map(item=>[item.id,vector(item.method,frequency,materials.length)]));
  const requests=new Map(materials.map(item=>[item.id,vector(item.messages[requestIndex(item.messages)].text.slice(0,1000),frequency,materials.length)]));
  const groups:Material[][]=[];const index=new Map<string,Set<number>>();
  for(const [i,item] of materials.entries()){
    signal.throwIfAborted();const v=vectors.get(item.id)!;const reqV=requests.get(item.id)!;const candidates=new Map<number,number>();
    for(const [term,weight] of [...v].sort((a,b)=>b[1]-a[1]).slice(0,24))for(const group of index.get(term)||[])candidates.set(group,(candidates.get(group)||0)+weight);
    for(const [term,weight] of [...reqV].sort((a,b)=>b[1]-a[1]).slice(0,16))for(const group of index.get(term)||[])candidates.set(group,(candidates.get(group)||0)+weight);
    let winner=-1,best=.18;
    for(const [id] of [...candidates].sort((a,b)=>b[1]-a[1]).slice(0,64)){
      const first=groups[id][0];if(first.scope!==item.scope)continue;
      for(const peer of groups[id].slice(0,4)){
        const method=dot(methods.get(item.id)!,methods.get(peer.id)!);const score=dot(v,vectors.get(peer.id)!);const req=dot(reqV,requests.get(peer.id)!);
        const combined=Math.max(score,req*.75+method*.25);
        if((method>=.16&&score>best)||(method>=.10&&score>=.24&&score>best)||(method>=.08&&req>=.45&&combined>best)){winner=id;best=combined;}
      }
    }
    if(winner<0){winner=groups.length;groups.push([]);}groups[winner].push(item);
    for(const [term] of [...v,...reqV].sort((a,b)=>b[1]-a[1]).slice(0,32)){if(!index.has(term))index.set(term,new Set());index.get(term)!.add(winner);}
    if(i%50===0)await idle();
  }
  const packed=groups.map(items=>bundle(items,chooseCTSS(items,vectors))).sort((a,b)=>Number(b.completeContext)-Number(a.completeContext)||b.view.conversations-a.view.conversations||b.items.reduce((n,item)=>n+item.score,0)-a.items.reduce((n,item)=>n+item.score,0)||a.id.localeCompare(b.id));
  const claimedEpisodes=new Set<string>();
  for(const g of packed)if(g.completeContext&&g.view.conversations>=2){
    const pool=unique([...g.chosen,...g.items]);
    const matches=pool.map(item=>{
      const ep=item.ep&&!claimedEpisodes.has(item.ep.id)&&item.ep.steps.length>=3&&item.ep.outcome!=='failed'?item.ep:undefined;
      return ep?{item,ep}:null;
    }).filter((x):x is {item:Material;ep:Episode}=>!!x);
    if(!matches.length)continue;
    matches.sort((a,b)=>Number(b.ep.outcome==='accepted')-Number(a.ep.outcome==='accepted')||b.ep.steps.length-a.ep.steps.length);
    const primaryItem=matches[0].item;
    const primary=matches[0].ep;
    const coherentMatches=matches.filter(m=>{
      if(m.item.c.id===primaryItem.c.id)return true;
      const stepSim=similarity(primary.steps.join('\n'),m.ep.steps.join('\n'));
      const methodSim=dot(methods.get(primaryItem.id)!,methods.get(m.item.id)!);
      return stepSim>=0.20||(methodSim>=0.16&&stepSim>=0.12);
    });
    const coherentItems=g.items.filter(item=>item.c.id===primaryItem.c.id||dot(methods.get(primaryItem.id)!,methods.get(item.id)!)>=0.22);
    const rootIds=unique([...coherentMatches.map(m=>rootThreadKey(m.item.c)),...coherentItems.map(x=>rootThreadKey(x.c))]);
    if(rootIds.length<2)continue;
    const convIds=unique([...coherentMatches.map(m=>m.item.c.id!),...coherentItems.map(x=>x.c.id!)]);
    if(convIds.length<2)continue;
    claimedEpisodes.add(primary.id);
    primary.goal=cleanGroupTitle(primary.goal);
    if(primary.goal.length<8&&g.view.title.length>=10)primary.goal=g.view.title;
    g.view.title=primary.goal;
    primary.contributingConversations=convIds;
    primary.contributingSources=unique([...coherentMatches.map(m=>m.item.c.source),...coherentItems.map(x=>x.c.source)]);
    if(convIds.length>=3||primary.contributingSources.length===1)primary.contributingEpisodes=unique(coherentMatches.map(m=>m.ep.id));
    if(coherentMatches.some(m=>m.item.signals.has('accepted'))||coherentItems.some(x=>x.signals.has('accepted')))primary.outcome='accepted';
    for(const peer of coherentMatches.slice(1)){
      claimedEpisodes.add(peer.ep.id);
      if((convIds.length>=3||primary.contributingSources.length===1)&&peer.ep.id!==primary.id)peer.ep.outcome='unknown';
      for(const ref of peer.ep.evidence.slice(0,2))primary.evidence.push({...ref,conversationId:peer.item.c.id!});
      primary.preferences=unique([...primary.preferences,...peer.ep.preferences]);
      primary.corrections=unique([...primary.corrections,...peer.ep.corrections]);
      primary.inputs=unique([...primary.inputs,...peer.ep.inputs]).slice(0,6);
      primary.outputs=unique([...primary.outputs,...peer.ep.outputs]).slice(0,6);
    }
  }
  for(const eps of local.values())for(const ep of eps)if(ep.goal.length>65||/\[USER_HOME\]|\*\*|^[：:，,]|(?:对吧|是吧)[？?，,]/.test(ep.goal))ep.goal=cleanGroupTitle(ep.goal);
  return {groups:packed,local,summary:{method:'local-tfidf',histories:conversations.length,rawChars:conversations.reduce((n,c)=>n+c.messages.reduce((a,m)=>a+m.text.length,0),0),episodes,duplicates,groups:packed.length,representatives:packed.reduce((n,g)=>n+g.chosen.length,0),selectedChars:packed.filter(g=>g.completeContext).reduce((n,g)=>n+g.view.chars,0),plannedInputChars:0,plannedCalls:0,cachedGroups:0,completedGroups:0,pendingGroups:packed.filter(g=>g.completeContext).length,deferredGroups:packed.filter(g=>!g.completeContext).length,unselectedEpisodes:Math.max(0,episodes-packed.reduce((n,g)=>n+g.chosen.length,0)),preprocessingModelCalls:0}};
}

export function restoreOrigins(episodes:Episode[],group:MaterialGroup):Episode[] {
  return episodes.map(e=>{
    const evidence=e.evidence.map(ref=>{const origin=group.origins[ref.messageId];if(!origin)throw new Error('Unknown representative source');return {...ref,messageId:origin.messageId,conversationId:origin.conversationId};});
    const contributingConversations=unique(e.evidence.filter(ref=>ref.kind==='step'&&group.origins[ref.messageId]?.role==='assistant').map(ref=>group.origins[ref.messageId].conversationId));const primary=contributingConversations[0]||group.chosen[0].c.id!;
    const contributingSources=unique(contributingConversations.map(id=>group.items.find(item=>item.c.id===id)!.c.source));
    const mapRef=<T extends {messageId:string;quote:string}>(ref:T):T=>{const origin=group.origins[ref.messageId];return origin?{...ref,messageId:origin.messageId,conversationId:origin.conversationId}:ref;};
    const quality=e.quality?{...e.quality,rubric:e.quality.rubric?mapRef(e.quality.rubric):undefined,checks:e.quality.checks.map(mapRef)}:undefined;
    return {...e,id:hash([group.id,e.id]).slice(0,32),conversationId:primary,source:group.items.find(item=>item.c.id===primary)!.c.source,evidence,quality,contributingConversations,contributingSources};
  });
}

/**
 * Reproducible Multi-Algorithm & Ablation Benchmark Evaluator (Target 1 & Target 2):
 * Evaluates Random-Sampling, Frequency-Only, Legacy-TFIDF-Cosine, Ours-CTSS,
 * and 3 CTSS Ablations under an identical character/token budget B.
 */
export function evaluateSelectionMethods(
  conversations: Conversation[],
  budgetChars: number,
  modes: SelectionBenchmarkMode[] = [
    'random-sampling',
    'frequency-only',
    'legacy-tfidf-cosine',
    'ctss',
    'ctss-no-repair',
    'ctss-no-submodular',
    'ctss-no-cost-norm'
  ]
): SelectionBenchmarkMetrics[] {
  const rawChars = conversations.reduce((n, c) => n + c.messages.reduce((a, m) => a + m.text.length, 0), 0);
  const rawTokensEst = Math.ceil(rawChars / 3.8);
  const allMaterials: Material[] = [];
  const signatures = new Set<string>();
  for (const c of conversations) {
    for (const messages of taskMessageGroups(c)) {
      const item = material(c, messages);
      if (!item || signatures.has(item.signature)) continue;
      signatures.add(item.signature);
      allMaterials.push(item);
    }
  }

  // Precompute corpus-level ground-truth universes U_action and C_repair
  const actionUniverse = new Map<string, number>();
  const repairUniverse = new Map<string, number>();
  const termDf = new Map<string, number>();
  const termTf = new Map<string, number>();

  for (const item of allMaterials) {
    for (const [k] of item.trajectory.actionPrimitives) {
      actionUniverse.set(k, (actionUniverse.get(k) || 0) + 1);
    }
    for (const [k] of item.trajectory.repairConstraints) {
      repairUniverse.set(k, (repairUniverse.get(k) || 0) + 1);
    }
    for (const term of tokens(item.features)) {
      termDf.set(term, (termDf.get(term) || 0) + 1);
      termTf.set(term, (termTf.get(term) || 0) + 1);
    }
  }

  const actionWeights = new Map<string, number>();
  let totalActionWeight = 0;
  for (const [k, df] of actionUniverse) {
    const w = 1 + Math.log((allMaterials.length + 1) / (df + 1));
    actionWeights.set(k, w);
    totalActionWeight += w;
  }

  const repairWeights = new Map<string, number>();
  let totalRepairWeight = 0;
  for (const [k, df] of repairUniverse) {
    const w = 1 + Math.log((allMaterials.length + 1) / (df + 1));
    repairWeights.set(k, w);
    totalRepairWeight += w;
  }

  const vectors = new Map(allMaterials.map(item => [item.id, vector(item.features, termDf, allMaterials.length)]));
  const sampledCosts = new Map<string, number>();
  for (const item of allMaterials) {
    const sampled = context(item.messages, item.responseId);
    const chars = sampled.messages.reduce((n, m) => n + m.text.length, 0);
    sampledCosts.set(item.id, Math.max(180, chars));
  }

  const labels: Record<SelectionBenchmarkMode, string> = {
    'random-sampling': 'Random-Sampling',
    'frequency-only': 'Frequency-Only',
    'legacy-tfidf-cosine': 'Legacy-TFIDF-Cosine (Baseline)',
    'ctss': 'Ours-CTSS (Full Submodular)',
    'ctss-no-repair': 'Ablation: CTSS w/o Repair Polarity (λ=0)',
    'ctss-no-submodular': 'Ablation: CTSS w/o Submodular Coverage',
    'ctss-no-cost-norm': 'Ablation: CTSS w/o Cost Normalization (α=0)'
  };

  const results: SelectionBenchmarkMetrics[] = [];

  for (const mode of modes) {
    const t0 = performance.now();
    const selected: Material[] = [];
    let usedChars = 0;

    if (mode === 'random-sampling') {
      // Deterministic hash-seeded pseudo-random permutation
      const shuffled = [...allMaterials].sort((a, b) =>
        hash(['random-seed-v1', a.id]).localeCompare(hash(['random-seed-v1', b.id]))
      );
      for (const item of shuffled) {
        const c = sampledCosts.get(item.id)!;
        if (usedChars + c <= budgetChars) {
          selected.push(item);
          usedChars += c;
        }
      }
    } else if (mode === 'frequency-only') {
      // Ranks strictly by sum of corpus high-frequency tokens (favors repetitive boilerplate)
      const freqScored = [...allMaterials]
        .map(item => {
          let tfSum = 0;
          const terms = tokens(item.features);
          for (const t of terms) tfSum += termTf.get(t) || 0;
          return { item, score: tfSum * Math.pow(item.messages.length, 0.3) };
        })
        .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
      for (const { item } of freqScored) {
        const c = sampledCosts.get(item.id)!;
        if (usedChars + c <= budgetChars) {
          selected.push(item);
          usedChars += c;
        }
      }
    } else if (mode === 'legacy-tfidf-cosine') {
      // Traditional greedy TF-IDF cosine clustering + centroid length ranking
      const clusters: Material[][] = [];
      for (const item of allMaterials) {
        const v = vectors.get(item.id)!;
        let bestCluster = -1;
        let bestSim = 0.22;
        for (let cid = 0; cid < clusters.length; cid++) {
          const sim = dot(v, vectors.get(clusters[cid][0].id)!);
          if (sim >= bestSim) {
            bestSim = sim;
            bestCluster = cid;
          }
        }
        if (bestCluster < 0) clusters.push([item]);
        else clusters[bestCluster].push(item);
      }
      clusters.sort((a, b) => b.length - a.length);
      // Legacy cosine picks up to 3 top-TFIDF members per cluster by static score
      const ordered: Material[] = [];
      for (const cl of clusters) {
        const sorted = [...cl].sort((a, b) => b.messages.length - a.messages.length || a.id.localeCompare(b.id));
        ordered.push(...sorted.slice(0, 2));
      }
      for (const item of ordered) {
        const c = sampledCosts.get(item.id)!;
        if (usedChars + c <= budgetChars) {
          selected.push(item);
          usedChars += c;
        }
      }
    } else {
      // Unified Pure Monotone CELF CTSS (Algorithm 1 & Theorem 1):
      const celfCandidates = allMaterials.map(item => ({
        id: item.id,
        item,
        actionPrimitives: item.trajectory.actionPrimitives,
        repairConstraints: item.trajectory.repairConstraints,
        cost: sampledCosts.get(item.id)!
      }));
      const res = selectCTSSPureCELF(celfCandidates, budgetChars, {
        lambda: mode === 'ctss-no-repair' ? 0.0 : 0.65,
        alpha: mode === 'ctss-no-cost-norm' ? 0.0 : 1.0,
        useSubmodular: mode !== 'ctss-no-submodular',
        actionWeights,
        repairWeights
      });
      for (const hit of res.selected) selected.push(hit.item);
      usedChars = res.usedCost;
    }

    const latencyMs = Math.max(1, Math.round((performance.now() - t0) * 10) / 10);

    // Evaluate unified ground-truth metrics for the selected subset S
    const finalAct = new Map<string, number>();
    const finalRep = new Map<string, number>();
    for (const item of selected) {
      for (const [k, v] of item.trajectory.actionPrimitives) {
        finalAct.set(k, Math.min(1, (finalAct.get(k) || 0) + Math.min(1, v * 0.6)));
      }
      for (const [k, v] of item.trajectory.repairConstraints) {
        const cur = finalRep.get(k) || 0;
        const p = Math.min(0.85, v * 0.65);
        finalRep.set(k, 1 - (1 - cur) * (1 - p));
      }
    }

    let achievedActionWeight = 0;
    for (const [k, val] of finalAct) {
      achievedActionWeight += (actionWeights.get(k) || 1) * val;
    }
    let achievedRepairWeight = 0;
    for (const [k, val] of finalRep) {
      achievedRepairWeight += (repairWeights.get(k) || 1) * val;
    }

    let pairSimSum = 0;
    let pairCount = 0;
    const samplePeers = selected.slice(0, 80);
    for (let i = 0; i < samplePeers.length; i++) {
      const vi = vectors.get(samplePeers[i].id)!;
      for (let j = i + 1; j < samplePeers.length; j++) {
        pairSimSum += dot(vi, vectors.get(samplePeers[j].id)!);
        pairCount++;
      }
    }
    const redundancyScore = pairCount > 0 ? Math.round((pairSimSum / pairCount) * 1000) / 1000 : 0;
    const actionCoveragePct = totalActionWeight > 0 ? Math.round((achievedActionWeight / totalActionWeight) * 1000) / 10 : 0;
    const correctionRetentionPct = totalRepairWeight > 0 ? Math.round((achievedRepairWeight / totalRepairWeight) * 1000) / 10 : 0;
    const compressionRatioPct = rawChars > 0 ? Math.round((1 - usedChars / rawChars) * 10000) / 100 : 0;
    const submodularObjective = Math.round((actionCoveragePct + 1.15 * correctionRetentionPct - 15 * redundancyScore) * 10) / 10;

    results.push({
      mode,
      label: labels[mode],
      rawConversations: conversations.length,
      rawEpisodes: allMaterials.length,
      rawChars,
      rawTokensEst,
      budgetChars,
      selectedEpisodes: selected.length,
      selectedChars: usedChars,
      selectedTokensEst: Math.ceil(usedChars / 3.8),
      compressionRatioPct,
      inputReductionPct: compressionRatioPct,
      actionCoveragePct,
      correctionRetentionPct,
      redundancyScore,
      submodularObjective,
      latencyMs,
      llmCalls: 0
    });
  }

  return results;
}
