import { createReadStream, constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { localRoots, matchesProject, type LocalOptions } from './local';
import { jsonLines, walk } from './common';
import { findExecutable, runCommand, toolEnvironment } from '../core/commands';
import { hash } from '../core/util';
import { SOURCE_NAMES, type SourceAvailability, type SourceId, type HistoryInstance } from '../shared/types';

const localIds:SourceId[]=['codex','claude-code','antigravity','gemini-cli','openclaw','hermes','deepseek-harness','cursor','opencode'];
const logSourceIds=new Set<SourceId>(['codex','claude-code','antigravity','gemini-cli','openclaw','hermes','deepseek-harness']);
const uuid=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
interface Inventory {count:number;exact:boolean;readable:boolean;permission:boolean;found:boolean}
async function readableLog(file:string):Promise<boolean> {
  if(/\.jsonl(?:\.(?:gz|zst))?$/.test(file)) {
    let checked=0;
    for await(const line of jsonLines(file)) {
      const value=line.value;const message=value?.message||value?.payload||value;
      if(['user','assistant','model','human','agent'].includes(String(message?.role||'').toLowerCase())&&((typeof message.content==='string'&&!!message.content.trim())||(Array.isArray(message.content)&&message.content.length>0)||(Array.isArray(message.parts)&&message.parts.length>0)))return true;
      if(['USER_INPUT','PLANNER_RESPONSE'].includes(value?.type)&&typeof value?.content==='string'&&!!value.content.trim())return true;
      if((Array.isArray(value?.messages)&&value.messages.length>0)||(Array.isArray(value?.turns)&&value.turns.length>0))return true;
      if(value?.type==='event_msg'&&['user_message','agent_message'].includes(message?.type)&&typeof message.message==='string'&&!!message.message.trim())return true;
      if(++checked>=64)return false;
    }
    return false;
  }
  const raw=createReadStream(file,{highWaterMark:32768});
  const stream=file.endsWith('.gz')?raw.pipe(createGunzip()):file.endsWith('.zst')?raw.pipe(createZstdDecompress()):raw;
  if(stream!==raw)raw.once('error',error=>stream.destroy(error));
  let head='';
  try {for await(const piece of stream){head+=piece.toString('utf8');if(/"role"\s*:\s*"(?:user|assistant|model)"|"type"\s*:\s*"(?:user_message|agent_message|human|assistant|USER_INPUT|PLANNER_RESPONSE)"/.test(head))return true;if(head.length>131072)return false;}return false;}
  finally{stream.destroy();raw.destroy();}
}
async function inventory(source:SourceId,roots:string[],projectPath?:string,stableBefore?:number):Promise<Inventory> {
  const value:Inventory={count:0,exact:true,readable:false,permission:false,found:false};const ids=new Set<string>();let sampled=0;
  for(const root of roots) {
    try {
      const info=await lstat(root);if(info.isSymbolicLink())continue;value.found=true;await access(root,constants.R_OK);
      if(logSourceIds.has(source)) {
        for await(const file of walk(root,name=>/\.jsonl(?:\.(?:gz|zst))?$/.test(name))) {
          if(path.basename(file)==='transcript_full.jsonl')continue;
          if(projectPath&&!await matchesProject(file,projectPath,new AbortController().signal))continue;
          if(stableBefore&&(await lstat(file)).mtimeMs>stableBefore)continue;
          const id=(source==='antigravity'?file.match(uuid)?.[0]:undefined)||path.basename(file).match(uuid)?.[0]||file.replace(/\.(?:gz|zst)$/,'');ids.add(id);
          if(!value.readable&&sampled++<80)try{value.readable=await readableLog(file);}catch(error){if((error as NodeJS.ErrnoException).code==='EACCES')value.permission=true;}
        }
        // Filename groups are not proof that every file has readable messages.
        value.count=ids.size;value.exact=false;
      }else {
        for await(const file of walk(root,name=>source==='cursor'?/(?:^|[\\/])state\.vscdb$/.test(name):/\.db$/.test(name)||/(?:^|[\\/])session[\\/].+\.json$/.test(name))) {
          if(file.endsWith('.json')) {
            value.count++;value.exact=false;
            if(!value.readable)try {
              const metadata=JSON.parse(await (await import('node:fs/promises')).readFile(file,'utf8')) as {id?:string};
              if(metadata.id&&/^[A-Za-z0-9_-]+$/.test(metadata.id)) {
                const messageRoot=path.join(root,'storage','message',metadata.id);
                for await(const messageFile of walk(messageRoot,name=>name.endsWith('.json')))if(await readableLog(messageFile)){value.readable=true;break;}
              }
            }catch{}
            continue;
          }
          let db:DatabaseSync|undefined;
          try {
            db=new DatabaseSync(file,{readOnly:true});db.exec('PRAGMA busy_timeout=1000');
            const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>String(row.name)));
            if(source==='opencode'&&tables.has('session')&&tables.has('message')) {
              const count=Number(db.prepare('SELECT count(*) n FROM session s WHERE EXISTS (SELECT 1 FROM message m WHERE m.session_id=s.id)').get()!.n);value.count+=count;value.readable ||=count>0;
            }else if(source==='cursor')for(const table of ['cursorDiskKV','ItemTable'].filter(name=>tables.has(name))) {
              const count=Number(db.prepare(`SELECT count(*) n FROM ${table} WHERE key LIKE 'composerData:%' AND (value LIKE '%"bubbleId"%' OR value LIKE '%"role"%' OR EXISTS (SELECT 1 FROM ${table} b WHERE b.key LIKE 'bubbleId:' || substr(${table}.key, 14) || ':%'))`).get()!.n);
              const bubbles=Number(db.prepare(`SELECT count(*) n FROM ${table} WHERE key LIKE 'bubbleId:%'`).get()!.n);value.count+=count;value.readable ||=count>0||bubbles>0;value.exact=false;
            }
          }catch{value.exact=false;}finally{db?.close();}
        }
      }
    }catch(error){if(['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code||''))value.permission=true;}
  }
  return value;
}
async function instance(source:SourceId,roots:string[],label:string,environment:HistoryInstance['environment'],projectPath?:string,stableBefore?:number):Promise<HistoryInstance> {
  const found=await inventory(source,roots,projectPath,stableBefore);
  return {id:hash([source,roots,environment]).slice(0,24),source,label,environment,roots,historyCount:found.count,countExact:found.exact,state:found.readable?'ready':found.permission?'permission':found.found?'empty':'not-found',detail:found.readable?`已找到${found.exact?'':'约 '}${found.count} 段历史，可以使用。 / ${found.exact?'':'About '}${found.count} saved conversations found.`:found.permission?'需要允许读取历史位置。 / Permission needed to read saved history.':found.found?'已找到存储位置，尚未确认可读取的会话。 / Store found; no readable conversation confirmed.':'暂未发现保存的历史。 / No saved history found.'};
}

async function wslInstances(wake:boolean):Promise<HistoryInstance[]> {
  if(process.platform!=='win32')return [];
  try {
    const installed=await runCommand('wsl.exe',['--list','--quiet'],{timeout:4000,maxBytes:20000});
    if(installed.code!==0)return [];
    const running=await runCommand('wsl.exe',['--list','--running','--quiet'],{timeout:4000,maxBytes:20000});
    const names=(text:string)=>text.replace(/\0/g,'').replace(/^\uFEFF/,'').split(/\r?\n/).map(name=>name.trim()).filter(name=>name&&!/^docker-desktop/i.test(name));
    const active=new Set(names(running.stdout));const result:HistoryInstance[]=[];
    for(const distro of names(installed.stdout)) {
      if(!wake&&!active.has(distro)){for(const source of localIds)result.push({id:hash([source,'wsl',distro]).slice(0,24),source,label:`WSL · ${distro}`,environment:'wsl',roots:[],historyCount:0,countExact:false,state:'offline',detail:'此 WSL 环境未运行，尚未检测历史。 / This WSL environment is stopped; its histories have not been checked.'});continue;}
      // Fixed metadata-only command: never execute a command obtained from history.
      const info=await runCommand('wsl.exe',['--distribution',distro,'--exec','sh','-c','printf "%s\\n" "$HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"'],{timeout:8000,maxBytes:12000});
      if(info.code!==0)continue;
      const [home,codex,claude,data,config]=info.stdout.trimEnd().split('\n').map(value=>value.trim());if(!home?.startsWith('/'))continue;
      const unc=(linux:string)=>`\\\\wsl.localhost\\${distro}${linux.replace(/\//g,'\\')}`;
      const roots:Record<string,string[]>={codex:[`${codex||home+'/.codex'}/sessions`,`${codex||home+'/.codex'}/archived_sessions`],'claude-code':[`${claude||home+'/.claude'}/projects`],antigravity:[`${home}/.gemini/antigravity/brain`],'gemini-cli':[`${home}/.gemini/tmp`,`${home}/.gemini/sessions`,`${home}/.gemini/chats`],openclaw:[`${home}/.openclaw/sessions`,`${home}/.openclaw/agents`],hermes:[`${home}/.hermes/sessions`,`${home}/.hermes/trajectories`],'deepseek-harness':[`${home}/.deepseek/sessions`,`${home}/.deepseek-harness/sessions`],opencode:[`${data||home+'/.local/share'}/opencode`],cursor:[`${config||home+'/.config'}/Cursor/User/globalStorage`,`${config||home+'/.config'}/Cursor/User/workspaceStorage`]};
      for(const source of localIds)result.push(await instance(source,(roots[source]||[]).map(unc),`WSL · ${distro}`,'wsl'));
    }
    return result;
  }catch{return [];}
}

export interface DiscoveryOptions extends LocalOptions {onSource?:(source:SourceAvailability)=>void;wakeWSL?:boolean;projectPath?:string;stableBefore?:number}
async function discoveryOptions(options:DiscoveryOptions):Promise<DiscoveryOptions> {
  if(options.home||options.environment)return options;
  const environment={...process.env};
  // A GUI launched from Explorer may have an older environment than the user's
  // saved application configuration. Read only these named path variables.
  if(process.platform==='win32')await Promise.allSettled(['CODEX_HOME','CLAUDE_CONFIG_DIR','ANTIGRAVITY_HOME','GEMINI_HOME','OPENCLAW_HOME','HERMES_HOME','DEEPSEEK_HOME','XDG_DATA_HOME','XDG_CONFIG_HOME'].map(async key=>{
    if(environment[key])return;
    const reply=await runCommand('reg.exe',['query','HKCU\\Environment','/v',key],{timeout:2000,maxBytes:6000});
    const value=reply.stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/m)?.[1]?.trim();
    if(value)environment[key]=value.replace(/%([^%]+)%/g,(original,name)=>environment[name]||environment[name.toUpperCase()]||original);
  }));
  const roots={...options.roots};
  if(!roots.opencode){const executable=await findExecutable('opencode');if(executable)try{
    const reply=await runCommand(executable,['debug','paths'],{timeout:4000,maxBytes:16000,env:{...toolEnvironment(),...Object.fromEntries(['XDG_DATA_HOME','XDG_CONFIG_HOME'].filter(key=>environment[key]).map(key=>[key,environment[key]]))}});
    let data:string|undefined;try{data=(JSON.parse(reply.stdout) as {data?:string}).data;}catch{data=reply.stdout.match(/^data\s*[:\t ]\s*(.+)$/m)?.[1]?.trim();}
    if(reply.code===0&&data&&path.isAbsolute(data))roots.opencode=[data];
  }catch{}}
  return {...options,environment,roots};
}
function localExecutableName(source:SourceId):string {
  if(source==='claude-code')return 'claude';
  if(source==='antigravity')return 'agy';
  if(source==='gemini-cli')return 'gemini';
  if(source==='deepseek-harness')return 'deepseek';
  return source;
}
export async function discoverLocalSources(options:DiscoveryOptions={}):Promise<SourceAvailability[]> {
  const effective=await discoveryOptions(options);const roots=localRoots(effective);const output:SourceAvailability[]=[];
  for(const source of localIds) {
    const native=await instance(source,options.projectPath&&source!=='codex'?[]:roots[source],process.platform==='win32'?'Windows':'本机','native',options.projectPath,options.stableBefore);
    const installed=!!await findExecutable(localExecutableName(source),options.home);
    const ready=native.state==='ready';const status:SourceAvailability={id:source,title:SOURCE_NAMES[source],kind:'local',available:ready,connected:ready,mode:source==='cursor'?'limited':'automatic',detail:ready?native.detail:installed?'已找到程序，暂未确认可读取的历史。 / App found, but no readable history confirmed.':native.detail,locations:roots[source],instances:[native],historyCount:native.historyCount,countExact:native.countExact,discoveryState:native.state,appInstalled:installed};
    output.push(status);options.onSource?.(status);
  }
  if(!options.home&&!options.projectPath)for(const extra of await wslInstances(!!options.wakeWSL)) {
    const source=output.find(item=>item.id===extra.source)!;source.instances!.push(extra);
    if(extra.state==='ready'){source.available=true;source.connected=true;source.historyCount=(source.historyCount||0)+extra.historyCount;source.countExact=!!source.countExact&&extra.countExact;source.discoveryState='ready';source.detail=`发现可用历史 · ${source.historyCount} 段候选 / Saved history found`;}options.onSource?.({...source});
  }
  return output;
}
