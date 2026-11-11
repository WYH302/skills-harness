import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, copyFile, mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Store } from '../core/store';
import { BrowserBridge } from '../core/bridge';
import { Pipeline, type Collector } from '../core/pipeline';
import { detectLocalSources } from '../adapters/local';
import { demoConversations } from '../core/demo-data';
import { detectDestinations, exportSkills, installSkill } from '../core/delivery';
import { validateSkill, routeSkills } from '../core/skills';
import { SOURCE_IDS, SOURCE_NAMES, LOCAL_SOURCES, IMPORT_SOURCES, type AppState, type SourceId, type Settings, type RunRequest } from '../shared/types';
import { product, API_PRESETS } from '../shared/catalog';
import { localizeNotice } from '../shared/localization';
import { assertSafeUrl, hash, inDateRange, safeError } from '../core/util';
import { credentialFor, consentForSettings, endpointIdentity, type BoundCredential } from '../core/credentials';
import { discoverLocalSources } from '../adapters/discovery';
import { discoverGenerators, cliTransport, verifyOllamaModel, type GeneratorRuntime } from '../core/generators';
import { PlanAuth } from '../core/plan-auth';
import { encryptedPlanVault } from '../core/plan-vault';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

let window:BrowserWindow|null=null;
let realStore:Store;
let exampleStore:Store;
let store:Store;
let bridge:BrowserBridge;
let pipeline:Pipeline;
let realPipeline:Pipeline;
let demoPipeline:Pipeline;
let inDemo=false;
let quitting=false;
let localStatuses:Awaited<ReturnType<typeof detectLocalSources>>=[];
let lastLocalDetection=0;let cachedDestinations:Awaited<ReturnType<typeof detectDestinations>>=[];
let generatorRuntimes:GeneratorRuntime[]=[];
let discoveryTask:Promise<void>|null=null;
let discoveryHome:string|undefined;
const verificationScope=process.env.SKILLHARBOR_TEST==='1'&&process.env.SKILLHARBOR_ALLOW_REAL_DISCOVERY==='1'&&process.env.SKILLHARBOR_VERIFY_PROJECT&&path.isAbsolute(process.env.SKILLHARBOR_VERIFY_PROJECT)?path.resolve(process.env.SKILLHARBOR_VERIFY_PROJECT):undefined;
const verificationCutoff=verificationScope&&process.env.SKILLHARBOR_VERIFY_SAVED_BEFORE?Date.parse(process.env.SKILLHARBOR_VERIFY_SAVED_BEFORE):undefined;
let rendererURL='';
let planAuth:PlanAuth;let planVault:ReturnType<typeof encryptedPlanVault>;
const argsSchema=z.object({id:z.string().min(1).max(100)});
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const runSchema=z.object({sources:z.array(z.enum(SOURCE_IDS)).min(1).max(SOURCE_IDS.length),dateFrom:date,dateTo:date,resume:z.boolean().optional()});
const settingsSchema=z.object({language:z.enum(['zh','en']).optional(),skillOutputLanguage:z.enum(['interface','zh','en','source']).optional(),apiProvider:z.string().max(100).optional(),analysisMode:z.enum(['extractive','local','remote','chatgpt-plan','codex','claude-code','antigravity','gemini-cli','openclaw','hermes','deepseek-cli','cursor-cli']).optional(),model:z.string().max(300).optional(),endpoint:z.string().max(2000).optional(),remoteConsent:z.boolean().optional(),consentEndpoint:z.string().max(2000).optional(),maxModelCalls:z.number().int().min(0).max(1000).optional(),maxInputChars:z.number().int().min(1000).max(20_000_000).optional(),maxOutputTokens:z.number().int().min(256).max(16000).optional(),incremental:z.boolean().optional(),redactSensitive:z.boolean().optional(),autoConsolidate:z.boolean().optional(),analysisDetail:z.enum(['focused','full']).optional(),processingStrategy:z.enum(['representative','full']).optional(),apiKey:z.string().max(4096).optional()});
const notify=()=>{if(window&&!window.isDestroyed())window.webContents.send('skillharbor:update');};
function generationOptions(){try{return [...(planAuth?.options()||[]),...generatorRuntimes.map(r=>r.option)];}catch{return generatorRuntimes.map(r=>r.option);}}
function chooseGenerator(id:string,approved=false,selectOnly=false):void {
  if(id==='extractive'){if(!inDemo&&process.env.SKILLHARBOR_TEST==='1')throw new Error('请连接会员、本机大模型或 API 后生成 Skills。 / Connect an AI account, local model or API to generate.');store.saveSettings({analysisMode:'extractive',generatorId:'extractive',generationConsentIdentity:undefined});return;}
  if(id==='configured'){if(!['local','remote'].includes(store.settings().analysisMode)||!store.settings().model)throw new Error('Connect a model first');return;}
  const option=generationOptions().find(o=>o.id===id);if(!option?.ready)throw new Error('所选助手尚未连接。 / The selected assistant is not connected.');
  const old=store.settings();const consent=old.generationConsentIdentity===option.consentIdentity||approved;
  if(!selectOnly&&option.privacy==='remote'&&!consent)throw new Error('请先确认所选账号与数据去向。 / Confirm the selected account and transfer before generation.');
  if(option.kind==='ollama')store.saveSettings({analysisMode:option.privacy==='local'?'local':'remote',model:option.model||'',endpoint:'http://127.0.0.1:11434/v1',generatorId:id,generationConsentIdentity:consent?option.consentIdentity:undefined,remoteConsent:option.privacy==='remote'&&consent,remoteConsentEndpoint:option.privacy==='remote'&&consent?endpointIdentity('http://127.0.0.1:11434/v1'):undefined});
  else store.saveSettings({analysisMode:option.kind,model:option.kind==='chatgpt-plan'?option.model||'':'',generatorId:id,generationConsentIdentity:consent?option.consentIdentity:undefined});
}
async function recheckLocalModel():Promise<void>{
  const option=generationOptions().find(o=>o.id===store.settings().generatorId);
  if(option?.kind==='ollama'&&option.localVerified&&!await verifyOllamaModel(option.model||''))throw new Error('模型的本机运行状态已变化，请重新检测并确认数据去向。 / Model locality changed. Check again and confirm the data destination.');
}
async function readModelCatalog(response:Response):Promise<unknown>{
  if(!response.body)throw new Error('模型列表为空。 / Empty model catalog');const reader=response.body.getReader();let bytes=0;const parts:Uint8Array[]=[];
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1000000)throw new Error('模型列表过大。 / Model catalog too large');parts.push(value);}try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new Error('服务未返回有效模型列表。 / The service did not return a valid model catalog');}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function vaultPath():string {return path.join(realStore.dir,'provider-key.bin');}
function secureEncryptionAvailable():boolean {return safeStorage.isEncryptionAvailable()&&!(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text');}
function getApiKey():string {
  const settings=store.settings();
  if(inDemo||!['local','remote'].includes(settings.analysisMode))return '';
  if(settings.analysisMode==='remote'&&!realStore.getMeta('envKeyDisabled',false)&&process.env.SKILLHARBOR_API_KEY&&endpointIdentity(process.env.SKILLHARBOR_API_ENDPOINT||'')===endpointIdentity(settings.endpoint))return process.env.SKILLHARBOR_API_KEY;
  if(!existsSync(vaultPath())||!secureEncryptionAvailable())return '';
  try{return credentialFor(JSON.parse(safeStorage.decryptString(readFileSync(vaultPath()))) as BoundCredential,settings);}catch{return '';}
}
function setApiKey(key:string,settings:Settings):void {
  realStore.setMeta('envKeyDisabled',key==='');
  if(key===''){if(existsSync(vaultPath()))unlinkSync(vaultPath());return;}
  if(settings.analysisMode!=='local'&&settings.analysisMode!=='remote')throw new Error('Select an API provider before saving a key');
  if(!secureEncryptionAvailable())throw new Error('OS credential encryption unavailable. Use SKILLHARBOR_API_KEY and matching SKILLHARBOR_API_ENDPOINT environment variables.');
  writeFileSync(vaultPath(),safeStorage.encryptString(JSON.stringify({endpoint:settings.endpoint,mode:settings.analysisMode,key} satisfies BoundCredential)),{mode:0o600});
}
const demoCollector:Collector=async function*(source,options){
  const records=demoConversations(exampleStore.getMeta('demoExpanded',false)).filter(c=>c.source===source);
  yield {type:'progress',discovered:records.length,detail:'非敏感示例 / Synthetic example'};
  for(const c of records){options.signal.throwIfAborted();if(inDateRange(c,options.dateFrom,options.dateTo))yield {type:'conversation',conversation:c};await new Promise(resolve=>setTimeout(resolve,30));}
};
function selectedRoots():Partial<Record<SourceId,string[]>> {
  const selected=realStore.getMeta<string[]>('selectedHistoryInstances',[]);const roots:Partial<Record<SourceId,string[]>>={};
  for(const source of localStatuses){const instances=source.instances||[];const chosen=instances.filter(instance=>selected.includes(instance.id));const active=chosen.length?chosen:instances.filter(instance=>instance.state==='ready').slice(0,1);if(active.length)roots[source.id]=active.flatMap(instance=>instance.roots);}
  return roots;
}
async function scanDiscovery(wakeWSL=false):Promise<void> {
  if(discoveryTask)return discoveryTask;
  lastLocalDetection=Date.now();
  discoveryTask=Promise.allSettled([
    discoverLocalSources({home:discoveryHome,roots:realStore.getMeta('sourceRoots',{}),wakeWSL,projectPath:verificationScope,stableBefore:verificationCutoff,onSource:source=>{localStatuses=[...localStatuses.filter(item=>item.id!==source.id),source];notify();}}),
    process.env.SKILLHARBOR_TEST==='1'&&process.env.SKILLHARBOR_ALLOW_REAL_DISCOVERY!=='1'?Promise.resolve([]):discoverGenerators()
  ]).then(results=>{if(results[0].status==='fulfilled'){localStatuses=results[0].value;if(process.env.SKILLHARBOR_TEST!=='1')realStore.setMeta('cachedLocalStatuses',localStatuses);}if(results[1].status==='fulfilled'){generatorRuntimes=results[1].value;if(process.env.SKILLHARBOR_TEST!=='1')realStore.setMeta('cachedGeneratorRuntimes',generatorRuntimes);}}).finally(()=>{discoveryTask=null;notify();});
  notify();return discoveryTask;
}
async function state():Promise<AppState> {
  if(!inDemo&&!pipeline.busy&&Date.now()-lastLocalDetection>180000)void scanDiscovery();
  // Finish asynchronous metadata reads before taking a coherent synchronous library/run snapshot.
  const destinations=inDemo?[]:pipeline.busy&&cachedDestinations.length?cachedDestinations:(cachedDestinations=await detectDestinations());
  const importedCounts=new Map((store.db.prepare('SELECT source,count(*) n FROM conversations GROUP BY source').all() as {source:SourceId;n:number}[]).map(row=>[row.source,row.n]));
  const fallbackSources=IMPORT_SOURCES.map(id=>({id,title:SOURCE_NAMES[id],kind:(product(id).developer?'local':'web') as 'web'|'local',available:!!importedCounts.get(id),connected:!!importedCounts.get(id),historyCount:importedCounts.get(id)||0,countExact:true,mode:'import' as const,detail:'仅文件导入：可读取带角色的 JSON、Markdown 或文本；自动历史采集尚未接入，专有导出格式可能需要转换。 / File import only: role-labeled JSON, Markdown or text. Automatic collection is not implemented; proprietary exports may need conversion.'}));
  const sources=inDemo?SOURCE_IDS.map(id=>({id,title:SOURCE_NAMES[id],kind:(product(id).developer?'local':'web') as 'web'|'local',available:true,connected:true,mode:'automatic' as const,detail:'非敏感示例数据源 / Synthetic demonstration source'})):[...bridge.sourceStatuses(),...localStatuses,...fallbackSources];
  return {historyScope:verificationScope?'SkillHarbor 项目 · 已保存的历史（不含当前进行中的会话）':undefined,settings:{...store.settings(),apiKeySet:!!getApiKey()},sources,generators:inDemo?[]:generationOptions(),auth:inDemo?undefined:planAuth?.state,discovering:!inDemo&&!!discoveryTask&&localStatuses.some(s=>s.discoveryState==='scanning'),selection:store.getMeta('lastSelection',undefined),skills:store.skills(),run:pipeline.run?structuredClone(pipeline.run):null,stats:store.stats(),destinations,bridge:inDemo?{port:bridge.port,paired:false}:bridge.info(),demo:inDemo};
}
async function request(method:string,input:unknown):Promise<unknown> {
  switch(method) {
    case 'getState':return state();
    case 'setLanguage': {const {language}=z.object({language:z.enum(['zh','en'])}).parse(input);realStore.saveSettings({language});exampleStore.saveSettings({language});notify();return {language};}
    case 'chooseGenerator': {if(pipeline.busy)throw new Error('Finish the current run first');const {id}=z.object({id:z.string().max(300)}).parse(input);chooseGenerator(id,false,true);notify();return {selected:id};}
    case 'connectChatGPT': {if(inDemo||pipeline.busy)throw new Error('Return to your workspace before connecting');if(!secureEncryptionAvailable())throw new Error('OS credential encryption is unavailable / 系统凭据保护暂不可用');const data=z.object({accountId:z.string().max(100).optional()}).parse(input||{});await planAuth.start(data.accountId);return null;}
    case 'cancelAuthorization':planAuth.cancel();return null;
    case 'refreshChatGPTModels': {if(pipeline.busy)throw new Error('Finish this run first');const {id}=argsSchema.parse(input);await planAuth.refreshCatalog(id.replace(/^chatgpt-plan:/,''));return {refreshed:true};}
    case 'disconnectChatGPT': {if(pipeline.busy)throw new Error('Finish the current run first');const {id}=argsSchema.parse(input);const revoked=await planAuth.signOut(id.replace(/^chatgpt-plan:/,''));return {revoked};}
    case 'connectGenerator': {
      if(inDemo||pipeline.busy)throw new Error('Return to your workspace before connecting');const {id}=argsSchema.parse(input);const runtime=generatorRuntimes.find(r=>r.option.id===id);if(!runtime)throw new Error('Assistant not found');
      if(!runtime.executable){const urls:Record<string,string>={'codex':'https://developers.openai.com/codex/quickstart','claude-code':'https://code.claude.com/docs/en/setup','antigravity':'https://antigravity.google/','gemini-cli':'https://geminicli.com/docs/get-started/installation/','openclaw':'https://openclaw.ai/','hermes':'https://github.com/NousResearch/hermes-agent','deepseek-cli':'https://api-docs.deepseek.com/','cursor-cli':'https://cursor.com/docs/cli/installation'};await shell.openExternal(urls[id]||'https://geminicli.com');return {installationRequired:true};}
      const args=runtime.option.kind==='codex'?['login']:runtime.option.kind==='claude-code'?['auth','login']:runtime.option.kind==='cursor-cli'?['login']:[];
      if(process.platform==='win32'){
        const quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";const command='& '+[runtime.executable,...(runtime.prefix||[]),...args].map(quote).join(' ');
        const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-Command',command],{windowsHide:false,detached:true,stdio:'ignore'});child.on('error',()=>notify());child.unref();return {officialWindow:true};
      }
      throw new Error('请从官方客户端完成登录，然后点击重新检测。 / Sign in with the official client, then check again.');
    }
    case 'probeApi': {
      if(pipeline.busy)throw new Error('Finish this run first');const {endpoint,apiKey}=z.object({endpoint:z.string().max(2000),apiKey:z.string().max(4096).optional()}).parse(input);const url=assertSafeUrl(endpoint,false);const key=apiKey||(endpointIdentity(endpoint)===endpointIdentity(store.settings().endpoint)?getApiKey():'');
      const r=await fetch(url.href.replace(/\/$/,'')+'/models',{redirect:'error',signal:AbortSignal.timeout(10000),headers:key?{Authorization:`Bearer ${key}`}:{}});if([404,405].includes(r.status))return {models:[],catalogUnavailable:true,verified:false};if(!r.ok)throw new Error('连接未通过，请检查地址、密钥及服务权限。 / Connection failed; check address, key and access.');const data=await readModelCatalog(r) as {data?:{id?:unknown}[]};return {models:(Array.isArray(data?.data)?data.data:[]).filter(m=>typeof m?.id==='string').slice(0,100).map(m=>m.id),verified:true};
    }
    case 'discover':if(pipeline.busy)throw new Error('Wait for this run to finish / 请等待本次任务结束');await scanDiscovery(!!z.object({wakeWSL:z.boolean().optional()}).parse(input||{}).wakeWSL);return null;
    case 'generate': {
      if(pipeline.busy)throw new Error('A run is already active');
      const data=runSchema.extend({generatorId:z.string().max(300),approved:z.boolean().optional(),instances:z.array(z.string().max(100)).max(100).optional()}).parse(input);
      if(data.dateFrom&&data.dateTo&&data.dateFrom>data.dateTo)throw new Error('Invalid date range');
      if(discoveryTask&&(localStatuses.some(s=>s.discoveryState==='scanning')||(data.generatorId!=='extractive'&&data.generatorId!=='configured'&&!generationOptions().some(o=>o.id===data.generatorId))))await discoveryTask;chooseGenerator(data.generatorId,!!data.approved);await recheckLocalModel();
      const known=new Set(localStatuses.filter(source=>data.sources.includes(source.id)).flatMap(source=>source.instances||[]).map(instance=>instance.id));
      if(data.instances?.some(id=>!known.has(id)))throw new Error('History location changed; detect again / 历史位置已变化，请重新检测');
      if(!inDemo)store.setMeta('selectedHistoryInstances',data.instances||[]);
      store.setMeta('lastSelection',{sources:data.sources,instances:data.instances,range:!!(data.dateFrom||data.dateTo),from:data.dateFrom||'',to:data.dateTo||''});
      return pipeline.start({sources:data.sources,dateFrom:data.dateFrom,dateTo:data.dateTo});
    }
    case 'chooseSourceDirectory': {
      if(inDemo||pipeline.busy)throw new Error('Finish this run in the personal workspace first');
      const {source}=z.object({source:z.enum(LOCAL_SOURCES)}).parse(input);
      const result=await dialog.showOpenDialog(window!,{title:localizeNotice('选择该工具的历史位置 / Choose the tool history folder',store.settings().language),properties:['openDirectory']});if(result.canceled)return {cancelled:true};
      const chosen=path.resolve(result.filePaths[0]);if(chosen===path.parse(chosen).root)throw new Error('Choose a specific history folder, not an entire drive / 请选择具体历史文件夹，避免扫描整块硬盘');
      const children=source==='codex'?['sessions','archived_sessions']:source==='claude-code'?['projects']:source==='antigravity'?['brain']:source==='gemini-cli'?['tmp','sessions','chats']:source==='openclaw'?['sessions','agents','logs']:source==='hermes'?['sessions','trajectories','logs']:source==='deepseek-harness'?['sessions','history']:source==='cursor'?['globalStorage','workspaceStorage']:[];
      const nested=children.map(child=>path.join(chosen,child)).filter(existsSync);const saved=store.getMeta<Partial<Record<SourceId,string[]>>>('sourceRoots',{});saved[source]=nested.length?nested:[chosen];store.setMeta('sourceRoots',saved);await scanDiscovery();return null;
    }
    case 'run': {const data=runSchema.parse(input);if(data.dateFrom&&data.dateTo&&data.dateFrom>data.dateTo)throw new Error('Invalid date range');return pipeline.start(data);}
    case 'cancel':pipeline.cancel();return null;
    case 'resume': {const data=z.object({failedOnly:z.boolean().optional(),analysisOnly:z.boolean().optional(),approved:z.boolean().optional(),generatorId:z.string().max(300).optional()}).parse(input||{});if(!inDemo){chooseGenerator(data.generatorId||store.settings().generatorId||'configured',!!data.approved);await recheckLocalModel();}return pipeline.resume(data);}
    case 'demo': {
      if(realPipeline.busy||demoPipeline.busy)throw new Error('Wait for the current run or cancel it');
      inDemo=true;store=exampleStore;pipeline=demoPipeline;
      return pipeline.start({sources:['chatgpt','claude','gemini','codex','claude-code','cursor','opencode']});
    }
    case 'exitDemo':if(pipeline.busy)throw new Error('Cancel the running demonstration first');inDemo=false;store=realStore;pipeline=realPipeline;notify();return null;
    case 'import': {
      if(pipeline.busy)throw new Error('Wait for the current run or cancel it');
      const source=z.object({source:z.enum(SOURCE_IDS).optional()}).parse(input||{}).source;
      const result=await dialog.showOpenDialog(window!,{title:localizeNotice('导入历史 / Import history',store.settings().language),properties:['openFile'],filters:[{name:localizeNotice('AI 历史 / AI histories',store.settings().language),extensions:['json','jsonl','gz','zst','zip','html','htm','xml','md','txt']}]});
      if(result.canceled)return {cancelled:true};
      return pipeline.start({sources:source?[source]:[]},{path:result.filePaths[0],source});
    }
    case 'saveSettings': {
      if(pipeline.busy)throw new Error('Settings cannot change during a run');
      const data=settingsSchema.parse(input);const {apiKey,consentEndpoint,...update}=data;if(update.endpoint&&update.endpoint!==store.settings().endpoint&&!update.apiProvider)update.apiProvider='custom';
      if(inDemo&&apiKey!==undefined)throw new Error('Provider keys cannot be changed in demonstration mode');
      const consent=consentForSettings(store.settings(),update,consentEndpoint);
      const next={...store.settings(),...update,...consent};
      if(update.apiProvider&&update.apiProvider!=='custom'&&!API_PRESETS.some(p=>p.id===update.apiProvider&&endpointIdentity(p.endpoint)===endpointIdentity(next.endpoint)))throw new Error('服务地址与所选通道不匹配，请选择自定义服务。 / The endpoint does not match the selected provider; choose Custom.');
      if(next.analysisMode==='local'||next.analysisMode==='remote'){assertSafeUrl(next.endpoint,next.analysisMode==='local');if(!next.model.trim())throw new Error('Choose an analysis model / 请输入模型名称');}
      if(next.analysisMode==='remote'&&!next.remoteConsent)throw new Error('Explicit consent is required for remote analysis / 请先同意发送分析片段');
      if(apiKey!==undefined)setApiKey(apiKey,next);
      const chosen=update.analysisMode&&['extractive','local','remote'].includes(update.analysisMode)?{generatorId:update.analysisMode==='extractive'?'extractive':'configured',generationConsentIdentity:undefined}:{};const saved=store.saveSettings({...update,...consent,...chosen});notify();return {...saved,apiKeySet:!!getApiKey()};
    }
    case 'skill':return store.skill(argsSchema.parse(input).id);
    case 'saveSkill': {const {id,markdown}=argsSchema.extend({markdown:z.string().min(30).max(100000)}).parse(input);const s=store.skill(id);const validation=validateSkill(markdown,s.name,s.resources);if(!validation.valid)throw new Error(validation.issues.join('; '));const saved=store.saveSkill({...s,markdown,userEdited:true,validation},'user edit');notify();return saved;}
    case 'skillState': {
      const {id,state:nextState,enabled}=argsSchema.extend({state:z.enum(['candidate','active','dormant','archived']).optional(),enabled:z.boolean().optional()}).parse(input);const s=store.skill(id);
      if((enabled===true||nextState==='active')&&!s.validation.valid)throw new Error('Skill validation required');
      const state=nextState??(enabled===true?'active':enabled===false?'dormant':s.state);
      const saved=store.saveSkill({...s,state,enabled:state==='archived'||state==='dormant'?false:enabled??state==='active'},'lifecycle change');notify();return saved;
    }
    case 'deleteSkill':store.deleteSkill(argsSchema.parse(input).id);notify();return null;
    case 'evidence': {const e=store.episode(argsSchema.parse(input).id);if(!e)throw new Error('Evidence not found');return {episode:e,conversation:store.conversation(e.conversationId),conversations:[...new Set([e.conversationId,...e.evidence.map(ref=>ref.conversationId||e.conversationId)])].map(id=>store.conversation(id)).filter(Boolean)};}
    case 'selectedMaterials':return store.getMeta('selectedMaterialPlan',{runId:pipeline.run?.id,groups:[]});
    case 'versions':return store.versions(argsSchema.parse(input).id);
    case 'rollback': {const {id,version}=argsSchema.extend({version:z.number().int().min(1)}).parse(input);const s=store.skill(id);const previous=store.versions(id).find(v=>v.version===version);if(!previous)throw new Error('Version not found');const nextResources=previous.resources??s.resources;const saved=store.saveSkill({...s,markdown:previous.markdown,resources:nextResources,userEdited:true,validation:validateSkill(previous.markdown,s.name,nextResources)},`rollback to version ${version}`);notify();return saved;}
    case 'acceptRevision': {const s=store.skill(argsSchema.parse(input).id);if(!s.proposedRevision)throw new Error('No proposed revision');const markdown=s.proposedRevision;const nextResources=s.proposedResources??s.resources;const validation=validateSkill(markdown,s.name,nextResources);if(!validation.valid)throw new Error(validation.issues.join('; '));const saved=store.saveSkill({...s,markdown,resources:nextResources,proposedRevision:undefined,proposedResources:undefined,dismissedRevisionHash:undefined,validation,userEdited:false},'accepted generated revision');notify();return saved;}
    case 'dismissRevision': {const s=store.skill(argsSchema.parse(input).id);if(!s.proposedRevision)throw new Error('No proposed revision');const saved=store.saveSkill({...s,dismissedRevisionHash:hash([s.proposedRevision,s.proposedResources||s.resources||[]]),proposedRevision:undefined,proposedResources:undefined,userEdited:true},'kept user version; proposal dismissed');notify();return saved;}
    case 'export': {
      const {id}=z.object({id:z.string().max(100).optional()}).parse(input||{});const skills=id?[store.skill(id)]:store.skills().filter(s=>s.state!=='archived');if(!skills.length)throw new Error('No skills to export');
      const result=await dialog.showSaveDialog(window!,{title:localizeNotice('导出技能 / Export skills',store.settings().language),defaultPath:`${id?skills[0].name:'SkillHarbor-Library'}.zip`,filters:[{name:'Agent Skills ZIP',extensions:['zip']}]});if(result.canceled||!result.filePath)return {cancelled:true};await writeFile(result.filePath,exportSkills(skills),{mode:0o600});return {path:result.filePath};
    }
    case 'install': {
      if(inDemo)throw new Error('Export examples to inspect them; installation is disabled in demo mode');
      const {id,destinationId}=argsSchema.extend({destinationId:z.string().max(100)}).parse(input);const destination=(await detectDestinations()).find(d=>d.id===destinationId);if(!destination)throw new Error('Destination not found');const s=store.skill(id);const p=await installSkill(s,destination);store.saveSkill({...s,installedTo:[...new Set([...(s.installedTo||[]),p])]},'installation recorded');notify();return {path:p};
    }
    case 'forget': {if(pipeline.busy)throw new Error('Cancel the active run before deleting data');const {scope}=z.object({scope:z.enum(['history','derived','skills','all'])}).parse(input);store.forget(scope);if(scope==='all'&&!inDemo){setApiKey('',store.settings());planAuth.cancel();planVault.erase();bridge.revoke();}pipeline.run=null;notify();return null;}
    case 'chooseDataDir': {
      if(inDemo||pipeline.busy)throw new Error('Return to the real workspace and finish the active run');
      const result=await dialog.showOpenDialog(window!,{title:localizeNotice('选择新的空文件夹；重启后复制资料 / Choose an empty folder; data copied on restart',store.settings().language),properties:['openDirectory','createDirectory']});if(result.canceled)return {};
      const target=result.filePaths[0];if(existsSync(path.join(target,'skillharbor.sqlite')))throw new Error('Destination already contains a library');
      writeFileSync(path.join(app.getPath('userData'),'storage-location.json'),JSON.stringify({path:target,copyFrom:realStore.dir}),{mode:0o600});return {path:target,restartRequired:true};
    }
    case 'openExtension': {
      const shipped=app.isPackaged?path.join(process.resourcesPath,'extension'):path.join(app.getAppPath(),'extension');
      // Portable executables extract resources to a temporary directory. Chromium needs a stable extension path.
      const folder=path.join(realStore.dir,'browser-extension');
      await cp(shipped,folder,{recursive:true,force:true});
      await shell.openPath(folder);return null;
    }
    case 'openExternal': {const {url}=z.object({url:z.string().max(3000)}).parse(input);const parsed=new URL(url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Unsafe URL');await shell.openExternal(parsed.href);return null;}
    case 'rotatePairingCode':bridge.rotateCode();notify();return null;
    case 'selectBrowser':if(pipeline.busy)throw new Error('Finish this run first / 请先结束本次任务');bridge.selectClient(z.object({id:z.string().max(100)}).parse(input).id);notify();return null;
    case 'connectSource':bridge.openSource(z.object({source:z.enum(SOURCE_IDS)}).parse(input).source);return null;
    case 'router':return routeSkills(z.object({query:z.string().max(10000)}).parse(input).query,store.skills());
    case 'getConversations':return store.conversationSummaries();
    case 'conversation':return store.conversation(argsSchema.parse(input).id);
    case 'restart':app.relaunch();app.quit();return null;
    default:throw new Error('Unknown action');
  }
}
async function boot():Promise<void> {
  const legacyData=path.join(app.getPath('appData'),'SkillHarbor');
  const userData=process.env.SKILLHARBOR_TEST==='1'?app.getPath('userData'):existsSync(path.join(legacyData,'library','skillharbor.sqlite'))?legacyData:app.getPath('userData');
  mkdirSync(userData,{recursive:true});
  const configPath=path.join(userData,'storage-location.json');let config:{path?:string;copyFrom?:string}={};
  try{config=JSON.parse(readFileSync(configPath,'utf8'));}catch{}
  const dir=process.env.SKILLHARBOR_DATA_DIR||config.path||path.join(userData,'library');
  if(!process.env.SKILLHARBOR_DATA_DIR&&config.copyFrom&&config.copyFrom!==dir&&!existsSync(path.join(dir,'skillharbor.sqlite'))) {
    // The previous process closed and checkpointed SQLite before this explicit, user-selected migration.
    await mkdir(dir,{recursive:true});
    for(const name of ['skillharbor.sqlite','provider-key.bin','plan-accounts.bin'])if(existsSync(path.join(config.copyFrom,name)))await copyFile(path.join(config.copyFrom,name),path.join(dir,name));
    writeFileSync(configPath,JSON.stringify({path:dir}),{mode:0o600});
  }
  realStore=new Store(dir);exampleStore=new Store(path.join(dir,'demo-library'));store=realStore;
  planVault=encryptedPlanVault(realStore.dir,{available:secureEncryptionAvailable,encrypt:text=>safeStorage.encryptString(text),decrypt:bytes=>safeStorage.decryptString(bytes)});
  const hostId=realStore.getMeta('planHostId','')||`urn:uuid:${randomUUID()}`;realStore.setMeta('planHostId',hostId);
  planAuth=new PlanAuth(planVault,hostId,url=>shell.openExternal(url),notify);
  bridge=new BrowserBridge(realStore);bridge.setListener(notify);
  try{await bridge.start(process.env.SKILLHARBOR_TEST==='1'?0:42837);}catch{ /* Desktop remains usable for local sources and imports if port is occupied. */ }
  if(process.env.SKILLHARBOR_TEST==='1')discoveryHome=process.env.SKILLHARBOR_TEST_HOME||(process.env.SKILLHARBOR_ALLOW_REAL_DISCOVERY!=='1'?path.join(dir,'test-home'):undefined);
  const runtime={requireModel:process.env.SKILLHARBOR_TEST==='1',projectPath:verificationScope,stableBefore:verificationCutoff,roots:selectedRoots,availability:()=>[...localStatuses,...bridge.sourceStatuses()],transport:async(settings:Settings)=>{if(settings.analysisMode==='chatgpt-plan')return planAuth.transport(settings);const found=generatorRuntimes.find(item=>item.option.id===(settings.generatorId||settings.analysisMode));if(!found)throw new Error('Generation tool not found / 未找到生成工具');return cliTransport(found,settings);}};
  realPipeline=new Pipeline(realStore,bridge,notify,getApiKey,undefined,runtime);demoPipeline=new Pipeline(exampleStore,null,notify,()=>'',demoCollector);pipeline=realPipeline;
  if(!realStore.getMeta<Partial<Settings>>('settings',{}).language)realStore.saveSettings({language:(process.env.SKILLHARBOR_TEST==='1'?process.env.SKILLHARBOR_TEST_LOCALE||'zh-CN':app.getLocale()).toLowerCase().startsWith('zh')?'zh':'en'});
  exampleStore.saveSettings({language:realStore.settings().language});
  const cachedLocal=process.env.SKILLHARBOR_TEST!=='1'?realStore.getMeta<typeof localStatuses>('cachedLocalStatuses',[]):[];
  const cachedGens=process.env.SKILLHARBOR_TEST!=='1'?realStore.getMeta<typeof generatorRuntimes>('cachedGeneratorRuntimes',[]):[];
  if(cachedGens.length)generatorRuntimes=cachedGens;
  const cachedById=new Map(cachedLocal.map(item=>[item.id,item]));
  localStatuses=LOCAL_SOURCES.map(id=>cachedById.get(id)||({id,title:SOURCE_NAMES[id],kind:'local',available:false,connected:false,mode:'automatic',discoveryState:'scanning',detail:'正在查找可用历史 / Discovering saved history'}));
  void scanDiscovery();
  const dev=process.env.SKILLHARBOR_DEV_URL;
  rendererURL=dev||new URL(`file://${path.join(app.getAppPath(),'dist','renderer','index.html').replace(/\\/g,'/')}`).href;
  window=new BrowserWindow({width:1440,height:1000,minWidth:900,minHeight:680,backgroundColor:'#fafafa',title:'Skills-Harness',icon:path.join(__dirname,'../branding/icon.png'),show:false,...(process.platform==='win32'?{titleBarStyle:'hidden' as const,titleBarOverlay:{color:'#fafafa',symbolColor:'#3f3f46',height:48}}:{}),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==rendererURL)event.preventDefault();});
  window.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ipcMain.handle('skillharbor:request',async(event,method:unknown,input:unknown)=>{
    if(event.sender!==window?.webContents||event.senderFrame!==window.webContents.mainFrame||event.senderFrame.url!==rendererURL)throw new Error('Unauthorized renderer');
    if(typeof method!=='string')throw new Error('Invalid action');
    try{return await request(method,input);}catch(e){
      if(e instanceof z.ZodError)throw new Error('Invalid input / 输入格式无效');
      // Errors from our boundary checks may be shown; imported/provider error content never reaches this handler.
      const message=e instanceof Error?e.message:'';
      if(message.length<400&&!/https?:\/\/|sk-|Bearer|[A-Z]:\\/i.test(message))throw new Error(localizeNotice(message,store.settings().language));
      throw new Error(localizeNotice(safeError(e),store.settings().language));
    }
  });
  window.once('ready-to-show',()=>window?.show());
  if(dev)await window.loadURL(dev);else await window.loadFile(path.join(app.getAppPath(),'dist','renderer','index.html'));
  if(process.env.SKILLHARBOR_DEMO==='1'){inDemo=true;store=exampleStore;pipeline=demoPipeline;pipeline.start({sources:['chatgpt','claude','gemini','codex','claude-code','cursor']});}
  window.on('closed',()=>{window=null;});
}
if(process.env.SKILLHARBOR_TEST==='1'&&process.env.SKILLHARBOR_DATA_DIR){const testProfile=path.join(process.env.SKILLHARBOR_DATA_DIR,'test-profile');mkdirSync(testProfile,{recursive:true});app.setPath('userData',testProfile);}
if(!app.requestSingleInstanceLock())app.quit();
else {
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(boot).catch(()=>{dialog.showErrorBox('Skills-Harness','无法打开本地资料库。请检查文件夹权限，或关闭其他实例。 / Could not open the local library. Check permissions and other instances.');app.quit();});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',event=>{
    if(quitting)return;
    if(realPipeline?.busy||demoPipeline?.busy){event.preventDefault();quitting=true;realPipeline?.cancel();demoPipeline?.cancel();void Promise.all([realPipeline?.wait(),demoPipeline?.wait()]).then(()=>app.quit());return;}
    quitting=true;
  });
  app.on('will-quit',()=>{planAuth?.close();void bridge?.close();try{realStore?.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');realStore?.close();exampleStore?.close();}catch{}});
}
