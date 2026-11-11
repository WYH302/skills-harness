import { readFile, lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { SOURCE_IDS, type Conversation, type SourceId, type Message } from '../shared/types';
import { asTimestamp, digest, MAX_FILE_BYTES, message, textOf } from './common';
import { logConversation, parseLogFiles } from './logs';
import { resolveSource } from '../shared/catalog';

type Obj = Record<string, any>;
function sourceId(value: unknown, fallback: SourceId): SourceId { return resolveSource(value)||fallback; }
function normalizedRole(value: unknown): Message['role'] | undefined {
  if(typeof value==='string')value=value.toLowerCase().trim();
  if(value==='用户'||value==='人类')return 'user';
  if(['助手','助理','ai','doubao','qwen','kimi','copilot'].includes(String(value)))return 'assistant';
  if (value === 'human') return 'user';
  if (value === 'model' || value === 'bot') return 'assistant';
  if (value === 'developer') return 'system';
  return ['user','assistant','system','tool'].includes(String(value)) ? value as Message['role'] : undefined;
}
function canonical(row: Obj, source?: SourceId): Conversation | undefined {
  if (!Array.isArray(row.messages)) return undefined;
  const warnings = Array.isArray(row.warnings) ? row.warnings.filter((w:unknown) => typeof w === 'string') : [];
  const messages: Message[] = [];
  row.messages.forEach((m: Obj,i:number) => {
    const role = normalizedRole(m.role ?? m.sender ?? m.author?.role ?? m.author);
    if (!role) {warnings.push(`Message ${i+1} has an unknown role and was not imported.`);return;}
    const body = textOf(m.text ?? m.content ?? m.parts);
    if (!body) return;
    const parsed = message(role,body,m.timestamp ?? m.created_at,m.id ?? m.uuid ?? `msg-${i}`,m.toolName ?? m.name);
    if(Array.isArray(m.artifactRefs))parsed.artifactRefs=m.artifactRefs.filter((s:unknown)=>typeof s==='string');
    messages.push(parsed);
  });
  if(!messages.length)return;
  return {source:source || sourceId(row.source,'chatgpt'),externalId:String(row.externalId ?? row.id ?? row.uuid ?? digest(JSON.stringify(row))),
    title:String(row.title ?? row.name ?? 'Imported conversation'),createdAt:asTimestamp(row.createdAt ?? row.create_time ?? row.created_at),updatedAt:asTimestamp(row.updatedAt ?? row.update_time ?? row.updated_at),
    ...(typeof row.url==='string'?{url:row.url}:{}),messages,completeness:['full','partial','unknown'].includes(row.completeness)?row.completeness: 'unknown',warnings};
}
function chatGPT(row:Obj):Conversation|undefined {
  if(!row.mapping || typeof row.mapping!=='object')return;
  const mapping:Record<string,Obj>=row.mapping;
  const pathRows:Obj[]=[],seen=new Set<string>();
  let nodeId:string|undefined=row.current_node;
  if(!nodeId) {
    const leaves=Object.entries(mapping).filter(([,n])=>!n.children?.length);
    leaves.sort((a,b)=>(b[1].message?.create_time||0)-(a[1].message?.create_time||0));
    nodeId=leaves[0]?.[0];
  }
  while(nodeId && mapping[nodeId] && !seen.has(nodeId)) {
    seen.add(nodeId);pathRows.unshift(mapping[nodeId]);nodeId=mapping[nodeId].parent;
  }
  const messages:Message[]=[];
  for(const node of pathRows) {
    const m=node.message;
    if(!m)continue;
    const role=normalizedRole(m.author?.role);
    const body=textOf(m.content);
    if(!role || !body)continue;
    messages.push(message(role,body,m.create_time,m.id ?? node.id,m.author?.name));
  }
  if(!messages.length)return;
  const warnings:string[]=[];
  const alternate=Object.values(mapping).some(n=>n.message && !pathRows.includes(n));
  if(alternate)warnings.push('Imported the current conversation branch. Alternative answer branches remain in the original provider export.');
  const id=String(row.conversation_id ?? row.id ?? digest(JSON.stringify(row.mapping)));
  return {source:'chatgpt',externalId:id,title:String(row.title||'ChatGPT conversation'),createdAt:asTimestamp(row.create_time),updatedAt:asTimestamp(row.update_time),
    url:`https://chatgpt.com/c/${encodeURIComponent(id)}`,messages,completeness:alternate?'partial':'full',warnings};
}
function claude(row:Obj):Conversation|undefined {
  if(!Array.isArray(row.chat_messages))return;
  const messages:Message[]=[];
  for(const [i,m]of row.chat_messages.entries()) {
    const role=normalizedRole(m.sender ?? m.role);
    if(!role)continue;
    const body=typeof m.text==='string' && m.text ? m.text:textOf(m.content);
    if(body)messages.push(message(role,body,m.created_at,m.uuid ?? m.id ?? `msg-${i}`));
  }
  if(!messages.length)return;
  const id=String(row.uuid ?? row.id ?? digest(JSON.stringify(row)));
  return {source:'claude',externalId:id,title:String(row.name||row.title||'Claude conversation'),createdAt:asTimestamp(row.created_at),updatedAt:asTimestamp(row.updated_at),
    url:`https://claude.ai/chat/${encodeURIComponent(id)}`,messages,completeness:'full',warnings:[]};
}
function gemini(row:Obj):Conversation|undefined {
  const body=row.turns ?? row.history;
  if(!Array.isArray(body))return;
  const messages:Message[]=[];
  for(const [i,m]of body.entries()) {
    const role=normalizedRole(m.role ?? m.author);
    const text=textOf(m.text ?? m.parts ?? m.content);
    if(role && text)messages.push(message(role,text,m.timestamp,m.id ?? `turn-${i}`));
  }
  if(!messages.length)return;
  return {source:'gemini',externalId:String(row.id ?? digest(JSON.stringify(row))),title:String(row.title||'Gemini import'),messages,completeness:'unknown',warnings:['Export does not provide an independently verifiable full-history marker.']};
}
export function parseHistoryJSON(data:unknown,source?:SourceId):Conversation[] {
  const output:Conversation[]=[];
  const rows=Array.isArray(data)?data: data && typeof data==='object' ? (data as Obj).conversations ?? (data as Obj).chats ?? [data] : [];
  if(!Array.isArray(rows))throw new Error('Unrecognized conversation export format.');
  for(const row of rows) {
    if(!row || typeof row!=='object')continue;
    const parsed=chatGPT(row) ?? claude(row) ?? canonical(row,source) ?? gemini(row);
    if(parsed) {if(source)parsed.source=source;output.push(parsed);}
  }
  return output;
}
function decodeHTML(input:string):string {
  return input.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi,entity=>{
    const named:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};
    if(named[entity.toLowerCase()])return named[entity.toLowerCase()];
    const n=entity.toLowerCase().startsWith('&#x')?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);
    return Number.isFinite(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):entity;
  });
}
function stripHTML(input:string):string {
  return decodeHTML(input.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,'')
    .replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:p|div|li|tr|h[1-6])>/gi,'\n').replace(/<[^>]+>/g,''))
    .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function parseHistoryText(content:string,filename:string,source?:SourceId):Conversation[] {
  const html=/\.html?$/i.test(filename), fallbackSource=source || 'gemini';
  if(/\.xml$/i.test(filename)) {
    const messages:Message[]=[];
    for(const [i,match]of [...content.matchAll(/<message\b([^>]*)>([\s\S]*?)<\/message\s*>/gi)].entries()) {
      const role=normalizedRole(/\b(?:role|sender|speaker)\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1]);
      const timestamp=/\b(?:timestamp|created_at)\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
      const body=stripHTML(match[2]);
      if(role && body)messages.push(message(role,body,timestamp,`xml-${i}`));
    }
    if(messages.length)return [{source:source||'chatgpt',externalId:`xml-${digest(content)}`,title:path.basename(filename),messages,completeness:'partial',warnings:['Imported role-labelled XML. Provider pagination, branches and omitted records cannot be verified.']}];
  }
  if(html && /outer-cell/.test(content) && /(?:Gemini|Bard|Prompted|提问)/i.test(content)) {
    const cards=content.split(/<div\b[^>]*class=["'][^"']*\bouter-cell\b[^"']*["'][^>]*>/i).slice(1);
    const result:Conversation[]=[];
    for(const [i,card]of cards.entries()) {
      const plain=stripHTML(card), marker=/(?:Prompted|提问|已提问)\s*([\s\S]+)/i.exec(plain);
      if(!marker)continue;
      // Takeout HTML is an activity record, not a stable conversation API.
      // Keep its body intact and avoid inventing assistant/user boundaries.
      const text=marker[1].trim();
      if(!text)continue;
      result.push({source:fallbackSource,externalId:`takeout-${digest(text)}`,title:text.split('\n')[0].slice(0,160),messages:[message('user',text,undefined,`activity-${i}`)],completeness:'partial',
        warnings:['Google Takeout activity HTML preserves activity text, but does not reliably identify full conversation boundaries, assistant replies, or original timestamps. Use browser collection for structured conversations.']});
    }
    if(result.length)return result;
  }
  const text=html?stripHTML(content):content;
  const messages:Message[]=[];
  // Known readable exports use role headings. Unlabelled text is retained as
  // context and cannot be treated as an established successful procedure.
  const regex=/^(?:#{1,6}\s*)?(User|Human|Assistant|Claude|ChatGPT|Gemini|Antigravity|OpenClaw|Hermes|DeepSeek|Doubao|Qwen|Kimi|Copilot|Meta AI|Grok|Perplexity|System|Tool|用户|助手|人类|豆包|千问|通义千问|腾讯元宝)\s*[:：]?\s*$/gim;
  const matches=[...text.matchAll(regex)];
  for(let i=0;i<matches.length;i++) {
    const m=matches[i],body=text.slice(m.index!+m[0].length,matches[i+1]?.index ?? text.length).trim();
    const tag=m[1].toLowerCase(),role:Message['role']=/user|human|用户|人类/.test(tag)?'user':/system/.test(tag)?'system':/tool/.test(tag)?'tool':'assistant';
    if(body)messages.push(message(role,body,undefined,`import-${i}`));
  }
  if(!messages.length && text.trim())messages.push(message('system',text.trim(),undefined,'import-context'));
  if(!messages.length)return [];
  return [{source:source||'chatgpt',externalId:`text-${digest(text)}`,title:path.basename(filename),messages,completeness:'partial',warnings:['Imported a readable text capture. Missing original identifiers, timestamps, pagination and role boundaries cannot be reconstructed.']}];
}
function parseEntry(bytes:Uint8Array,name:string,source?:SourceId):Conversation[] {
  const text=new TextDecoder('utf-8',{fatal:false}).decode(bytes).replace(/^\uFEFF/,'');
  if(/\.json$/i.test(name))return parseHistoryJSON(JSON.parse(text),source);
  if(/\.jsonl$/i.test(name)) {
    const rows=text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line));
    return rows.flatMap(row=>parseHistoryJSON(row,source));
  }
  return parseHistoryText(text,name,source);
}
export async function* importHistory(filePath:string,source?:SourceId):AsyncGenerator<Conversation> {
  const info=await lstat(filePath);
  if(info.isSymbolicLink() || !info.isFile() || info.size>MAX_FILE_BYTES)throw new Error('Import must be a regular file no larger than 512 MiB.');
  const filename=path.basename(filePath);
  if(/\.jsonl(?:\.(?:gz|zst))?$/i.test(filename)) {
    let first='';
    if(filePath.endsWith('.jsonl')) {
      const input=await open(filePath,'r');
      try{const buffer=Buffer.alloc(2048);const {bytesRead}=await input.read(buffer,0,buffer.length,0);first=buffer.subarray(0,bytesRead).toString('utf8');}finally{await input.close();}
    }
    const logSource=source==='claude-code'?'claude-code':source==='codex'?'codex':source==='antigravity'?'antigravity':source==='gemini-cli'?'gemini-cli':source==='openclaw'?'openclaw':source==='hermes'?'hermes':source==='deepseek-harness'?'deepseek-harness':/"USER_INPUT"|"PLANNER_RESPONSE"/.test(first)?'antigravity':/"session_meta"|"response_item"|"event_msg"/.test(first)?'codex':/"sessionId"|"type"\s*:\s*"assistant"/.test(first)?'claude-code':undefined;
    if(logSource || /\.(?:gz|zst)$/.test(filename)) {
      const chosen=logSource || 'codex';
      const parsed=await parseLogFiles([filePath],chosen);
      if(!parsed.messages.length)throw new Error('No supported message records were found in the session log.');
      yield logConversation(parsed,chosen,path.basename(filename).replace(/\.jsonl.*$/,''),filePath);return;
    }
  }
  const bytes=await readFile(filePath);
  let found=0;
  if(/\.zip$/i.test(filename)) {
    let expanded=0;
    const archive=unzipSync(bytes,{filter:entry=>{
      const name=entry.name.replace(/\\/g,'/');
      if(name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..'))throw new Error('Archive contains an unsafe entry path.');
      if(!/\.(json|jsonl|html?|xml|md|txt)$/i.test(name) || /(?:^|\/)(?:account|user|settings|profile|auth|credentials)[^/]*\.json$/i.test(name))return false;
      expanded+=entry.originalSize;
      if(entry.originalSize>256*1024*1024 || expanded>MAX_FILE_BYTES)throw new Error('Expanded archive exceeds the 512 MiB import limit.');
      return true;
    }});
    const entries=Object.entries(archive);
    const known=entries.filter(([name])=>/(?:^|\/)conversations\.json$/i.test(name));
    // A provider's conversation JSON is authoritative; also parsing its HTML
    // mirror would manufacture a second independent copy of the same history.
    for(const [name,body]of known.length?known:entries) {
      let parsed:Conversation[];
      try {parsed=parseEntry(body,name,source);}catch{continue;}
      for(const conversation of parsed){found++;yield {...conversation,collectedAt:new Date().toISOString(),locator:`${filePath}#${name}`};}
    }
  }else {
    if(!/\.(?:json|jsonl|html?|xml|md|txt)$/i.test(filename))throw new Error('Unsupported import format. Choose JSON, JSONL, ZIP, HTML, XML, Markdown or text.');
    for(const conversation of parseEntry(bytes,filename,source)){found++;yield {...conversation,collectedAt:new Date().toISOString(),locator:filePath};}
  }
  if(!found)throw new Error('No supported conversations were found. Choose a provider conversation export or a SkillHarbor canonical JSON file.');
}
