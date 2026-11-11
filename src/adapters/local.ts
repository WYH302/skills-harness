import { homedir } from 'node:os';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { SOURCE_NAMES, type SourceId, type SourceAvailability, type CollectionOptions, type CollectorEvent } from '../shared/types';
import { exists, inDateRange, jsonLines, safeFailure, walk } from './common';
import { logConversation, parseLogFiles, type LogSource } from './logs';
import { collectCursor, collectOpenCode } from './sqlite';

export interface LocalOptions {home?: string; roots?: Partial<Record<SourceId,string[]>>;environment?:NodeJS.ProcessEnv}
const LOCAL_IDS: SourceId[] = ['codex', 'claude-code', 'antigravity', 'gemini-cli', 'openclaw', 'hermes', 'deepseek-harness', 'cursor', 'opencode'];
const LOG_SOURCES = new Set<LogSource>(['codex', 'claude-code', 'antigravity', 'gemini-cli', 'openclaw', 'hermes', 'deepseek-harness']);
export function localRoots(options: LocalOptions = {}): Record<string,string[]> {
  const home = options.home || homedir();
  const explicitHome = !!options.home;
  const environment=options.environment||(!explicitHome?process.env:{});
  const codex = environment.CODEX_HOME || path.join(home,'.codex');
  const claude = environment.CLAUDE_CONFIG_DIR || path.join(home,'.claude');
  const antigravity = environment.ANTIGRAVITY_HOME || path.join(home,'.gemini','antigravity');
  const gemini = environment.GEMINI_HOME || path.join(home,'.gemini');
  const openclaw = environment.OPENCLAW_HOME || path.join(home,'.openclaw');
  const hermes = environment.HERMES_HOME || path.join(home,'.hermes');
  const deepseek = environment.DEEPSEEK_HOME || path.join(home,'.deepseek');
  const userData = process.platform === 'win32' ? environment.APPDATA || path.join(home,'AppData','Roaming') : process.platform === 'darwin' ? path.join(home,'Library','Application Support') : environment.XDG_CONFIG_HOME || path.join(home,'.config');
  const share = environment.XDG_DATA_HOME || path.join(home,'.local','share');
  return {
    codex: options.roots?.codex || [path.join(codex,'sessions'), path.join(codex,'archived_sessions')],
    'claude-code': options.roots?.['claude-code'] || [path.join(claude,'projects')],
    antigravity: options.roots?.antigravity || [path.join(antigravity,'brain')],
    'gemini-cli': options.roots?.['gemini-cli'] || [path.join(gemini,'tmp'), path.join(gemini,'sessions'), path.join(gemini,'chats')],
    openclaw: options.roots?.openclaw || [path.join(openclaw,'sessions'), path.join(openclaw,'agents'), path.join(openclaw,'logs')],
    hermes: options.roots?.hermes || [path.join(hermes,'sessions'), path.join(hermes,'trajectories'), path.join(hermes,'logs')],
    'deepseek-harness': options.roots?.['deepseek-harness'] || [path.join(deepseek,'sessions'), path.join(deepseek,'history'), path.join(home,'.deepseek-harness','sessions')],
    cursor: options.roots?.cursor || [path.join(userData,'Cursor','User','globalStorage'),path.join(userData,'Cursor','User','workspaceStorage')],
    opencode: options.roots?.opencode || [path.join(share,'opencode')]
  };
}
export async function detectLocalSources(options: LocalOptions = {}): Promise<SourceAvailability[]> {
  return (await import('./discovery')).discoverLocalSources(options);
}
const UUID = /[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}/i;
const SELF_WORKSPACE_NAME = path.basename(process.cwd()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SELF_GENERATED_RE = new RegExp(`(?:^|[\\\\/])(?:\\.skillopt-sleep|skillharbor-(?:generation|member)-|public-(?:transfer|membership)-verification|skills-harness|skillharbor${SELF_WORKSPACE_NAME ? '|' + SELF_WORKSPACE_NAME : ''})(?:[\\\\/]|$)`, 'i');
const sessionMetaCache = new Map<string,{size:number;mtimeMs:number;meta:{cwd?:string;subThread?:boolean;selfGenerated?:boolean}}>();
const parsedGroupCache = new Map<string,{sig:string;parsed:Awaited<ReturnType<typeof parseLogFiles>>}>();
export async function inspectSessionMeta(file:string,signal?:AbortSignal,statInfo?:{size:number;mtimeMs:number}):Promise<{cwd?:string;subThread?:boolean;selfGenerated?:boolean}> {
  const info=statInfo||await lstat(file).catch(()=>null);
  if(info){const cached=sessionMetaCache.get(file);if(cached&&cached.size===info.size&&cached.mtimeMs===info.mtimeMs)return cached.meta;}
  const remember=(meta:{cwd?:string;subThread?:boolean;selfGenerated?:boolean})=>{if(info){if(sessionMetaCache.size>=4096)sessionMetaCache.clear();sessionMetaCache.set(file,{size:info.size,mtimeMs:info.mtimeMs,meta});}return meta;};
  if(file.endsWith('.jsonl')) {
    let fh;
    try {
      const { open } = await import('node:fs/promises');
      fh = await open(file, 'r');
      const buf = Buffer.allocUnsafe(8192);
      const { bytesRead } = await fh.read(buf, 0, 8192, 0);
      if (bytesRead > 0) {
        const head = buf.subarray(0, bytesRead).toString('utf8');
        const nl = head.indexOf('\n');
        const firstLine = (nl >= 0 ? head.slice(0, nl) : head).trim();
        if (firstLine.startsWith('{') && firstLine.includes('"session_meta"')) {
          const parsed = JSON.parse(firstLine);
          if (parsed?.type === 'session_meta') {
            const payload = parsed.payload || {};
            const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
            const subThread = Boolean(payload.parent_thread_id || payload.source?.subagent);
            const selfGenerated = typeof cwd === 'string' && SELF_GENERATED_RE.test(cwd);
            return remember({ cwd, subThread, selfGenerated });
          }
        }
        if (file.includes('antigravity') && SELF_GENERATED_RE.test(head)) {
          return remember({ selfGenerated: true });
        }
      }
    } catch {} finally {
      await fh?.close().catch(() => {});
    }
  }
  let checked=0;
  for await(const line of jsonLines(file,signal)) {
    const value=line.value;
    if(value?.type==='session_meta') {
      const payload=value.payload||{};
      const cwd=typeof payload.cwd==='string'?payload.cwd:undefined;
      const subThread=Boolean(payload.parent_thread_id||payload.source?.subagent);
      const selfGenerated=typeof cwd==='string'&&SELF_GENERATED_RE.test(cwd);
      return remember({cwd,subThread,selfGenerated});
    }
    if(typeof value?.cwd==='string') {
      const cwd=value.cwd;
      const selfGenerated=SELF_GENERATED_RE.test(cwd);
      return remember({cwd,selfGenerated});
    }
    if(++checked>=16)break;
  }
  return remember({});
}
export async function matchesProject(file:string,projectPath:string,signal:AbortSignal):Promise<boolean> {
  const normalized=(value:string)=>{const resolved=path.resolve(value).replace(/[\\/]+$/,'');return process.platform==='win32'?resolved.toLowerCase():resolved;};
  let checked=0;
  for await(const line of jsonLines(file,signal)) {
    const value=line.value;const cwd=value?.type==='session_meta'?value.payload?.cwd:value?.cwd;
    if(typeof cwd==='string')return normalized(cwd)===normalized(projectPath);
    if(++checked>=16)break;
  }
  return false;
}
async function* collectLogs(source: LogSource, roots: string[], options: CollectionOptions): AsyncGenerator<CollectorEvent> {
  const groups = new Map<string, Map<string,{file:string;plain:boolean;size:number;mtimeMs:number}>>();
  const titles = new Map<string,string>();
  if (source === 'codex') {
    for (const parent of new Set(roots.map(root => path.dirname(root)))) {
      const index = path.join(parent,'session_index.jsonl');
      if (!await exists(index)) continue;
      try {
        for await (const line of jsonLines(index,options.signal)) {
          const record=line.value;
          if (record?.id && typeof record.thread_name === 'string') titles.set(String(record.id),record.thread_name);
        }
      } catch(error) {options.signal.throwIfAborted();yield {type:'warning',message:'Codex session titles could not be read; conversation contents will still be collected.'};}
    }
  }
  let discovered = 0;
  for (const root of roots) {
    try {
      for await (const file of walk(root, name => /\.jsonl(?:\.(?:gz|zst))?$/i.test(name), options.signal)) {
        const basename = path.basename(file);
        if (basename === 'transcript_full.jsonl') continue;
        // For a deliberately scoped run, inspect session metadata before reading
        // or importing other projects' messages. Missing metadata never broadens access.
        if(options.projectPath&&!await matchesProject(file,options.projectPath,options.signal))continue;
        if(!options.projectPath&&(source==='codex'||source==='antigravity')) {
          try {
            const info = await lstat(file);
            const cachedM=options.metaCache?.[file];
            const meta=cachedM&&cachedM.size===info.size&&cachedM.mtimeMs===info.mtimeMs?cachedM.meta:await inspectSessionMeta(file,options.signal,info);
            if(options.metaCache)options.metaCache[file]={size:info.size,mtimeMs:info.mtimeMs,meta};
            if(meta.subThread||meta.selfGenerated)continue;
          }catch{/* Corrupted files stay in groups so the parser emits a failed count. */}
        }
        // Codex may write several rollout pages with one session UUID. Claude
        // subagent logs remain separate sessions instead of being joined by folder.
        const id = (source === 'antigravity' ? file.match(UUID)?.[0] : undefined) || basename.match(UUID)?.[0] || basename.replace(/\.jsonl(?:\.(gz|zst))?$/, '');
        const info = await lstat(file);
        if(options.stableBefore&&info.mtimeMs>options.stableBefore)continue;
        const page = basename.replace(/\.(?:gz|zst)$/, '');
        if (!groups.has(id)) groups.set(id,new Map());
        const pages = groups.get(id)!;
        const previous = pages.get(page);
        const plain = file.endsWith('.jsonl');
        if (!previous || (plain && !previous.plain) || plain === previous.plain && info.size > previous.size) pages.set(page,{file,plain,size:info.size,mtimeMs:info.mtimeMs});
      }
    } catch (error) {
      options.signal.throwIfAborted();
      yield { type:'warning', message:safeFailure(error) };
      yield { type:'progress', failed:1 };
    }
  }
  discovered = groups.size;
  yield { type:'progress', discovered, detail:`Found ${discovered} saved sessions.` };
  let completed = 0;
  for (const [id, pages] of groups) {
    options.signal.throwIfAborted();
    const files = [...pages.values()].map(p => p.file).sort();
    try {
      const sig = [...pages.values()].sort((a,b)=>a.file.localeCompare(b.file)).map(p=>`${p.file}:${p.size}:${p.mtimeMs}`).join('|');
      if (options.isUnchangedSession?.(id, sig)) { yield {type:'progress',skipped:1}; completed++; if (completed % 25 === 0 || completed === discovered) yield {type:'checkpoint',cursor:JSON.stringify({lastId:id,completed,discovered})}; continue; }
      const cachedGroup = parsedGroupCache.get(`${source}:${id}`);
      const parsed = cachedGroup && cachedGroup.sig === sig ? structuredClone(cachedGroup.parsed) : await parseLogFiles(files,source,options.signal);
      if (!cachedGroup || cachedGroup.sig !== sig) { if (parsedGroupCache.size >= 1024) parsedGroupCache.clear(); parsedGroupCache.set(`${source}:${id}`, { sig, parsed: structuredClone(parsed) }); }
      parsed.title ??= titles.get(parsed.externalId || id);
      const conversation = logConversation(parsed,source,id,files[0]);
      if (!conversation.messages.length || !inDateRange(conversation,options)) {
        for (const warning of conversation.warnings) yield {type:'warning',message:warning};
        yield {type:'progress',skipped:1};
      }
      else { options.onSessionSignature?.(id, sig); if (conversation.externalId && conversation.externalId !== id) options.onSessionSignature?.(conversation.externalId, sig); yield { type:'conversation', conversation }; }
    } catch (error) {
      options.signal.throwIfAborted();
      yield { type:'warning',message:safeFailure(error) };
      yield { type:'progress',failed:1 };
    }
    completed++;
    if (completed % 25 === 0 || completed === discovered) yield {type:'checkpoint',cursor:JSON.stringify({lastId:id,completed,discovered})};
  }
}
export async function* collectLocal(source: SourceId, options: CollectionOptions): AsyncGenerator<CollectorEvent> {
  if (!LOCAL_IDS.includes(source)) throw new Error('Unsupported local source.');
  options.signal.throwIfAborted();
  const roots = localRoots(options)[source];
  if (!(await Promise.all(roots.map(exists))).some(Boolean)) {
    yield {type:'warning',message:'No supported local session store is available.'};
    return;
  }
  if (LOG_SOURCES.has(source as LogSource)) yield* collectLogs(source as LogSource,roots,options);
  else if (source === 'cursor') yield* collectCursor(roots,options);
  else yield* collectOpenCode(roots,options);
}
