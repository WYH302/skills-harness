import path from 'node:path';
import { asTimestamp, digest, jsonLines, message, textOf } from './common';
import type { Conversation, Message, SourceId } from '../shared/types';

type Row = { value: Record<string, any>; line: number; page: string };
export type LogSource = 'codex' | 'claude-code' | 'antigravity' | 'gemini-cli' | 'openclaw' | 'hermes' | 'deepseek-harness';
export interface ParsedLog { externalId?: string; title?: string; createdAt?: string; messages: Message[]; warnings: string[] }
function cleanAntigravityUserText(raw: string): string {
  const withoutSummary = raw.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '').trim();
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(withoutSummary);
  return (match ? match[1] : withoutSummary).trim();
}
function antigravityRecord(row: Row): Message[] {
  const e = row.value;
  const time = e.created_at ?? e.timestamp;
  const base = e.id ?? (typeof e.step_index === 'number' ? `step-${e.step_index}` : digest(`${row.page}:${row.line}`));
  if (e.type === 'USER_INPUT' || e.source === 'USER_EXPLICIT') {
    const body = cleanAntigravityUserText(textOf(e.content ?? e.text ?? e.message));
    return body ? [message('user', body, time, base)] : [];
  }
  if (e.type === 'PLANNER_RESPONSE' || e.source === 'MODEL') {
    const out: Message[] = [];
    const body = textOf(e.content ?? e.text ?? e.message);
    if (body) out.push(message('assistant', body, time, `${base}-text`));
    if (Array.isArray(e.tool_calls)) {
      for (let i = 0; i < e.tool_calls.length; i++) {
        const tc = e.tool_calls[i];
        const name = tc?.name ?? tc?.tool_name ?? tc?.function?.name ?? 'tool';
        const args = textOf(tc?.arguments ?? tc?.args ?? tc?.input ?? tc?.function?.arguments).slice(0, 2400);
        if (args || name) out.push(message('assistant', args || name, time, `${base}-tool-${i}`, name));
      }
    }
    return out;
  }
  return [];
}
function genericHarnessRecord(row: Row): { primary: Message[]; fallback: Message[] } {
  const e = row.value;
  if (e.type === 'USER_INPUT' || e.type === 'PLANNER_RESPONSE' || e.source === 'USER_EXPLICIT' || e.source === 'MODEL') {
    return { primary: antigravityRecord(row), fallback: [] };
  }
  if (e.message && typeof e.message === 'object') {
    return { primary: claudeRecord(row), fallback: [] };
  }
  if (Array.isArray(e.messages) || Array.isArray(e.turns) || Array.isArray(e.history)) {
    const list = (e.messages ?? e.turns ?? e.history) as Record<string, any>[];
    const primary: Message[] = [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || typeof m !== 'object') continue;
      const rawRole = String(m.role ?? m.author ?? m.sender ?? '').toLowerCase();
      const role: Message['role'] | undefined = rawRole === 'user' || rawRole === 'human' ? 'user'
        : rawRole === 'assistant' || rawRole === 'model' || rawRole === 'bot' || rawRole === 'agent' ? 'assistant'
        : rawRole === 'tool' ? 'tool'
        : rawRole === 'system' || rawRole === 'developer' ? 'system' : undefined;
      const body = textOf(m.content ?? m.parts ?? m.text ?? m.message);
      if (role && body) primary.push(message(role, body, m.timestamp ?? m.created_at ?? e.timestamp, m.id ?? `${row.page}:${row.line}:${i}`, m.toolName ?? m.name));
    }
    return { primary, fallback: [] };
  }
  if (e.role === 'model' || Array.isArray(e.parts)) {
    const role: Message['role'] = e.role === 'user' || e.role === 'human' ? 'user' : 'assistant';
    const body = textOf(e.parts ?? e.content ?? e.text);
    return { primary: body ? [message(role, body, e.timestamp ?? e.created_at, e.id ?? digest(`${row.page}:${row.line}`))] : [], fallback: [] };
  }
  return codexRecord(row);
}
function codexRecord(row: Row): { primary: Message[]; fallback: Message[] } {
  const e = row.value, p = e.payload ?? e, t = p.type ?? e.type;
  const time = e.timestamp ?? p.timestamp;
  const stable = p.id ?? e.id;
  const primary: Message[] = [], fallback: Message[] = [];
  if (e.type === 'response_item' || (e.type === 'message' && e.role)) {
    const role = p.role;
    if (t === 'message' || role) {
      const body = textOf(p.content ?? p.text);
      if (body && ['user', 'assistant', 'system', 'tool', 'developer'].includes(role)) primary.push(message(role === 'developer' ? 'system' : role, body, time, stable));
    } else if (t === 'function_call' || t === 'custom_tool_call' || t === 'tool_call') {
      primary.push(message('assistant', textOf(p.arguments ?? p.input).slice(0, 2400), time, stable ?? p.call_id, p.name ?? 'tool'));
    } else if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'tool_result') {
      primary.push(message('tool', textOf(p.output ?? p.content).slice(0, 2400), time, stable ?? `${p.call_id || ''}-result`, p.name));
    }
  } else if (e.type === 'event_msg') {
    if (t === 'user_message' && typeof p.message === 'string') fallback.push(message('user', p.message, time, stable));
    if (t === 'agent_message' && typeof p.message === 'string') fallback.push(message('assistant', p.message, time, stable));
  } else if (e.role && e.content) {
    const body = textOf(e.content);
    if (body && ['user','assistant','system','tool'].includes(e.role)) primary.push(message(e.role, body, time, stable));
  }
  return { primary, fallback };
}
function claudeRecord(row: Row): Message[] {
  const e = row.value, m = e.message;
  if (!m || !['user','assistant','system','tool'].includes(m.role ?? e.type)) return [];
  const role: Message['role'] = m.role ?? e.type;
  const base = e.uuid ?? m.id ?? digest(`${row.page}:${row.line}`);
  const content = m.content;
  if (!Array.isArray(content)) {
    const text = textOf(content);
    return text ? [message(role, text, e.timestamp ?? m.timestamp, base)] : [];
  }
  const result: Message[] = [];
  let textParts: string[] = [], textIndex = 0;
  const flush = () => {
    if (textParts.length) result.push(message(role, textParts.join('\n'), e.timestamp, `${base}-text-${textIndex++}`));
    textParts = [];
  };
  for (let i=0; i<content.length; i++) {
    const part = content[i];
    if (part?.type === 'tool_use') {
      flush(); result.push(message('assistant', JSON.stringify(part.input ?? {}), e.timestamp, part.id ?? `${base}-tool-${i}`, part.name));
    } else if (part?.type === 'tool_result') {
      flush(); result.push(message('tool', textOf(part.content), e.timestamp, `${base}-result-${part.tool_use_id ?? i}`, part.tool_use_id));
    } else {
      const text = textOf([part]);
      if (text) textParts.push(text);
    }
  }
  flush();
  return result;
}
export async function parseLogFiles(files: string[], source: LogSource, signal?: AbortSignal): Promise<ParsedLog> {
  const primary: Message[] = [], fallback: Message[] = [], warnings: string[] = [];
  let externalId: string | undefined, title: string | undefined, createdAt: string | undefined;
  let malformed = 0;
  for (const file of files) {
    for await (const line of jsonLines(file, signal)) {
      if (line.malformed) { malformed++; continue; }
      const e = line.value!;
      if (e.type === 'session_meta') {
        externalId ??= e.payload?.id;
        createdAt ??= asTimestamp(e.payload?.timestamp ?? e.timestamp);
        title ??= e.payload?.title;
      }
      if (e.sessionId || e.conversation_id) externalId ??= String(e.sessionId ?? e.conversation_id);
      if (e.type === 'summary' && e.summary) title = String(e.summary);
      if (typeof e.title === 'string' && !title) title = e.title;
      if (e.type === 'compacted' || e.type === 'compact_boundary' || e.message?.content?.[0]?.text?.includes?.('This session is being continued from a previous conversation')) {
        if (!warnings.includes('Session contains compacted context; earlier original turns may no longer exist in this log.')) warnings.push('Session contains compacted context; earlier original turns may no longer exist in this log.');
      }
      if (source === 'codex') {
        const parsed = codexRecord({ value:e, line:line.line, page:path.basename(file) });
        primary.push(...parsed.primary); fallback.push(...parsed.fallback);
      } else if (source === 'claude-code') {
        primary.push(...claudeRecord({ value:e, line:line.line, page:path.basename(file) }));
      } else if (source === 'antigravity') {
        primary.push(...antigravityRecord({ value:e, line:line.line, page:path.basename(file) }));
      } else {
        const parsed = genericHarnessRecord({ value:e, line:line.line, page:path.basename(file) });
        primary.push(...parsed.primary); fallback.push(...parsed.fallback);
      }
    }
  }
  // event_msg mirrors response_item in current Codex logs. Use it only where a
  // matching primary record is absent; repeated genuine turns keep their time.
  for (const f of fallback) {
    const mirrored = primary.some(p => p.role === f.role && p.text === f.text && (!p.timestamp || !f.timestamp || Math.abs(Date.parse(p.timestamp)-Date.parse(f.timestamp)) < 5000));
    if (!mirrored) primary.push(f);
  }
  const seen = new Set<string>();
  const messages = primary.filter(m => {
    const key = `${m.id}\0${m.role}\0${m.text}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  messages.sort((a,b) => a.timestamp && b.timestamp ? a.timestamp.localeCompare(b.timestamp) : 0);
  const toolIndices = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role === 'tool' || !!m.toolName);
  let boundedMessages = messages;
  if (toolIndices.length > 40) {
    const keepTools = new Set<number>([
      ...toolIndices.slice(0, 8).map(x => x.i),
      ...toolIndices.slice(-16).map(x => x.i),
      ...toolIndices.filter(({ m }) => /(?:Error:|Traceback \(most recent|[✖❌]|FAILED\s|not ok\s)/.test(m.text)).slice(-16).map(x => x.i)
    ]);
    boundedMessages = messages.filter((m, i) => (m.role !== 'tool' && !m.toolName) || keepTools.has(i));
  }
  if (malformed) warnings.push(`${malformed} malformed or interrupted JSONL record(s) were skipped.`);
  return { externalId, title, createdAt, messages: boundedMessages, warnings };
}
export function logConversation(parsed: ParsedLog, source: SourceId, externalId: string, locator: string): Conversation {
  const times = parsed.messages.map(m => m.timestamp).filter((v): v is string => !!v).sort();
  const goal = parsed.messages.find(m => m.role === 'user')?.text;
  return { source, externalId: parsed.externalId || externalId, title: parsed.title || goal?.split('\n')[0].slice(0,160) || `${source} session`,
    createdAt: parsed.createdAt || times[0], updatedAt: times.at(-1), messages: parsed.messages,
    completeness: parsed.warnings.length ? 'partial' : 'full', warnings: parsed.warnings, collectedAt: new Date().toISOString(), locator };
}
