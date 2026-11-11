import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import path from 'node:path';
import type { Message, Conversation, CollectionOptions } from '../shared/types';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export function asTimestamp(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const date = new Date(typeof value === 'number' ? value < 100_000_000_000 ? value * 1000 : value : String(value));
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(part => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const p = part as Record<string, unknown>;
    if (typeof p.text === 'string') return p.text;
    if (p.type === 'tool_result') return textOf(p.content);
    if (p.type === 'tool_use') return `${String(p.name || 'tool')}\n${JSON.stringify(p.input ?? {})}`;
    if (p.type === 'image' || p.type === 'input_image' || p.type === 'image_asset_pointer') return '[Image attachment]';
    return typeof p.content === 'string' ? p.content : '';
  }).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (v.parts) return textOf(v.parts);
    if (v.content) return textOf(v.content);
    return JSON.stringify(value);
  }
  return String(value);
}
export function message(role: Message['role'], text: string, timestamp?: unknown, id?: unknown, toolName?: string): Message {
  const time = asTimestamp(timestamp);
  return { id: typeof id === 'string' && id ? id : digest(`${role}\0${time || ''}\0${text}`), role, text,
    ...(time ? { timestamp: time } : {}), ...(toolName ? { toolName } : {}) };
}
export function inDateRange(conversation: Conversation, options: Pick<CollectionOptions, 'dateFrom' | 'dateTo'>): boolean {
  const start = options.dateFrom ? new Date(options.dateFrom).valueOf() : -Infinity;
  const end = options.dateTo ? new Date(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59.999Z` : options.dateTo).valueOf() : Infinity;
  let minimum = Infinity, maximum = -Infinity;
  for (const value of [conversation.createdAt, conversation.updatedAt, ...conversation.messages.map(m => m.timestamp)]) {
    if (!value) continue;
    const time = new Date(value).valueOf();
    if (!Number.isFinite(time)) continue;
    minimum = Math.min(minimum,time); maximum = Math.max(maximum,time);
  }
  // Unknown dates are retained, with an explicit warning, instead of silently dropped.
  if (minimum === Infinity && (options.dateFrom || options.dateTo)) {
    conversation.warnings.push('Original timestamps are unavailable; date-range membership could not be verified.');
    conversation.completeness = 'partial';
    return true;
  }
  return minimum === Infinity || (maximum >= start && minimum <= end);
}
export async function exists(file: string): Promise<boolean> {
  try { const s = await lstat(file); return !s.isSymbolicLink(); } catch { return false; }
}
export async function* walk(root: string, accept: (filename: string) => boolean, signal?: AbortSignal, depth = 0): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if (depth > 20) throw new Error('Session directory depth exceeded the supported limit.');
  let rootInfo;
  try { rootInfo = await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (rootInfo.isSymbolicLink()) return;
  if (rootInfo.isFile()) { if (accept(root)) yield root; return; }
  for (const item of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (item.isSymbolicLink()) continue;
    const full = path.join(root, item.name);
    if (item.isDirectory()) yield* walk(full, accept, signal, depth + 1);
    else if (item.isFile() && accept(full)) yield full;
  }
}
export interface LineResult { value?: Record<string, any>; malformed?: boolean; line: number }
export async function* jsonLines(filename: string, signal?: AbortSignal): AsyncGenerator<LineResult> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('Session is a symlink or exceeds the 512 MiB input limit.');
  const raw = createReadStream(filename);
  const stream = filename.endsWith('.gz') ? raw.pipe(createGunzip()) : filename.endsWith('.zst') ? raw.pipe(createZstdDecompress()) : raw;
  const forwardReadError = (error: Error) => { if (stream !== raw) stream.destroy(error); };
  if (stream !== raw) raw.on('error',forwardReadError);
  const abort = () => { raw.destroy(); if (stream !== raw) stream.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0, expanded = 0;
  try {
    for await (const value of lines) {
      signal?.throwIfAborted();
      line++;
      expanded += Buffer.byteLength(value, 'utf8');
      if (expanded > 4 * 1024 * 1024 * 1024) break;
      if (!value.trim()) continue;
      if (value.length > 1024 && /"type"\s*:\s*"(?:world_state|token_usage_record|exec_command_output_delta|agent_reasoning_delta|turn_context|reasoning)"/.test(value.slice(0, 320)) && !/"(?:user_message|agent_message|session_meta|summary|compacted|compact_boundary)"/.test(value.slice(0, 320))) continue;
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) yield { value: parsed as Record<string, any>, line };
        else yield { malformed: true, line };
      } catch { yield { malformed: true, line }; }
    }
    signal?.throwIfAborted();
  } finally {
    lines.close(); raw.destroy(); if (stream !== raw) stream.destroy();
    raw.removeListener('error',forwardReadError);
    signal?.removeEventListener('abort', abort);
  }
}
export function safeFailure(error: unknown): string {
  if (error instanceof Error && /limit|depth|unsupported|cancel|abort|schema|format|corrupt/i.test(error.message)) return error.message.slice(0,200);
  return `Unable to read session (${(error as NodeJS.ErrnoException)?.code || 'unrecognized format'}).`;
}
