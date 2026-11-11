import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CommandResult {code:number;stdout:string;stderr:string}
export interface CommandOptions {cwd?:string;input?:string;timeout?:number;signal?:AbortSignal;maxBytes?:number;env?:NodeJS.ProcessEnv}
export function toolEnvironment():NodeJS.ProcessEnv {
  // Authentication stays inside the selected tool. Do not silently inherit
  // unrelated API keys, tokens, or developer-agent instructions from our host.
  const allowed=/^(?:PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|COMSPEC|LANG|LC_.*|CODEX_HOME|CLAUDE_CONFIG_DIR|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key,value])=>allowed.test(key)&&value!==undefined));
}
export function runCommand(executable:string,args:string[],options:CommandOptions={}):Promise<CommandResult> {
  return new Promise((resolve,reject)=>{
    let child:ReturnType<typeof spawn>;let stdout='',stderr='',bytes=0;let failed=false;
    const stop=(error:Error)=>{if(failed)return;failed=true;child?.kill();reject(error);};
    const timer=setTimeout(()=>stop(new Error('Command timed out / 工具响应超时')),options.timeout||10000);
    const abort=()=>stop(new DOMException('Cancelled','AbortError'));
    if(options.signal?.aborted){clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));return;}
    try {child=spawn(executable,args,{cwd:options.cwd,env:options.env||process.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});}
    catch(error){clearTimeout(timer);reject(error);return;}
    options.signal?.addEventListener('abort',abort,{once:true});
    child.stdout!.setEncoding('utf8');child.stderr!.setEncoding('utf8');
    const receive=(kind:'stdout'|'stderr',chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>(options.maxBytes||4_000_000)){stop(new Error('Tool output exceeded limit / 工具输出超过限制'));return;}if(kind==='stdout')stdout+=chunk;else stderr+=chunk;};
    child.stdout!.on('data',chunk=>receive('stdout',chunk));child.stderr!.on('data',chunk=>receive('stderr',chunk));
    child.once('error',error=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(!failed){failed=true;reject(error);}});
    child.once('close',code=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(!failed)resolve({code:code??-1,stdout,stderr});});
    child.stdin!.on('error',()=>{});child.stdin!.end(options.input||'');
  });
}

export async function findExecutable(name:string,home=homedir()):Promise<string|undefined> {
  const windows=process.platform==='win32';const ext=windows?'.exe':'';
  const directories=(process.env.PATH||'').split(path.delimiter).filter(Boolean);
  const candidates=[...directories.map(dir=>path.join(dir,name+ext)),path.join(home,'.local','bin',name+ext),path.join(home,'.cargo','bin',name+ext),path.join(home,'AppData','Local','Programs',name,name+ext)];
  // The Codex desktop app ships a CLI in versioned bin directories. Query only
  // this known application location, never recursively search a user's drives.
  if(windows&&name==='codex') {
    const parent=path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'OpenAI','Codex','bin');
    try {const entries=await readdir(parent,{withFileTypes:true});for(const entry of entries.filter(e=>e.isDirectory()).reverse())candidates.push(path.join(parent,entry.name,'codex.exe'));}catch{}
  }
  if(windows&&name==='claude')candidates.push(path.join(home,'.local','bin','claude.exe'));
  return candidates.find(candidate=>existsSync(candidate));
}
export async function findNodeTool(name:string,home=homedir()):Promise<{executable:string;prefix:string[]}|undefined>{
  const direct=await findExecutable(name,home);if(direct)return {executable:direct,prefix:[]};
  if(name==='gemini'){
    const directories=[...(process.env.PATH||'').split(path.delimiter),path.join(home,'AppData','Roaming','npm')];
    const node=await findExecutable('node',home);if(!node)return;
    for(const directory of directories){const entry=path.join(directory,'node_modules','@google','gemini-cli','dist','index.js');if(existsSync(entry))return {executable:node,prefix:[entry]};}
  }
  if(process.platform==='win32'&&!['gemini','agent','cursor-agent'].includes(name)){
    const directories=[...(process.env.PATH||'').split(path.delimiter).filter(Boolean),path.join(home,'AppData','Local','pnpm'),path.join(home,'AppData','Roaming','npm')];
    for(const directory of directories){
      for(const ext of ['.cmd','.bat']){
        const script=path.join(directory,name+ext);
        if(existsSync(script))return {executable:process.env.COMSPEC||'cmd.exe',prefix:['/d','/s','/c',script]};
      }
    }
  }
}
