import { parse, stringify } from 'yaml';
import type { Conversation, Episode, Evidence, Skill, SkillResource, TaskCheck, Validation } from '../shared/types';
import { hash, now, redact, unique } from './util';
import { similarity, tokens } from './mining';
import { validateOrganization, type ProcedureOrganization, type OrganizationGroup } from './procedure-organization';

export const SAFE_RESOURCE_PATH=/^(?:templates|references|scripts)\/[a-z0-9][a-z0-9._-]{0,60}\.[a-z0-9]{1,8}$/;
export function validateResources(resources:SkillResource[]|undefined):{issues:string[];warnings:string[]} {
  const issues:string[]=[];const warnings:string[]=[];
  if(!resources?.length)return {issues,warnings};
  const seen=new Set<string>();
  for(const r of resources) {
    if(!SAFE_RESOURCE_PATH.test(r.path)||r.path.includes('..'))issues.push(`Unsafe resource path: ${r.path}`);
    if(seen.has(r.path))issues.push(`Duplicate resource path: ${r.path}`);
    seen.add(r.path);
    if(!r.title?.trim()||!r.purpose?.trim()||!r.content?.trim())issues.push(`Incomplete resource metadata or content: ${r.path}`);
    if(r.content&&r.content.length>120000)issues.push(`Resource exceeds size limit: ${r.path}`);
    if(r.requiresReview!==true)issues.push(`Resource must require review: ${r.path}`);
    if(!Array.isArray(r.evidence)||!r.evidence.length||r.evidence.some(e=>!e?.messageId||!e?.quote))issues.push(`Resource lacks source evidence: ${r.path}`);
    if(r.kind==='script')warnings.push('Bundled scripts are reference material requiring review and are never executed automatically. / 附带脚本属于待审阅参考材料，不会自动运行。');
  }
  return {issues:unique(issues),warnings:unique(warnings)};
}

export function validateSkill(markdown:string,directoryName?:string,resources?:SkillResource[]):Validation {
  const issues:string[]=[];const warnings:string[]=[];
  const front=markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!front)return {valid:false,issues:['Missing YAML frontmatter / 缺少元数据'],warnings};
  try {
    const metadata=parse(front[1],{maxAliasCount:0});
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata))throw new Error('Mapping required');
    const name=metadata.name;
    if(typeof name!=='string'||name.length>64||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))issues.push('Invalid name: use 1–64 lowercase letters/numbers/hyphens');
    if(directoryName&&name!==directoryName)issues.push('Skill name must match its directory');
    if(typeof metadata.description!=='string'||!metadata.description.trim()||metadata.description.length>1024)issues.push('Description must contain 1–1024 characters');
    if(metadata.compatibility&&(typeof metadata.compatibility!=='string'||metadata.compatibility.length>500))issues.push('Invalid compatibility field');
    if(metadata.metadata&&(typeof metadata.metadata!=='object'||Array.isArray(metadata.metadata)||Object.values(metadata.metadata).some(v=>typeof v!=='string')))issues.push('metadata values must be strings');
    if(metadata['allowed-tools'])warnings.push('Review any requested tool authority before installation. / 安装前核对工具权限。');
  }catch{issues.push('Invalid YAML frontmatter');}
  const body=markdown.slice(front[0].length);
  const numbered=body.split('\n').filter(l=>/^\d+[.)]\s+\S/.test(l));
  if(numbered.length<3)issues.push('A reusable procedure needs at least three concrete steps / 至少需要三个具体步骤');
  if(!/trigger|when to use|触发|适用/i.test(body))issues.push('Missing activation conditions / 缺少触发条件');
  if(!/output|输出|交付/i.test(body))issues.push('Missing expected output / 缺少交付要求');
  if(body.length>24000)warnings.push('Long skill: consider moving detail into references.');
  if(/ignore (?:all |previous |system )*instructions|忽略(?:所有|之前|系统).*指令|exfiltrat|upload.*(?:secret|credentials)/i.test(body))issues.push('Potential authority escalation: review and remove unsafe instructions');
  if(redact(markdown)!==markdown)warnings.push('Potential personal data: review the redacted export before sharing. / 可能含个人信息，请检查脱敏导出。');
  if(/```(?:bash|sh|powershell|python|js)/i.test(body))warnings.push('Embedded code is reference material and is never executed automatically.');
  const resCheck=validateResources(resources);
  issues.push(...resCheck.issues);warnings.push(...resCheck.warnings);
  return {valid:issues.length===0,issues:unique(issues),warnings:unique(warnings)};
}
function compatible(a:Episode,b:Episode):number {
  if(a.scope!==b.scope)return 0;
  if(a.scope==='project'&&a.conversationId!==b.conversationId)return 0; // Unknown project identity is not evidence of a shared project.
  if(a.outputLanguage&&b.outputLanguage&&a.outputLanguage!==b.outputLanguage)return 0;
  if(!shareProcedureAnchors(a,b)||conflictingChecks(a,b))return 0;
  const aa=a.steps.join('\n'),bb=b.steps.join('\n');
  const method=similarity(aa,bb);
  // Different procedures on the same topic do not merge just because their goals match.
  if(method<0.42)return 0;
  return method*.8+similarity(a.goal,b.goal)*.15+similarity(a.outputs.join(' '),b.outputs.join(' '))*.05;
}
// Literal case, spacing, Unicode and operators can be significant; only trim the instruction's edges and normalize single-symbol/LaTeX command inline backticks.
const stepKey=(step:string)=>step.replace(/`(\\[a-zA-Z]+(?:\{[^`]*\})?)`/g,'$1').replace(/`([$§%#&~^_\\]{1,3})`/g,'$1').replace(/^(Part\s*\d+\s*\[[^\]]+\][：:]\s*只输出[^\n。]+?)(?:\s*LaTeX\s*代码)?([。.]?)$/,'$1$2').trim();
function shareProcedureAnchors(a:Episode,b:Episode):boolean {
  const left=a.steps.map(stepKey),right=b.steps.map(stepKey);
  if(new Set(left).size!==left.length||new Set(right).size!==right.length)return false;
  const common=new Set(left.filter(step=>right.includes(step)));
  if(common.size<2||common.size/Math.min(left.length,right.length)<.5)return false;
  // A bag of matching words does not establish that the same ordered method was used.
  if(left.filter(step=>common.has(step)).join('\n')!==right.filter(step=>common.has(step)).join('\n'))return false;
  const leftOnly=a.steps.filter(step=>!common.has(stepKey(step))),rightOnly=b.steps.filter(step=>!common.has(stepKey(step)));
  // Closely worded alternatives may differ in a condition, polarity or parameter. Keep them separate.
  return !leftOnly.some(x=>rightOnly.some(y=>similarity(x,y)>.55));
}
function conflictingChecks(a:Episode,b:Episode):boolean {
  return (a.quality?.checks||[]).some(left=>(b.quality?.checks||[]).some(right=>{
    if((left.op==='contains'&&right.op==='not_contains'||left.op==='not_contains'&&right.op==='contains')&&typeof left.arg==='string'&&typeof right.arg==='string')return left.arg===right.arg;
    if(left.op==='max_chars'&&right.op==='min_chars'&&typeof left.arg==='number'&&typeof right.arg==='number')return left.arg<right.arg;
    return left.op==='min_chars'&&right.op==='max_chars'&&typeof left.arg==='number'&&typeof right.arg==='number'&&left.arg>right.arg;
  }));
}
function rankEpisodes(a:Episode,b:Episode):number {
  const ca=a.contributingConversations?.length||1,cb=b.contributingConversations?.length||1;
  return (cb>=2?cb:0)-(ca>=2?ca:0)||Number(b.outcome==='accepted')-Number(a.outcome==='accepted')||b.steps.length-a.steps.length||(a.id<b.id?-1:a.id>b.id?1:0);
}
interface ProcedureMerge {steps:string[];ambiguous:boolean}
function alignedProcedure(group:OrganizationGroup,members:Episode[]):ProcedureMerge {
  const origins=new Map(group.steps.flatMap((step,i)=>step.from.map(ref=>[`${ref.episodeId}:${ref.index}`,i] as const)));
  const next=group.steps.map(()=>new Set<number>()),incoming=group.steps.map(()=>0);
  for(const e of members)for(let i=1;i<e.steps.length;i++){
    const a=origins.get(`${e.id}:${i-1}`)!,b=origins.get(`${e.id}:${i}`)!;
    if(a!==b&&!next[a].has(b)){next[a].add(b);incoming[b]++;}
  }
  const ready=incoming.flatMap((n,i)=>n===0?[i]:[]);let ambiguous=false;
  while(ready.length){if(ready.length>1)ambiguous=true;const index=ready.shift()!;for(const target of next[index])if(--incoming[target]===0)ready.push(target);}
  return {steps:group.steps.map(step=>members.find(e=>e.id===step.use.episodeId)!.steps[step.use.index]),ambiguous};
}
function mergeProcedure(group:Episode[]):ProcedureMerge|null {
  if(group.length===1)return {steps:group[0].steps,ambiguous:false};
  const nodes=new Map<string,{text:string;order:number;next:Set<string>;incoming:number}>();
  for(const episode of [...group].sort(rankEpisodes)) {
    const sequence=episode.steps.map(stepKey);
    for(let i=0;i<sequence.length;i++)if(!nodes.has(sequence[i]))nodes.set(sequence[i],{text:episode.steps[i],order:nodes.size,next:new Set(),incoming:0});
    for(let i=1;i<sequence.length;i++) {
      const before=nodes.get(sequence[i-1])!,after=nodes.get(sequence[i])!;
      if(!before.next.has(sequence[i])){before.next.add(sequence[i]);after.incoming++;}
    }
  }
  const ready=[...nodes.keys()].filter(key=>nodes.get(key)!.incoming===0);const steps:string[]=[];let ambiguous=false;
  while(ready.length) {
    ready.sort((a,b)=>nodes.get(a)!.order-nodes.get(b)!.order);
    if(ready.length>1)ambiguous=true;
    const node=nodes.get(ready.shift()!)!;steps.push(node.text);
    for(const key of node.next){const next=nodes.get(key)!;if(--next.incoming===0)ready.push(key);}
  }
  // Three individually compatible histories can still form a combined ordering cycle.
  return steps.length===nodes.size?{steps,ambiguous}:null;
}
function slug(text:string,key:string):string {
  const words=[...tokens(text)].filter(t=>/^[a-z][a-z0-9-]{2,}$/.test(t)).slice(0,5).join('-').replace(/-+/g,'-').slice(0,48);
  return `${words||'personal-procedure'}-${key.slice(0,8)}`;
}
export function distillSkillTitle(rawTitle:string,steps?:string[]):string {
  let text=redact(rawTitle).replace(/\t+/g,' ').replace(/\s*#+\s*(?:Task|Role|Context|Background|Instructions?|Output|Input)\b.*$/i,'').replace(/\*\*/g,'').replace(/`/g,'').trim();
  text=text.replace(/^<image[^>]*>\s*/i,'').replace(/^(?:环境在\s*)?(?:\[USER_HOME\][^\s，。；,;:]*|[A-Za-z]:[\\/][^\s，。；,;:]+)[\s，。；,;:]*(?:的\s*[A-Za-z0-9_.-]+[\s，。；,;:]*)?/gi,'');
  text=text.replace(/^(?:调用相关的skills[:：]\s*|请先完整阅读并严格遵循以下文件中的要求[：:，,\s]*|把下面这(?:整)?段话直接发给\s*Codex[^：:。]*[：:。]\s*|直接把下面这段话发给\s*Codex[^：:。]*[：:。]\s*|请直接在后台自主跑完[^：:。]*[：:。]\s*|你看看我的完整对话[：:，,\s]*|负责[“"]?[^”"？?]+[”"]?是哪一个\s*(?:是哪一个)?\s*agent[啊呀]?[?？。.\s]*(?:现在我要给他补充一些命令[,，\s]*补充一些信息[：:\s]*)?(?:环境在\s*[A-Za-z]:[\\/][^\s。.]*[。.\s]*)?|也不是说只能只有一个啦[。.\s]*[^。！？!?]*[。！？!?\s]*[^。！？!?]*[?？\s]*|我刚刚安装了\s*\S+[，,\s]*现在可以|投其所好[：:]\s*|细心的[，,\s]*|现在请你|请你帮我|请先帮我|先帮我|请先|请你|请|帮我|麻烦你|麻烦|please\s+help\s+me\s+|please\s+|can\s+you\s+|could\s+you\s+|well,?\s*i\s+remember\s+that\s+|so\s+maybe\s+we\s+should\s+)/i,'');
  const personaTask=text.match(/^(?:你是一位|你是一个|作为一名|作为)负责(.+?)的[^。，,]+[。，,\s]+(?:你的任务是(?:进行)?|专注于|负责)(.+)$/);
  if(personaTask)text=`${personaTask[1].trim()}与${personaTask[2].trim()}`;
  else{
    const personaFocus=text.match(/^(?:你是一位|你是一个|作为一名|作为)[^。，,]+[，,。]\s*(?:你的任务是|专注于|专门负责|负责|请帮我|请)(.+)$/);
    if(personaFocus&&personaFocus[1].trim().length>=8)text=personaFocus[1].trim();
  }
  text=text.replace(/[。.]\s*你的(?:核心)?(?:目标|任务)(?:不仅仅是|是).*$/,'').replace(/[。.]\s*特别注意[：:].*$/,'');
  text=text.replace(/[，,\s]*(?:对吧|好吗|可以吗|谢谢|行吗)[。.!?！？]*$/i,'').replace(/[。.!?！？:：；;，,/]+$/,'').replace(/\s+and\s+(?:why|how|what|where|whether)\s+(?:different\s+)?\w+$/i,'').trim();
  if((text.length<10||/^(?:时间\s+任务性质|ra_final_packager|在手稿生成pdf)/i.test(text)||/是否有/.test(text))&&steps?.length){
    const s0=redact(steps.find(s=>s.length>=12&&s.length<=48&&!/是否/.test(s))||steps.find(s=>s.length>=12&&s.length<=48)||steps[0]).replace(/^[0-9]+[.)、]\s*/,'').replace(/[。.；;]+$/,'').trim();
    if(s0.length>=10&&s0.length<=48)text=s0;
  }
  if(text.length>56){
    const cut=text.slice(0,56).search(/[。！？；!?;，,（(]\s*[^。！？；!?;，,（(]*$/);
    if(cut>=12)text=text.slice(0,cut).replace(/[。.!?！？:：；;，,（(]+$/,'').trim();
  }
  return text.trim()||rawTitle.trim();
}
function isGeneralizableExtractiveSop(episode:Episode):boolean {
  if(episode.scope!=='general'||episode.steps.length<4||(episode.executionEvidence||0)<4||unique(episode.evidence.map(ref=>ref.quote)).length<4)return false;
  if(!(episode.inputs.length>0||episode.outputs.length>0||episode.preferences.length>0||episode.corrections.length>0||!!episode.quality))return false;
  if(/[?？]/.test(episode.goal)&&!/负责|中庸/.test(episode.goal))return false;
  if(/(?:不怕一万|为什么|怎么|哪些|什么工作|还是“protocol|加载到了哪些)/.test(episode.goal))return false;
  const body=episode.steps.join('\n');
  if(/(?:Abstract|Introduction|Related Work(?![\s\u4e00-\u9fa5]*写法)|Discussion|Limitations?|Conclusion|Supplementary|Chapter\s*\d|第[一二三四五六七八九十\d]+章|cite keys|bib entries|\bmain\.bbl\b|\bsubmission\/v\d|\bagent\s*\d+\b|论文原图|论文原表|从.+模板中提取|\b[\w-]+\.(?:cls|sty|tex|bib|olean|pptx)\b|\b[\w-]+-main\b|\b\d{2}\s*\/\s*\d{2}\b)/i.test(body))return false;
  if(episode.steps.some(s=>/^(?:不保留\s+`?[A-Z]|`?[A-Z][a-z]+[A-Z][A-Za-z]+`?\s*[：:]\s*替换|`?[A-Z][A-Za-z0-9_-]{2,}`?\s*[：:]\s*[A-Za-z])/.test(s)))return false;
  const imperative=/^(?:必须|严禁|禁止|切忌|不要|不得|不允许|不(?:使用|修改|删除|复制|记录|生成|新增)|只(?:允许|读取|修改|保留|使用|在)|优先|确保|确认|检查|核对|核实|提取|读取|生成|运行|执行|编译|导出|分析|评估|判断|保留|移除|删除|替换|修改|重写|润色|记录|汇总|对比|区分|防止|避免|如果|若|当|每个|对每|在.+前|先.+再|同时(?:生成|保留)|写入前|修改方式|识别每|跑.+前|需要检查|候选\s*Skill|按[“"]?完整会话|找可以进行|明确(?:告诉|说明|一个)|说明为什么|要求先|把生成\s*PDF|For |When |Ensure |Verify |Check |Run |Inspect |Always |Never |Do not |Part\s*\d)/i;
  const clauseNormative=/^[^。；\n]{2,28}(?:必须|严禁|禁止|不得|不能|应当|需要|只允许|清空上下文|围绕目标)/;
  const labeled=/^[^：:\n]{2,18}[：:]\s*(?:必须|严禁|禁止|不要|不得|只|优先|确保|确认|检查|核对|提取|读取|生成|运行|保留|移除|删除|替换|修改|重写|润色|记录|对比|如果|若|严格|使用)/i;
  const validSteps=episode.steps.filter(s=>imperative.test(s)||clauseNormative.test(s)||labeled.test(s)).length;
  return validSteps/episode.steps.length>=0.75;
}
const list=(items:string[],fallback='根据当前任务确认；历史中未提供固定要求。 / Confirm for the current task; no fixed requirement is evidenced.')=>items.length?items.map(s=>`- ${redact(s)}`).join('\n'):`- ${fallback}`;
function repeatedPreferences(episodes:Episode[]):string[] {
  const counter=new Map<string,{text:string;count:number}>();
  for(const e of episodes)for(const p of unique(e.preferences)) {const key=p.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');const old=counter.get(key);counter.set(key,{text:p,count:(old?.count||0)+1});}
  return [...counter.values()].filter(p=>p.count>=2||/以后|始终|默认|always|from now on/i.test(p.text)).map(p=>p.text);
}
function checkInstruction(check:TaskCheck,tx:(zh:string,en:string)=>string):string {
  const value=JSON.stringify(check.arg);
  const actions:Record<TaskCheck['op'],string>={
    contains:tx('输出须包含','Output must contain'),not_contains:tx('输出不得包含','Output must not contain'),
    section_present:tx('须有章节或栏目','Required section or field'),section_contains:tx('核对章节或栏目的内容','Check section or field content'),
    regex:tx('核对与此表达式对应的内容要求','Check the content requirement represented by this pattern'),
    tool_called:tx('确认此工具要求适用且已获授权后检查调用记录','After confirming applicability and authorization, check the call record for this tool'),
    max_chars:tx('输出字符数上限','Maximum output characters'),min_chars:tx('输出字符数下限','Minimum output characters'),
    no_refusal:tx('核对历史中关于完成任务的要求；不扩大当前权限','Review the historical completion requirement without expanding current authority')
  };
  return `${check.description} (${actions[check.op]}${check.arg===null?'':`: ${value}`})`;
}
function uniqueEvidence(items:Evidence[]):Evidence[] {
  const seen=new Set<string>();const out:Evidence[]=[];
  for(const item of items) {
    if(!item?.messageId||!item?.quote)continue;
    const key=`${item.conversationId||''}\0${item.messageId}\0${item.quote}`;
    if(seen.has(key))continue;
    seen.add(key);out.push(item);
  }
  return out;
}
function buildSkillResources(title:string,group:Episode[],steps:string[],inputs:string[],outputs:string[],preferences:string[],corrections:string[],rubrics:string[],concreteChecks:string[],tx:(zh:string,en:string)=>string,conversations?:Map<string,Conversation>):SkillResource[] {
  const resources:SkillResource[]=[];
  const baseEvidence=uniqueEvidence(group.flatMap(e=>e.evidence.map(ref=>({...ref,conversationId:ref.conversationId||e.conversationId})))).slice(0,12);
  if(!baseEvidence.length)return resources;
  const checkItems=unique([...rubrics,...concreteChecks,...preferences,...corrections]);
  if(steps.length>=3&&(checkItems.length>0||steps.length>=4)) {
    const sections:string[]=[`# ${redact(title)} — ${tx('执行与验收核对清单','Execution & Verification Checklist')}`,'',`> ${tx('根据历史对话依据生成；执行与交付前逐项核对。','Derived from historical evidence; check each item before delivery.')}`,''];
    sections.push(`## ${tx('执行步骤核对','Procedure Steps')}`,'',...steps.map(s=>`- [ ] ${redact(s)}`),'');
    if(preferences.length)sections.push(`## ${tx('个人偏好与约束','Preferences & Constraints')}`,'',...preferences.map(p=>`- [ ] ${redact(p)}`),'');
    if(corrections.length)sections.push(`## ${tx('历史纠错与避坑检查','Historical Corrections & Pitfalls')}`,'',...corrections.map(c=>`- [ ] ${redact(c)}`),'');
    if(rubrics.length||concreteChecks.length)sections.push(`## ${tx('完成与验收标准','Completion & Acceptance Criteria')}`,'',...[...rubrics,...concreteChecks].map(c=>`- [ ] ${redact(c)}`),'');
    resources.push({path:'references/verification-checklist.md',title:tx('执行与验收核对清单','Execution & verification checklist'),purpose:tx('在执行和交付前核对步骤、偏好、历史纠正项与完成标准。','Verify steps, preferences, historical corrections and completion criteria before delivery.'),kind:'checklist',content:sections.join('\n').trim()+'\n',evidence:baseEvidence,requiresReview:true});
  }
  if(inputs.length>0||outputs.length>0||concreteChecks.length>0) {
    const inputLines=inputs.length?inputs.map(i=>`- **${redact(i)}**: ${tx('（填写当前任务输入）','(fill in for current task)')}`):[`- ${tx('确认当前任务的输入材料与约束条件','Confirm current task inputs and constraints')}`];
    const outputLines=outputs.length?outputs.map(o=>`### ${redact(o)}\n\n${tx('（在此整理对应交付内容）','(provide deliverable content here)')}`):[`### ${tx('交付结果','Deliverable Output')}\n\n${tx('（在此整理最终交付内容）','(provide final deliverable content here)')}`];
    const content=[`# ${redact(title)} — ${tx('任务交付模板','Deliverable Template')}`,'',`## 1. ${tx('输入与适用条件确认','Inputs & Applicability')}`,'',...inputLines,'',`## 2. ${tx('关键步骤执行记录','Key Procedure Execution Log')}`,'',...steps.map((s,i)=>`${i+1}. **${redact(s)}**\n   - ${tx('记录/结果','Notes/Result')}: `),'',`## 3. ${tx('交付产出','Deliverable Output')}`,'',...outputLines,''].join('\n');
    resources.push({path:'templates/deliverable-template.md',title:tx('任务输入与交付模板','Task input & deliverable template'),purpose:tx('结构化记录当前任务输入、步骤执行结果与最终交付物。','Structure task inputs, step execution notes and final deliverables.'),kind:'template',content,evidence:baseEvidence,requiresReview:true});
  }
  if(conversations?.size) {
    const seenCode=new Set<string>();
    let scriptCount=0,templateCount=0;
    const scriptLangs:Record<string,string>={sh:'sh',bash:'sh',zsh:'sh',shell:'sh',ps1:'ps1',powershell:'ps1',pwsh:'ps1',py:'py',python:'py',js:'mjs',javascript:'mjs',mjs:'mjs',ts:'ts',typescript:'ts',sql:'sql'};
    const templateLangs:Record<string,string>={json:'json',yaml:'yaml',yml:'yaml',toml:'toml',html:'html',md:'md',markdown:'md'};
    const convIds=unique(group.flatMap(e=>[e.conversationId,...(e.contributingConversations||[]),...e.evidence.map(r=>r.conversationId||e.conversationId)]));
    for(const cid of convIds) {
      const conv=conversations.get(cid);if(!conv)continue;
      const citedIds=new Set(group.flatMap(e=>e.evidence.filter(r=>(r.conversationId||e.conversationId)===cid).map(r=>r.messageId)));
      const citedIndices=conv.messages.map((m,idx)=>citedIds.has(m.id)?idx:-1).filter(idx=>idx>=0);
      const candidates=conv.messages.filter((m,idx)=>m.role==='assistant'&&!m.toolName&&(citedIds.has(m.id)||citedIndices.some(ci=>Math.abs(ci-idx)<=6)||conv.messages.length<=24));
      for(const msg of candidates) {
        const regex=/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g;
        let match:RegExpExecArray|null;
        while((match=regex.exec(msg.text))!==null) {
          const lang=(match[1]||'').toLowerCase().trim();
          const rawCode=match[2].trim();
          if(rawCode.length<45||rawCode.length>8000||rawCode.split('\n').length<2)continue;
          if(/^(?:Traceback \(most recent|Error:|Exception:|npm ERR!)/m.test(rawCode))continue;
          const codeHash=hash(rawCode);if(seenCode.has(codeHash))continue;
          const quoteLine=rawCode.split('\n').map(l=>l.trim()).find(l=>l.length>=10&&l.length<=240&&msg.text.includes(l))||rawCode.slice(0,120);
          if(!msg.text.includes(quoteLine))continue;
          if(scriptLangs[lang]&&scriptCount<2) {
            seenCode.add(codeHash);scriptCount++;
            const ext=scriptLangs[lang];
            resources.push({path:`scripts/reference-script-${scriptCount}.${ext}`,title:tx(`历史参考脚本 ${scriptCount} (${ext})`,`Historical reference script ${scriptCount} (${ext})`),purpose:tx('来自历史回答的参考脚本；使用前必须人工审阅参数与环境，不会自动执行。','Reference script from historical assistant output; review parameters and environment before use. Never executed automatically.'),kind:'script',content:redact(rawCode)+'\n',evidence:[{messageId:msg.id,conversationId:conv.id,quote:quoteLine,kind:'step'}],requiresReview:true});
          }else if(templateLangs[lang]&&templateCount<2) {
            seenCode.add(codeHash);templateCount++;
            const ext=templateLangs[lang];
            resources.push({path:`templates/reference-snippet-${templateCount}.${ext}`,title:tx(`历史配置与模板片段 ${templateCount} (${ext})`,`Historical template snippet ${templateCount} (${ext})`),purpose:tx('来自历史回答的结构化配置或模板片段，可根据当前任务修改复用。','Structured configuration or template snippet from history; adapt for the current task.'),kind:'template',content:redact(rawCode)+'\n',evidence:[{messageId:msg.id,conversationId:conv.id,quote:quoteLine,kind:'step'}],requiresReview:true});
          }
        }
      }
    }
  }
  return resources;
}
export interface Discovery {skills:Skill[];rejected:number;conflicts:string[]}
export function discoverSkills(episodes:Episode[],existing:Skill[],consolidate=true,outputLanguage?:'zh'|'en'|'source',organization?:ProcedureOrganization,conversations?:Conversation[]):Discovery {
  const convMap=conversations?new Map(conversations.filter(c=>c.id).map(c=>[c.id!,c])):undefined;
  const usable=episodes.filter(e=>e.steps.length>=3&&e.outcome!=='failed'&&(e.analysis!=='model'||(e.executionEvidence||0)>=2)).sort(rankEpisodes);
  const clusters:Episode[][]=[];
  const aligned=new Map<string,ProcedureMerge>();const organized=new Set<string>();
  const groupKey=(group:Episode[])=>hash(group.map(e=>e.id).sort());
  for(const group of organization?.groups||[]){
    const members=group.episodeIds.map(id=>usable.find(e=>e.id===id));
    if(members.some(e=>!e))continue;
    validateOrganization({groups:[group]},members as Episode[]);
    if(group.episodeIds.some(id=>organized.has(id)))throw new Error('Procedure organization contains duplicate episodes');
    group.episodeIds.forEach(id=>organized.add(id));
    const sorted=(members as Episode[]).sort(rankEpisodes);clusters.push(sorted);aligned.set(groupKey(sorted),alignedProcedure(group,sorted));
  }
  const owners=new Map<string,string>();
  if(!consolidate)for(const skill of existing)for(const id of skill.evidenceIds)owners.set(id,skill.id);
  for(const e of usable.filter(e=>!organized.has(e.id))) {
    const cluster=clusters.find(group=>!aligned.has(groupKey(group))&&group.every(peer=>compatible(peer,e)>=0.42&&(!owners.get(peer.id)||!owners.get(e.id)||owners.get(peer.id)===owners.get(e.id)))&&mergeProcedure([...group,e]));
    if(cluster)cluster.push(e);else clusters.push([e]);
  }
  const result:Skill[]=[];let rejected=episodes.length-usable.length;const conflicts:string[]=[];const claimed=new Set<string>();
  for(const group of clusters) {
    const independent=unique(group.flatMap(e=>e.contributingConversations||[e.conversationId]));
    const detailedCandidate=group.some(episode=>episode.outcome==='unknown'&&(episode.analysis==='model'?episode.steps.length>=5&&(episode.executionEvidence||0)>=4&&unique(episode.evidence.map(ref=>ref.quote)).length>=5&&episode.inputs.length>0&&episode.outputs.length>0:isGeneralizableExtractiveSop(episode)));
    if(independent.length<2&&!group.some(e=>e.outcome==='accepted')&&!detailedCandidate){rejected++;continue;}
    const best=group[0];const procedure=aligned.get(groupKey(group))||mergeProcedure(group)!;
    const modelAligned=group.length>1&&aligned.has(groupKey(group));
    const evidenceIds=unique(group.flatMap(e=>e.contributingEpisodes||[e.id]));
    const sources=unique(group.flatMap(e=>e.contributingSources||[e.source]));
    const previous=existing.find(s=>!claimed.has(s.id)&&(s.evidenceIds.some(id=>evidenceIds.includes(id))||best.scope==='general'&&(similarity(s.trigger,best.goal)>0.72||similarity(s.trigger,distillSkillTitle(best.goal,procedure.steps))>0.72)&&similarity(s.markdown,best.steps.join('\n'))>0.46));
    if(previous)claimed.add(previous.id);
    const key=hash([best.scope,best.scope==='project'?best.conversationId:'',best.goal,procedure.steps,group.map(e=>[e.outputLanguage,e.quality])]);
    const name=previous?.name||slug(best.goal,key);
    const language=best.outputLanguage||outputLanguage;
    const keepPreviousTitle=!!previous?.title&&previous.evidenceIds.some(id=>evidenceIds.includes(id))&&(language!=='en'||!/[\p{Script=Han}]/u.test(previous.title)||/[\p{Script=Han}]/u.test(best.goal));
    const title=keepPreviousTitle?previous!.title:distillSkillTitle(best.goal,procedure.steps);
    const tx=(zh:string,en:string)=>!language?`${zh} / ${en}`:(language==='source'?/[\p{Script=Han}]/u.test(best.goal):language==='zh')?zh:en;
    const bullets=(items:string[])=>list(items,tx('根据当前任务确认；历史中未提供固定要求。','Confirm for the current task; no fixed requirement is evidenced.'));
    const trigger=tx(`当任务需要「${title}」所描述的交付物，且输入和步骤适用时使用。`,'Use when the task requires the deliverable described above and the inputs and procedure apply.');
    const description=`${title}. ${tx('使用场景：相同输入、目标和操作条件的后续任务。','Use for future tasks with compatible inputs, goal and conditions.')}`.slice(0,1024);
    const preferences=repeatedPreferences(group);
    const rejectedPeers=episodes.filter(e=>e.outcome==='failed'&&e.scope===best.scope&&(e.scope!=='project'||e.conversationId===best.conversationId)&&similarity(e.goal,best.goal)>.65);
    const corrections=unique([...group.flatMap(e=>e.corrections),...rejectedPeers.flatMap(e=>e.corrections)]);
    if(preferences.some(p=>preferences.some(other=>other!==p&&similarity(p,other)>.65&&/never|不要|禁止/i.test(p)!==/never|不要|禁止/i.test(other)&&!/如果|仅当|除非|普通|重要|unless|only when|if /i.test(p+other))))conflicts.push(`${title}: review potentially conflicting preferences / 请检查可能冲突的要求`);
    const criteria=group.flatMap(e=>e.quality?[e.quality]:[]);
    const rubrics=unique(criteria.flatMap(quality=>quality.rubric?[quality.rubric.text]:[]));
    const concreteChecks=unique(criteria.flatMap(quality=>quality.checks.map(check=>checkInstruction(check,tx))));
    const allInputs=unique(group.flatMap(e=>e.inputs));
    const allOutputs=unique(group.flatMap(e=>e.outputs));
    const resources:SkillResource[]=[];
    const criteriaText=criteria.length?`\n## ${tx('完成标准','Success criteria')}\n\n${bullets(unique([...rubrics,...concreteChecks]))}\n`:'';
    // Descriptions may omit the literal label, numeric bound or pattern. Retain
    // the validated arguments in the executable procedure as an explicit check.
    const deliveryCheck=concreteChecks.length?`\n${procedure.steps.length+1}. ${tx('交付前确认以下历史要求适用于当前任务，再逐项核对：','Before delivery, confirm the following historical requirements apply to this task, then check each one:')} ${concreteChecks.map(redact).join('; ')}`:'';
    const orderingNote=procedure.ambiguous?tx('部分互补步骤之间没有历史顺序依据；以上排序保留各来源已有的先后关系，复用前请确认补充步骤之间的顺序。','Some complementary steps have no evidenced relative order. The ordering above preserves each source sequence; confirm the order between additional steps before reuse.'):'';
    const metadata={name,description,metadata:{generator:'SkillHarbor',sources:sources.join(','),episodes:String(group.length),...(modelAligned?{'method-organization':'model-aligned; original-step-references'}:{})}};
    const markdown=`---\n${stringify(metadata).trim()}\n---\n\n# ${title}\n\n## ${tx('触发条件','When to use')}\n\n${trigger}\n${best.scope==='project'?`\n${tx('仅用于匹配的项目环境；先确认项目约束，不自动推广为全局规则。','Project-scoped: confirm the project context.')}\n`:''}\n## ${tx('输入','Inputs')}\n\n${bullets(allInputs)}\n\n## ${tx('执行步骤','Procedure')}\n\n${procedure.steps.map((step,i)=>`${i+1}. ${redact(step)}`).join('\n')}\n\n${orderingNote?orderingNote+'\n\n':''}## ${tx('个人要求','Preferences')}\n\n${bullets(preferences)}\n\n## ${tx('输出','Expected output')}\n\n${bullets(allOutputs)}\n\n## ${tx('例外和纠正','Exceptions and corrections')}\n\n${corrections.length?bullets(corrections):'- '+tx('如果输入、目标或操作条件不匹配，先调整流程，不照搬特定任务中的值。','Adapt the method when inputs, goals or conditions differ.')}\n`;
    const withDeliveryCheck=deliveryCheck?markdown.replace(`${procedure.steps.length}. ${redact(procedure.steps.at(-1)!)}`,`${procedure.steps.length}. ${redact(procedure.steps.at(-1)!)}${deliveryCheck}`):markdown;
    const withResources=criteriaText?`${withDeliveryCheck.trimEnd()}\n${criteriaText}`:withDeliveryCheck;
    const validation=validateSkill(withResources,name,resources);
    if(modelAligned)validation.warnings.push(tx('模型已对齐相关方法，步骤均选自已有记录；语义等价仍需结合适用条件检查。','The model aligned related procedures using existing steps; review semantic equivalence and applicability.'));
    if(independent.length===1&&!group.some(episode=>episode.outcome==='accepted'))validation.warnings.push('Single historical procedure; no user-confirmed success or transfer evaluation. Review this candidate before enabling. / 来自单次历史流程，尚无用户确认的成功或新任务验证；启用前请检查。');
    if(orderingNote)validation.warnings.push(orderingNote);
    if(criteria.length&&criteria.every(quality=>quality.basis==='format-only'))validation.warnings.push('Only formatting criteria were evidenced; task usefulness has not been evaluated. / 历史只给出了格式验收要求，不能据此认定任务效果。');
    if(!validation.valid){rejected++;continue;}
    const candidate:Skill={id:previous?.id||hash(name).slice(0,24),name,title,description,trigger,markdown:withResources,state:previous?.state||'candidate',enabled:previous?.enabled??false,version:previous?.version||0,userEdited:previous?.userEdited||false,updatedAt:now(),evidenceIds,sources,validation,resources:resources.length?resources:undefined,usageCount:previous?.usageCount||0,lastUsedAt:previous?.lastUsedAt,installedTo:previous?.installedTo};
    if(previous?.userEdited&&(previous.markdown!==withResources||JSON.stringify(previous.resources||[])!==JSON.stringify(resources))){
      const dismissed=previous.dismissedRevisionHash===hash(withResources)||previous.dismissedRevisionHash===hash([withResources,resources]);
      candidate.markdown=previous.markdown;candidate.resources=previous.resources;candidate.dismissedRevisionHash=previous.dismissedRevisionHash;
      if(!dismissed){candidate.proposedRevision=withResources;candidate.proposedResources=resources.length?resources:undefined;}
      candidate.validation=validateSkill(previous.markdown,name,previous.resources);
    }
    result.push(candidate);
  }
  return {skills:result,rejected,conflicts};
}

export function reconcileSkills(existing:Skill[],generated:Skill[],episodes:Episode[]):Skill[] {
  const changed:Skill[]=[];const generatedIds=new Set(generated.map(s=>s.id));
  const current=new Map(episodes.map(e=>[e.id,e]));
  for(const s of existing)if(!generatedIds.has(s.id)) {
    const evidence=s.evidenceIds.map(id=>current.get(id)).filter((e):e is Episode=>!!e&&e.steps.length>=3&&e.outcome!=='failed');
    const supported=unique(evidence.map(e=>e.conversationId)).length>=2||evidence.some(e=>e.outcome==='accepted');
    const merged=generated.some(g=>g.evidenceIds.some(id=>s.evidenceIds.includes(id)));
    if(!supported||merged) {
      const warning=merged?'Consolidated into another candidate; prior version retained. / 已整理到其他候选，原版本保留。':'Current history no longer supports this procedure; review before re-enabling. / 当前历史不再支持该流程，请核对后再启用。';
      const issues=supported?s.validation.issues:unique([...s.validation.issues,'Source evidence requires review / 来源依据需要复核']);
      changed.push({...s,state:s.state==='archived'?'archived':merged&&!s.userEdited?'archived':'candidate',enabled:false,validation:{...s.validation,valid:s.validation.valid&&supported,issues,warnings:unique([...s.validation.warnings,warning])}});
    }
  }
  return changed;
}

export function routeSkills(query:string,skills:Skill[],limit=3):Skill[] {
  return skills.filter(s=>s.enabled&&s.state==='active').map(s=>({s,score:similarity(query,[s.title,s.trigger,s.description].join(' '))})).filter(r=>r.score>.12).sort((a,b)=>b.score-a.score).slice(0,limit).map(r=>r.s);
}
