/*
 * Adapted from pinguarmy/ai-chat-exporter (MIT), commit
 * 58d7d9f5e729ef47e3fec326115b79f607af576a:
 * src/lib/api-message-normalizer.ts, src/contents/deepseek-parser.ts,
 * src/contents/gemini-parser.ts and src/lib/grok-api.ts.
 * Copyright (c) 2024 AI Chat Exporter Contributors.
 * Modifications: portable JavaScript; SkillHarbor message shape; bounded
 * parsing; explicit partial status; tool roles retained. See LICENSE.
 */
export function normalizeApiTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
export const iso = value => {
  const ms = normalizeApiTimestamp(value);
  return ms === undefined || !Number.isFinite(ms) || Math.abs(ms) > 8.64e15 ? undefined : new Date(ms).toISOString();
};
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function messageArrayFrom(value, depth = 0) {
  if (depth > 3) return [];
  if (Array.isArray(value)) {
    const records = value.filter(isRecord);
    return records.some(record => normalizeApiMessageRole(record) !== null) ? records : [];
  }
  if (!isRecord(value)) return [];
  for (const key of ['chat_messages', 'messages', 'items', 'data', 'biz_data', 'conversation', 'result', 'payload']) {
    const records = messageArrayFrom(value[key], depth + 1);
    if (records.length) return records;
  }
  return [];
}
export const getApiMessageRecords = value => messageArrayFrom(value);
export function normalizeApiMessageRole(value) {
  const role = [value.role, value.sender_type, value.sender, value.message?.role, value.author?.role]
    .find(x => typeof x === 'string' && x.trim())?.toLowerCase();
  if (['user','human','customer','prompt'].includes(role)) return 'user';
  if (['assistant','bot','ai','model','grok'].includes(role)) return 'assistant';
  if (['tool','system'].includes(role)) return role;
  return null;
}
function textFromValue(value, depth = 0) {
  if (depth > 8) return [];
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(item => textFromValue(item, depth + 1));
  if (!isRecord(value)) return [];
  const values = [];
  for (const key of ['text','content','parts','body','value','delta']) if (key in value) values.push(...textFromValue(value[key], depth + 1));
  return values;
}
export function extractApiMessageText(value) {
  const candidates = [value.content, value.text, value.parts, value.body, value.message?.content, value.message?.text, value.message?.parts];
  // Fields may be aliases of the same body; prefer the first usable one.
  // Repeated paragraphs *within* that body remain source content.
  for(const candidate of candidates){const values=textFromValue(candidate);if(values.length)return values.join('\n\n').trim();}
  return '';
}
export function unwrapDeepSeekEnvelope(data) {
  let envelope = data;
  for (let depth = 0; depth < 4; depth++) {
    if (!isRecord(envelope)) break;
    if (isRecord(envelope.biz_data)) { envelope = envelope.biz_data; continue; }
    if (isRecord(envelope.data)) { envelope = envelope.data; continue; }
    break;
  }
  return envelope;
}
export function parseDeepSeekHistoryPage(data) {
  const envelope = unwrapDeepSeekEnvelope(data);
  const raw = Array.isArray(envelope) ? envelope : envelope?.chat_sessions || envelope?.items || envelope?.conversations || envelope?.chat_session || envelope?.data;
  if (!Array.isArray(raw)) throw new Error('Unknown DeepSeek history response; collection is incomplete.');
  const nextCursor = [envelope?.next_cursor,envelope?.nextCursor,envelope?.next_page_token,envelope?.nextPageToken,envelope?.cursor,envelope?.lte_cursor].find(v => typeof v === 'string' && v);
  const explicit = envelope?.has_more ?? envelope?.hasMore ?? envelope?.has_next_page;
  return {items:raw,nextCursor,hasMore:typeof explicit === 'boolean' ? explicit : Boolean(nextCursor)};
}
export function extractDeepSeekVisibleText(item) {
  const fragments = Array.isArray(item.fragments) ? item.fragments : [];
  const visible = fragments.flatMap(fragment => {
    if (!isRecord(fragment)) return [];
    const type = typeof fragment.type === 'string' ? fragment.type.toUpperCase() : '';
    if (type && !['REQUEST','RESPONSE','ANSWER','TEXT'].includes(type)) return [];
    return typeof fragment.content === 'string' && fragment.content.trim() ? [fragment.content.trim()] : [];
  });
  return visible.length ? visible.join('\n\n') : extractApiMessageText(item);
}
export function parseGeminiRpc(text, rpcId) {
  for (const line of text.split('\n')) {
    const start = line.indexOf('[[');
    if (start < 0) continue;
    try {
      const outer = JSON.parse(line.slice(start));
      for (const entry of outer) if (Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === rpcId && typeof entry[2] === 'string') return JSON.parse(entry[2]);
    } catch { /* Provider length markers and diagnostics are not payloads. */ }
  }
  throw new Error('Unknown Gemini RPC response; collection is incomplete.');
}
export function parseGeminiList(payload) {
  if (!Array.isArray(payload)) throw new Error('Unknown Gemini history envelope.');
  const items = [];
  function visit(array, depth = 0) {
    if (!Array.isArray(array) || depth > 8) return;
    for (const item of array) if (Array.isArray(item)) {
      if (typeof item[0] === 'string' && /^c_[A-Za-z0-9_-]+$/.test(item[0]) && typeof (item[1] || item[2]) === 'string') {
        const seconds = Array.isArray(item[5]) ? item[5][0] : item[5];
        items.push({id:item[0].replace(/^c_/,''),title:item[1] || item[2],updatedAt:iso(seconds)});
      }
      visit(item, depth + 1);
    }
  }
  visit(payload);
  const nextCursor = [payload[1], Array.isArray(payload[0]) ? payload[0][1] : undefined].find(v => typeof v === 'string' && v.trim());
  return {items,nextCursor,hasMore:Boolean(nextCursor)};
}
export function parseGeminiMessages(payload) {
  if (!Array.isArray(payload?.[0])) throw new Error('Unknown Gemini turn envelope.');
  const messages = [];
  let index = 0;
  for (const turn of [...payload[0]].reverse()) {
    if (!Array.isArray(turn)) continue;
    const timestamp = iso(turn?.[4]?.[0]);
    const id = typeof turn?.[0]?.[1] === 'string' ? turn[0][1] : `turn-${index++}`;
    const user = turn?.[2]?.[0]?.[0];
    const assistant = turn?.[3]?.[0]?.[0]?.[1]?.[0];
    if (typeof user === 'string' && user.trim()) messages.push({id:`${id}-user`,role:'user',text:user.trim(),timestamp});
    if (typeof assistant === 'string' && assistant.trim()) messages.push({id,role:'assistant',text:assistant.trim(),timestamp});
  }
  return messages;
}

/** Adapted from Claude's upstream root-chain resolver. Ambiguous branches are
 * rejected instead of guessing which regenerated answer the user accepted. */
export function resolveClaudeBranch(records,payload) {
  const first=(...values)=>values.find(x=>typeof x==='string'&&x.trim())||null;
  const idOf=r=>first(r.uuid,r.id,r.message_uuid,r.messageUuid);
  const parentOf=r=>{const value=first(r.parent_uuid,r.parent_message_uuid,r.parentMessageUuid,r.parent_id,r.parentId,r.parent?.uuid,r.parent?.id);return value==='00000000-0000-0000-0000-000000000000'?null:value;};
  const pointer=(value,depth=0)=>{
    if(!isRecord(value)||depth>3)return null;
    const direct=first(value.current_leaf_message_uuid,value.current_leaf_uuid,value.currentLeafMessageUuid,value.currentLeafUuid,value.current_node_uuid,value.currentNodeUuid,value.current_node?.uuid,value.current_node?.id);
    if(direct)return direct;
    for(const key of ['conversation','metadata','tree','branch']){const found=pointer(value[key],depth+1);if(found)return found;}
    return null;
  };
  if(!records.length)throw new Error('Claude message list unavailable');
  if(!records.some(r=>parentOf(r)))return {records,complete:true};
  const byId=new Map(records.map(r=>[idOf(r),r]).filter(([id])=>id));
  const parentIds=new Set(records.map(parentOf).filter(Boolean));
  const leaves=records.filter(r=>idOf(r)&&!parentIds.has(idOf(r)));
  const active=leaves.filter(r=>r.is_current===true||r.isCurrent===true||r.active===true||r.selected===true||r.is_active===true);
  let current=pointer(payload)||idOf(active[0]||{})||(leaves.length===1?idOf(leaves[0]):null);
  if(!current)throw new Error('Claude active branch is ambiguous; rendered-page capture is required');
  const chain=[],seen=new Set();
  while(current){
    if(seen.has(current)||!byId.has(current))throw new Error('Claude active branch is incomplete; rendered-page capture is required');
    seen.add(current);const record=byId.get(current);chain.unshift(record);current=parentOf(record);
  }
  return {records:chain,complete:true,alternatives:records.length>chain.length};
}
