import { createHash } from 'node:crypto';
import type { Conversation } from '../shared/types';

export const hash = (value:unknown):string => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const now = ():string => new Date().toISOString();
export const unique = <T>(items:T[]):T[] => [...new Set(items)];
export function normalizeConversation(c:Conversation):Required<Pick<Conversation,'id'|'collectedAt'>> & Conversation {
  const messages = c.messages.filter(m => m.text?.trim()).map((m,i) => ({...m,id:m.id||`m-${i}`,text:m.text.replace(/\r\n/g,'\n')}));
  return {...c,messages,id:hash(`${c.source}:${c.externalId}`).slice(0,32),collectedAt:c.collectedAt||now(),warnings:unique(c.warnings||[])};
}
export const transcriptHash = (c:Conversation):string => hash(c.messages.map(m=>[m.role,m.text.trim().replace(/\s+/g,' ')]));
export const conversationHash = (c:Conversation):string => hash({messages:c.messages,title:c.title,completeness:c.completeness,warnings:c.warnings});
export function redact(text:string):string {
  return text.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,'[REDACTED_KEY]')
    .replace(/((?:api[_ -]?key|authorization|password|secret|token|密码|密钥)\s*[:=]\s*)(?:Bearer\s+)?["']?[^\s"'`,;]{6,}/gi,'$1[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,'[EMAIL]')
    .replace(/(?:[A-Z]:\\Users\\|\/Users\/|\/home\/)[^\\/\s]+/g,'[USER_HOME]')
    .replace(/\b(?:\+?\d[\d -]{7,}\d)\b/g,'[NUMBER]');
}
export function safeError(e:unknown):string {
  if (e instanceof Error && e.name==='AbortError') return 'Cancelled / 已取消';
  const code=(e as NodeJS.ErrnoException)?.code;
  if (code) return `Operation failed (${String(code).replace(/[^A-Z0-9_-]/gi,'').slice(0,30)})`;
  // Never echo source/model/provider bodies, private file contents or URLs with tokens.
  return 'Operation failed. Check connection and permissions. / 操作失败，请检查连接和权限。';
}
export function assertSafeUrl(value:string,localOnly=false):URL {
  const url = new URL(value);
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || url.search) throw new Error('Invalid endpoint');
  if (localOnly && !loopback) throw new Error('Local processing requires a loopback endpoint');
  if (url.protocol!=='https:' && !(loopback&&url.protocol==='http:')) throw new Error('HTTPS required');
  return url;
}
export function inDateRange(c:Conversation,from?:string,to?:string):boolean {
  const date=c.updatedAt||c.createdAt;
  if (!date) return true; // Include unknown timestamps, and report them rather than invent dates.
  const t=Date.parse(date);
  if (!Number.isFinite(t)) return true;
  return (!from||t>=Date.parse(from))&&(!to||t<Date.parse(to)+86400000);
}
