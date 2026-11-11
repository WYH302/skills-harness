import { DatabaseSync } from 'node:sqlite';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { asTimestamp, digest, inDateRange, MAX_FILE_BYTES, message, safeFailure, textOf, walk } from './common';
import type { CollectorEvent, CollectionOptions, Conversation, Message } from '../shared/types';

type AnyObject = Record<string, any>;
const tables = (db: DatabaseSync) => new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name)));
function parseObject(raw: unknown): any {
  if (raw instanceof Uint8Array) raw = Buffer.from(raw).toString('utf8');
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return undefined; } }
  return raw && typeof raw === 'object' ? raw : undefined;
}
async function readJSON(file: string): Promise<any> {
  const s = await lstat(file);
  if (s.isSymbolicLink() || s.size > MAX_FILE_BYTES) throw new Error('Session JSON exceeds the supported input limit.');
  return JSON.parse(await readFile(file,'utf8'));
}
export function cursorMessages(composer: AnyObject, bubbles: Map<string,AnyObject> = new Map()): Message[] {
  const list = composer.fullConversation ?? composer.conversation ?? composer.messages ?? composer.chatMessages ?? composer.bubbles ?? composer.fullConversationHeadersOnly ?? composer.conversationMap ?? [];
  const entries: AnyObject[] = Array.isArray(list) ? list : Object.values(list);
  const out: Message[] = [];
  for (let i=0;i<entries.length;i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== 'object') continue;
    const bubble = bubbles.get(String(entry.bubbleId ?? entry.id)) ?? entry;
    const role: Message['role'] | undefined = bubble.role === 'user' || bubble.type === 1 ? 'user' : bubble.role === 'assistant' || bubble.type === 2 ? 'assistant' : bubble.role === 'tool' ? 'tool' : bubble.role === 'system' ? 'system' : undefined;
    if (!role) continue;
    const text = textOf(bubble.text ?? bubble.content ?? bubble.message ?? bubble.rawText);
    if (text) out.push(message(role,text,bubble.createdAt ?? bubble.timestamp, bubble.bubbleId ?? bubble.id ?? `bubble-${i}`));
    for (const [j,tool] of (bubble.toolResults ?? bubble.toolCalls ?? []).entries()) {
      if (!tool || typeof tool !== 'object') continue;
      out.push(message('tool',textOf(tool.result ?? tool.output ?? tool),bubble.createdAt,`${bubble.bubbleId || i}-tool-${j}`,tool.name));
    }
  }
  return out;
}
function cursorConversation(id: string, data: AnyObject, bubbles: Map<string,AnyObject>, file:string): Conversation {
  const messages = cursorMessages(data,bubbles);
  return { source:'cursor',externalId:id,title:String(data.name ?? data.title ?? messages.find(m => m.role === 'user')?.text.slice(0,160) ?? 'Cursor session'),
    createdAt:asTimestamp(data.createdAt ?? data.created_at),updatedAt:asTimestamp(data.lastUpdatedAt ?? data.updatedAt),messages,
    completeness:'partial',warnings:['Cursor local storage has no stable public schema; retained bubbles were read, but cloud-only turns and attachments are not verified.'],locator:file,collectedAt:new Date().toISOString() };
}
export async function* collectCursor(roots: string[], options: CollectionOptions): AsyncGenerator<CollectorEvent> {
  const files: string[] = [];
  for (const root of roots) {
    try { for await (const file of walk(root,f => /(?:^|[\\/])state\.vscdb$/.test(f),options.signal)) files.push(file); }
    catch(error) { options.signal.throwIfAborted(); yield {type:'warning',message:safeFailure(error)}; yield {type:'progress',failed:1}; }
  }
  const emitted = new Set<string>();
  let discovered = 0;
  for (const file of files) {
    options.signal.throwIfAborted();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file,{readOnly:true});
      const availableTables = tables(db);
      const composers = new Map<string,AnyObject>();
      const bubblesByComposer = new Map<string,Map<string,AnyObject>>();
      const metadata = new Map<string,AnyObject>();
      if (availableTables.has('cursorDiskKV')) {
        for (const row of db.prepare("SELECT key,value FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'").all()) {
          options.signal.throwIfAborted();
          const key = String(row.key), value = parseObject(row.value);
          if (!value) continue;
          if (key.startsWith('composerData:')) composers.set(key.slice('composerData:'.length),value);
          else {
            const match = /^bubbleId:([^:]+):(.+)$/.exec(key);
            if (match) {
              if (!bubblesByComposer.has(match[1])) bubblesByComposer.set(match[1],new Map());
              bubblesByComposer.get(match[1])!.set(match[2],value);
            }
          }
        }
      }
      if (availableTables.has('ItemTable')) {
        for (const row of db.prepare("SELECT key,value FROM ItemTable WHERE key = 'composer.composerData' OR key = 'workbench.panel.aichat.view.aichat.chatdata'").all()) {
          const value = parseObject(row.value);
          if (!value) continue;
          if (String(row.key) === 'composer.composerData') {
            for (const comp of value.allComposers ?? value.composers ?? (Array.isArray(value) ? value : [])) {
              const id = String(comp.composerId ?? comp.id ?? '');
              if (!id) continue;
              metadata.set(id,comp);
              if (!composers.has(id) && (comp.conversation || comp.messages || comp.fullConversation)) composers.set(id,comp);
            }
          } else {
            for (const chat of value.tabs ?? value.chats ?? (Array.isArray(value) ? value : [])) {
              const id = String(chat.id ?? chat.tabId ?? digest(JSON.stringify(chat)));
              composers.set(id,{...chat,conversation:chat.bubbles ?? chat.messages ?? chat.conversation});
            }
          }
        }
      }
      for (const [id,bubbles] of bubblesByComposer) if (!composers.has(id)) composers.set(id,{conversation:[...bubbles.keys()].map(bubbleId => ({bubbleId}))});
      for (const [id,body] of composers) {
        if (emitted.has(id)) continue;
        const conversation = cursorConversation(id,{...metadata.get(id),...body},bubblesByComposer.get(id) ?? new Map(),file);
        if (!conversation.messages.length) continue;
        emitted.add(id); discovered++;
        yield {type:'progress',discovered:1};
        if (inDateRange(conversation,options)) yield {type:'conversation',conversation};
        else yield {type:'progress',skipped:1};
      }
      yield {type:'checkpoint',cursor:JSON.stringify({database:digest(file),discovered})};
    } catch(error) { options.signal.throwIfAborted(); yield {type:'warning',message:safeFailure(error)}; yield {type:'progress',failed:1}; }
    finally {db?.close();}
  }
  if (!discovered) yield {type:'warning',message:'No readable Cursor conversations were found in supported local database keys. Cloud-only sessions and changed storage schemas require a provider export.'};
}
function openCodeMessages(records: AnyObject[], parts: Map<string,AnyObject[]>): Message[] {
  const output: Message[] = [];
  for (const record of records) {
    const body = parseObject(record.data) ?? record;
    const role = body.role;
    if (!['user','assistant','system','tool'].includes(role)) continue;
    const id = String(record.id ?? body.id ?? digest(JSON.stringify(body)));
    const timestamp = body.time?.created ?? record.time_created ?? body.createdAt;
    const messageParts = parts.get(id) ?? body.parts ?? [];
    let text = '';
    for (let i=0;i<messageParts.length;i++) {
      const part = parseObject(messageParts[i].data) ?? messageParts[i];
      if (part.type === 'tool') {
        if (text) { output.push(message(role,text,timestamp,`${id}-text-${i}`)); text=''; }
        output.push(message('assistant',JSON.stringify(part.state?.input ?? part.input ?? {}),timestamp,`${id}-tool-${i}`,part.tool));
        if (part.state?.output ?? part.output) output.push(message('tool',textOf(part.state?.output ?? part.output),timestamp,`${id}-output-${i}`,part.tool));
      } else if (part.type === 'text' || part.type === 'reasoning') {
        // Keep reasoning as a separate system context rather than the user's goal.
        if (part.type === 'reasoning') continue;
        const value = textOf(part.text ?? part.content);
        if (value) text += `${text ? '\n' : ''}${value}`;
      } else if (part.type === 'file') text += `${text ? '\n' : ''}[File attachment: ${String(part.filename || part.mime || 'file')}]`;
    }
    if (!text && !messageParts.length) text = textOf(body.content ?? body.text);
    if (text) output.push(message(role,text,timestamp,id));
  }
  return output;
}
function openConversation(session: AnyObject, records: AnyObject[], parts: Map<string,AnyObject[]>, locator:string): Conversation {
  return {source:'opencode',externalId:String(session.id),title:String(session.title || 'OpenCode session'),
    createdAt:asTimestamp(session.time_created ?? session.time?.created),updatedAt:asTimestamp(session.time_updated ?? session.time?.updated),
    messages:openCodeMessages(records,parts),completeness:'full',warnings:[],locator,collectedAt:new Date().toISOString()};
}
export async function* collectOpenCode(roots:string[],options:CollectionOptions): AsyncGenerator<CollectorEvent> {
  const known = new Set<string>();
  let anyDatabase = false;
  for (const root of roots) {
    const dbFiles:string[] = [];
    try { for await (const file of walk(root,f => path.basename(f) === 'opencode.db',options.signal)) dbFiles.push(file); }
    catch(error) { options.signal.throwIfAborted(); yield {type:'warning',message:safeFailure(error)}; yield {type:'progress',failed:1}; }
    for (const file of dbFiles) {
      anyDatabase = true;
      let db:DatabaseSync|undefined;
      try {
        db = new DatabaseSync(file,{readOnly:true});
        const names = tables(db);
        if (!names.has('session') || !names.has('message')) throw new Error('OpenCode database schema is unsupported.');
        const sessions = db.prepare('SELECT * FROM session ORDER BY time_updated').all() as AnyObject[];
        yield {type:'progress',discovered:sessions.length};
        const messageQuery = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created');
        const partQuery = names.has('part') ? db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY time_created') : null;
        for (const session of sessions) {
          options.signal.throwIfAborted();
          if (known.has(String(session.id))) {yield {type:'progress',skipped:1};continue;}
          const records = messageQuery.all(String(session.id)) as AnyObject[];
          const parts = new Map<string,AnyObject[]>();
          for (const record of records) parts.set(String(record.id),partQuery?.all(String(record.id)) as AnyObject[] ?? []);
          const conversation = openConversation(session,records,parts,file);
          if (!names.has('part')) { conversation.completeness='partial';conversation.warnings.push('The OpenCode part table is missing; only embedded message bodies are available.'); }
          known.add(String(session.id));
          if (conversation.messages.length && inDateRange(conversation,options)) yield {type:'conversation',conversation};
          else yield {type:'progress',skipped:1};
          yield {type:'checkpoint',cursor:JSON.stringify({sessionId:session.id})};
        }
      } catch(error) {options.signal.throwIfAborted();yield {type:'warning',message:safeFailure(error)};yield {type:'progress',failed:1};}
      finally {db?.close();}
    }
    // Pre-SQLite OpenCode stores: storage/session/<project>/<id>.json,
    // storage/message/<session>/<id>.json and storage/part/<message>/<id>.json.
    const storage = path.join(root,'storage');
    const sessions:string[] = [], messages = new Map<string,string[]>(), partFiles = new Map<string,string[]>();
    try {
      for await (const file of walk(path.join(storage,'session'),f => f.endsWith('.json'),options.signal)) sessions.push(file);
      for await (const file of walk(path.join(storage,'message'),f => f.endsWith('.json'),options.signal)) {const id=path.basename(path.dirname(file)); messages.set(id,[...(messages.get(id)||[]),file]);}
      for await (const file of walk(path.join(storage,'part'),f => f.endsWith('.json'),options.signal)) {const id=path.basename(path.dirname(file)); partFiles.set(id,[...(partFiles.get(id)||[]),file]);}
    } catch(error) { options.signal.throwIfAborted();yield {type:'warning',message:safeFailure(error)};yield {type:'progress',failed:1}; }
    yield {type:'progress',discovered:sessions.length};
    for (const file of sessions) {
      options.signal.throwIfAborted();
      try {
        const session=await readJSON(file), id=String(session.id ?? path.basename(file,'.json'));
        if (known.has(id)) {yield {type:'progress',skipped:1};continue;}
        const records:AnyObject[] = [], parts=new Map<string,AnyObject[]>();
        for(const filename of messages.get(id)||[]) {const record=await readJSON(filename); records.push(record); const list:AnyObject[]=[];for(const partFile of partFiles.get(String(record.id))||[]) list.push(await readJSON(partFile));parts.set(String(record.id),list);}
        records.sort((a,b) => (a.time?.created || 0)-(b.time?.created || 0));
        const conversation=openConversation({...session,id},records,parts,file);
        known.add(id);
        if(conversation.messages.length && inDateRange(conversation,options))yield {type:'conversation',conversation};else yield {type:'progress',skipped:1};
      }catch(error){options.signal.throwIfAborted();yield {type:'warning',message:safeFailure(error)};yield {type:'progress',failed:1};}
    }
  }
  if(!known.size && !anyDatabase)yield {type:'warning',message:'No supported OpenCode database or legacy JSON sessions were found.'};
}
