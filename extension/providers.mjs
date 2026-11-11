/* Provider request sequences adapted from pinguarmy/ai-chat-exporter (MIT).
 * Copyright (c) 2024 AI Chat Exporter Contributors. See vendor/PINGUARMY_LICENSE.txt.
 * SkillHarbor-specific transport, guards, canonical normalization and fallback.
 */
import {iso,isRecord,getApiMessageRecords,normalizeApiMessageRole,extractApiMessageText,unwrapDeepSeekEnvelope,parseDeepSeekHistoryPage,extractDeepSeekVisibleText,parseGeminiRpc,parseGeminiList,parseGeminiMessages,resolveClaudeBranch} from './vendor/provider-normalizer.mjs';

export const PROVIDERS = {
  chatgpt:{name:'ChatGPT',url:'https://chatgpt.com/',hosts:['chatgpt.com','chat.openai.com'],mode:'automatic'},
  claude:{name:'Claude',url:'https://claude.ai/new',hosts:['claude.ai'],mode:'automatic'},
  gemini:{name:'Gemini',url:'https://gemini.google.com/app',hosts:['gemini.google.com'],mode:'automatic'},
  deepseek:{name:'DeepSeek',url:'https://chat.deepseek.com/',hosts:['chat.deepseek.com'],mode:'automatic'},
  grok:{name:'Grok',url:'https://grok.com/',hosts:['grok.com','www.grok.com'],mode:'automatic'},
  perplexity:{name:'Perplexity',url:'https://www.perplexity.ai/',hosts:['www.perplexity.ai','perplexity.ai'],mode:'limited'}
};
export function sourceForUrl(url) {
  try {const u=new URL(url);return u.protocol==='https:' ? Object.keys(PROVIDERS).find(id=>PROVIDERS[id].hosts.includes(u.hostname)) : undefined;} catch {return undefined;}
}
export const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
export async function retryRead(fn,{attempts=3,sleep=pause,cancelled=()=>false}={}) {
  for(let attempt=0;attempt<attempts;attempt++) {
    if(cancelled()) throw new Error('Collection cancelled');
    try {return await fn();} catch(error) {
      if(attempt===attempts-1 || /(?:\b401\b|\b403\b|auth|sign.?in|login|cancelled|unknown .*envelope)/i.test(error.message)) throw error;
      await sleep(Math.min(4000,500*2**attempt));
    }
  }
}

/** This function is serialized into a verified provider tab. It must remain
 * self-contained. No bridge token or API key is ever passed into the page.
 * Only fixed, read-only provider operations are available; no arbitrary URL,
 * method, body, code or filesystem path is accepted from history content. */
export async function pageRead(source, operation, args = {}) {
  const hosts={chatgpt:['chatgpt.com','chat.openai.com'],claude:['claude.ai'],gemini:['gemini.google.com'],deepseek:['chat.deepseek.com'],grok:['grok.com','www.grok.com'],perplexity:['www.perplexity.ai','perplexity.ai']};
  if(location.protocol!=='https:' || !hosts[source]?.includes(location.hostname)) throw new Error('Provider tab origin mismatch');
  const safeId=value=>{if(typeof value!=='string'||!value||value.length>256||!/^[A-Za-z0-9_:-]+$/.test(value))throw new Error('Invalid conversation identifier');return encodeURIComponent(value);};
  const safeOffset = Math.max(0,Math.min(10_000_000,Number(args.offset)||0));
  const safeCursor=typeof args.cursor==='string'&&args.cursor.length<8192?args.cursor:'';
  let accessToken;
  async function read(path,{method='GET',body,headers={},text=false}={}) {
    const url=new URL(path,location.origin);
    if(url.origin!==location.origin)throw new Error('Cross-origin provider request blocked');
    if(source==='chatgpt' && path.startsWith('/backend-api/')) {
      if(!accessToken){const session=await fetch('/api/auth/session',{credentials:'include',signal:AbortSignal.timeout(20000)});if(!session.ok)throw new Error(`Authentication required (${session.status})`);accessToken=(await session.json()).accessToken;if(typeof accessToken!=='string')throw new Error('Authentication required');}
      headers={...headers,Authorization:`Bearer ${accessToken}`};
    }
    const response=await fetch(url.href,{method,body,headers:{Accept:'application/json',...headers},credentials:'include',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Provider request failed (${response.status})`);
    return text?response.text():response.json();
  }
  async function geminiRpc(id,rpcArgs) {
    // Read the website's own request tokens transiently. They never leave this
    // page function, enter extension storage, or reach the desktop bridge.
    const data=globalThis.WIZ_global_data||{};
    const scripts=Array.from(document.scripts).map(s=>s.textContent||'').join('\n');
    const at=data.SNlM0e || scripts.match(/"SNlM0e"\s*:\s*"([^"\n]+)"/)?.[1];
    const sid=data.FdrFJe || scripts.match(/"FdrFJe"\s*:\s*"([^"\n]+)"/)?.[1] || '';
    if(typeof at!=='string'||!at||at.length>4096)throw new Error('Gemini sign-in required or request token unavailable');
    const account=location.pathname.match(/^\/u\/(\d+)\//)?.[1];
    const params=new URLSearchParams({rpcids:id,'source-path':location.pathname,'f.sid':String(sid),rt:'c'});
    if(account)params.set('authuser',account);
    const body=new URLSearchParams({'f.req':JSON.stringify([[[id,JSON.stringify(rpcArgs),null,'generic']]]),at});
    return read(`/_/BardChatUi/data/batchexecute?${params}`,{method:'POST',body:body.toString(),headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','X-Same-Domain':'1'},text:true});
  }
  if(operation==='list') {
    if(source==='chatgpt')return read(`/backend-api/conversations?offset=${safeOffset}&limit=100&order=updated&is_archived=${args.archived===true}`);
    if(source==='claude')return read(`/api/organizations/${safeId(args.org)}/chat_conversations?limit=100&offset=${safeOffset}`);
    if(source==='gemini')return geminiRpc('MaZiqc',[25,safeCursor||null,[args.mode===1?1:0,null,1]]);
    if(source==='deepseek') {
      const endpoint=args.endpoint==='legacy'?'/api/v0/chat/history':'/api/v0/chat_session/fetch_page';
      const params=args.endpoint==='legacy'?new URLSearchParams({limit:'100',offset:String(safeOffset),...(safeCursor?{cursor:safeCursor}:{})}):new URLSearchParams({'lte_cursor.pinned':'false',...(safeCursor?{'lte_cursor.id':safeCursor}:{})});
      return read(`${endpoint}?${params}`);
    }
    if(source==='grok')return read(`/rest/app-chat/conversations?pageSize=100${safeCursor?`&pageToken=${encodeURIComponent(safeCursor)}`:''}`);
  }
  if(source==='claude'&&operation==='organizations')return read('/api/bootstrap');
  if(operation==='probe') {
    if(source==='chatgpt'){const s=await read('/api/auth/session');return {connected:typeof s.accessToken==='string'&&Boolean(s.accessToken)};}
    if(source==='claude'){const s=await read('/api/bootstrap');return {connected:Array.isArray(s?.account?.memberships)&&s.account.memberships.length>0};}
    if(source==='gemini'){const s=globalThis.WIZ_global_data||{};return {connected:typeof s.SNlM0e==='string'||Array.from(document.scripts).some(x=>/"SNlM0e"\s*:\s*"/.test(x.textContent||''))};}
    if(source==='deepseek'){await read('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false');return {connected:true};}
    if(source==='grok'){await read('/rest/app-chat/conversations?pageSize=1');return {connected:true};}
    if(source==='perplexity')return {connected:Boolean(document.querySelector('a[href^="/search/"],a[href^="/page/"],[data-testid="answer"],[data-testid="user-menu"]'))};
  }
  if(operation==='detail') {
    const id=safeId(args.id);
    if(source==='chatgpt')return read(`/backend-api/conversation/${id}`);
    if(source==='claude')return read(`/api/organizations/${safeId(args.org)}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`);
    if(source==='gemini')return geminiRpc('hNvQHb',[`c_${decodeURIComponent(id)}`,1000,null,1,[1],[4],null,1]);
    if(source==='deepseek')return read(`/api/v0/chat/history_messages?chat_session_id=${id}`);
    if(source==='grok') {
      const detail=await read(`/rest/app-chat/conversations_v2/${id}`);
      const nodes=await read(`/rest/app-chat/conversations/${id}/response-node`);
      const responseIds=[...new Set((Array.isArray(nodes.responseNodes)?nodes.responseNodes:[]).map(n=>n.responseId).filter(x=>typeof x==='string'))];
      if(!responseIds.length)throw new Error('Grok response node list unavailable');
      const responses=await read(`/rest/app-chat/conversations/${id}/load-responses`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({responseIds})});
      return {detail,nodes,responses};
    }
  }
  const patterns={chatgpt:/^\/c\/([A-Za-z0-9_-]+)/,claude:/^\/chat\/([A-Za-z0-9_-]+)/,gemini:/\/(?:app)\/([A-Za-z0-9_-]+)/,deepseek:/\/(?:a\/chat\/s|chat)\/([A-Za-z0-9_-]+)/,grok:/^\/c\/([A-Za-z0-9_-]+)/,perplexity:/^\/(?:search|page)\/([^/?#]+)/};
  if(operation==='sidebar') {
    const byId=new Map();
    const scrollNode=document.querySelector('nav [class*="overflow"],aside [class*="overflow"],[class*="sidebar"] [class*="overflow"],nav,aside');
    const initialTop=scrollNode?.scrollTop;
    let stable=0;
    for(let pass=0;pass<35;pass++) {
      const before=byId.size;
      for(const anchor of document.querySelectorAll('a[href]')) {
        let u;try{u=new URL(anchor.href,location.href);}catch{continue;}
        if(!hosts[source].includes(u.hostname))continue;
        const id=u.pathname.match(patterns[source])?.[1];
        if(id)byId.set(id,{id,title:(anchor.innerText||anchor.textContent||'Untitled conversation').trim(),url:u.href});
      }
      stable=byId.size===before?stable+1:0;
      if(!scrollNode||stable>=3)break;
      scrollNode.scrollTop=scrollNode.scrollHeight;
      scrollNode.dispatchEvent(new Event('scroll',{bubbles:true}));
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    if(scrollNode&&initialTop!==undefined)scrollNode.scrollTop=initialTop;
    return {items:[...byId.values()],complete:false,method:'sidebar'};
  }
  if(operation==='dom') {
    const actual=location.pathname.match(patterns[source])?.[1];
    if(!actual||actual!==args.id)throw new Error('Open page does not match the requested conversation');
    const selectors={chatgpt:'[data-message-author-role]',claude:'[data-testid="user-message"], .font-claude-message, [data-is-streaming] .standard-markdown',gemini:'user-query,model-response',deepseek:'[data-message-author-role], [class*="user-message"], [class*="assistant-message"]',grok:'[data-message-author-role], [class*="message-user"], [class*="message-assistant"]',perplexity:'[data-testid="user-query"], [data-testid="query"], [data-testid="answer"], [data-testid="answer-content"], .prose'};
    const root=document.querySelector('main,[role="main"],chat-window')||document.body;
    const nodes=Array.from(root.querySelectorAll(selectors[source]));
    const messages=[];
    for(const node of nodes) {
      if(nodes.some(other=>other!==node&&other.contains(node)))continue;
      const explicit=node.getAttribute('data-message-author-role');
      const user=explicit==='user'||node.matches('user-query,[data-testid="user-message"],[data-testid="user-query"],[data-testid="query"],[class*="message-user"],[class*="user-message"]');
      const clone=node.cloneNode(true);
      clone.querySelectorAll('button,script,style,[aria-hidden="true"]').forEach(el=>el.remove());
      const render=el=>{
        if(el.nodeType===3)return el.textContent||'';
        if(el.nodeType!==1)return '';
        if(el.tagName==='BR')return '\n';
        if(el.tagName==='PRE')return `\n\n${el.textContent||''}\n\n`;
        const body=Array.from(el.childNodes).map(render).join('');
        return /^(P|DIV|LI|UL|OL|H[1-6]|BLOCKQUOTE|TR)$/.test(el.tagName)?`\n${body}\n`:body;
      };
      const text=render(clone).replace(/\n{3,}/g,'\n\n').trim();
      if(!text)continue;
      if(messages.at(-1)?.text===text&&messages.at(-1)?.role===(user?'user':'assistant'))continue;
      messages.push({id:node.getAttribute('data-message-id')||node.id||`dom-${messages.length}`,role:user?'user':'assistant',text});
    }
    return {source,externalId:actual,title:document.title,messages,url:location.href,completeness:'partial',warnings:['Captured rendered page text only. Earlier, virtualized, archived, or hidden messages may be absent.'],collectedAt:new Date().toISOString()};
  }
  throw new Error('Unsupported provider operation');
}

export function parseList(source,payload) {
  if(source==='chatgpt') {
    const items=payload?.items||payload?.conversations;
    if(!Array.isArray(items))throw new Error('Unknown ChatGPT history envelope');
    return {items:items.map(x=>({id:x.id,title:x.title,createdAt:iso(x.create_time),updatedAt:iso(x.update_time)})),hasMore:typeof payload.total==='number'?Number(payload.offset||0)+items.length<payload.total:items.length===100};
  }
  if(source==='claude') {
    const items=Array.isArray(payload)?payload:payload?.conversations||payload?.items;
    if(!Array.isArray(items))throw new Error('Unknown Claude history envelope');
    return {items:items.map(x=>({id:x.uuid||x.id,title:x.name||x.title,createdAt:iso(x.created_at),updatedAt:iso(x.updated_at)})),hasMore:items.length===100};
  }
  if(source==='gemini')return parseGeminiList(parseGeminiRpc(payload,'MaZiqc'));
  if(source==='deepseek') {
    const page=parseDeepSeekHistoryPage(payload);
    return {...page,items:page.items.map(x=>({id:x.chat_session_id||x.id,title:x.title||x.name,createdAt:iso(x.created_at??x.inserted_at??x.create_time),updatedAt:iso(x.updated_at)}))};
  }
  if(source==='grok') {
    if(!isRecord(payload))throw new Error('Unknown Grok history envelope');
    const arrays=Object.values(payload).filter(Array.isArray);
    if(!arrays.length&&!('nextPageToken' in payload))throw new Error('Unknown Grok history envelope');
    const items=arrays.flat().filter(isRecord).map(x=>({id:x.conversationId||x.id,title:x.title||x.name,createdAt:iso(x.createTime||x.createdAt),updatedAt:iso(x.modifyTime||x.updatedAt)}));
    return {items,nextCursor:payload.nextPageToken,hasMore:Boolean(payload.nextPageToken)};
  }
  return {items:payload?.items||[],hasMore:false};
}

export function normalizeConversation(source,item,payload) {
  const warnings=[];
  let messages=[],complete=true,title=item.title,createdAt=item.createdAt,updatedAt=item.updatedAt;
  if(source==='chatgpt') {
    const mapping=payload?.mapping;
    if(!isRecord(mapping))throw new Error('ChatGPT message tree unavailable');
    let id=payload.current_node;
    if(typeof id!=='string'||!mapping[id])throw new Error('ChatGPT current branch is unavailable; rendered-page capture is required');
    const visited=new Set(),chain=[];
    while(id) {
      if(visited.has(id)||!mapping[id])throw new Error('ChatGPT current branch is incomplete; rendered-page capture is required');
      visited.add(id);chain.unshift(mapping[id]);id=mapping[id].parent;
    }
    for(const node of chain) {
      const m=node.message;if(!m)continue;
      if(m.metadata?.is_visually_hidden_from_conversation)continue;
      const role=normalizeApiMessageRole(m);
      if(!role)continue;
      const text=extractApiMessageText(m);
      const artifactRefs=[...(Array.isArray(m.metadata?.attachments)?m.metadata.attachments:[]),...(Array.isArray(m.content?.parts)?m.content.parts:[])].flatMap(part=>typeof part==='object'&&part?[part.file_id,part.asset_pointer,part.id].filter(x=>typeof x==='string'):[]);
      if(text||artifactRefs.length)messages.push({id:m.id||node.id,role,text,timestamp:iso(m.create_time),...(m.author?.name?{toolName:m.author.name}:{}),...(artifactRefs.length?{artifactRefs}: {})});
    }
    title=payload.title||title;createdAt=iso(payload.create_time)||createdAt;updatedAt=iso(payload.update_time)||updatedAt;
    if(visited.size<Object.keys(mapping).length)warnings.push('Only the active conversation branch is analyzed; edited and regenerated alternatives are not merged.');
  } else if(source==='gemini') {
    const body=parseGeminiRpc(payload,'hNvQHb');messages=parseGeminiMessages(body);
    if(body[0].length>=1000){complete=false;warnings.push('The provider returned the 1,000-turn request limit; earlier turns may be absent.');}
    createdAt=messages[0]?.timestamp||createdAt;
  } else if(source==='grok') {
    const detail=payload.detail?.conversation;
    if((detail?.conversationId||detail?.id)!==item.id)throw new Error('Grok conversation identity mismatch');
    const ids=[...new Set((payload.nodes?.responseNodes||[]).map(x=>x.responseId).filter(x=>typeof x==='string'))];
    const responses=new Map((payload.responses?.responses||[]).map(x=>[x.responseId,x]));
    for(const id of ids){const record=responses.get(id);if(!record){complete=false;continue;}const role=normalizeApiMessageRole(record);const text=typeof record.message==='string'?record.message:extractApiMessageText(record);if(role&&text)messages.push({id,role,text,timestamp:iso(record.createTime)});else complete=false;}
    title=detail.title||title;createdAt=iso(detail.createTime)||createdAt;
    if(!complete)warnings.push('Some Grok response nodes had no available message body.');
  } else {
    const body=source==='deepseek'?unwrapDeepSeekEnvelope(payload):payload;
    let records=getApiMessageRecords(payload);
    if(source==='claude'){const branch=resolveClaudeBranch(records,payload);records=branch.records;if(branch.alternatives)warnings.push('Only the active conversation branch is analyzed; regenerated alternatives are not merged.');}
    for(const [index,record] of records.entries()) {
      const role=normalizeApiMessageRole(record);
      const content=source==='claude'&&Array.isArray(record.content)?record.content.filter(x=>!['tool_use','tool_result'].includes(x?.type)):record.content;
      const text=source==='deepseek'?extractDeepSeekVisibleText(record):extractApiMessageText({...record,content});
      if(role&&text)messages.push({id:String(record.uuid||record.id||record.message_id||index),role,text,timestamp:iso(record.created_at??record.inserted_at??record.createdAt??record.create_time),...(record.tool_name?{toolName:record.tool_name}:{})});
      if(source==='claude'&&Array.isArray(record.content))for(const block of record.content)if(block?.type==='tool_use'||block?.type==='tool_result')messages.push({id:String(block.id||block.tool_use_id||`${record.uuid||index}-tool`),role:'tool',text:block.type==='tool_use'?JSON.stringify(block.input??{}):extractApiMessageText(block),toolName:block.name||block.type,timestamp:iso(record.created_at)});
    }
    title=body?.chat_session?.title||body?.name||body?.title||title;
    createdAt=iso(body?.created_at??body?.chat_session?.created_at)||createdAt;
    updatedAt=iso(body?.updated_at)||updatedAt;
    if(source==='deepseek' && (body?.has_more||body?.hasMore)){complete=false;warnings.push('Provider reports additional message pages unavailable to this adapter.');}
    if(source==='claude' && (payload?.is_truncated||payload?.has_more)){complete=false;warnings.push('Provider reports a truncated conversation.');}
  }
  if(!messages.length)throw new Error('No recognized conversation messages; use provider export import.');
  const route={chatgpt:'/c/',claude:'/chat/',gemini:'/app/',deepseek:'/a/chat/s/',grok:'/c/',perplexity:'/search/'}[source];
  return {source,externalId:source==='claude'&&item.org?`${item.org}:${item.id}`:item.id,title:title||'Untitled conversation',createdAt,updatedAt,messages,url:item.url||new URL(route+encodeURIComponent(item.id),PROVIDERS[source].url).href,completeness:complete?'full':'partial',warnings,collectedAt:new Date().toISOString()};
}

/** Bounded, deduplicated pagination. A failed later page retains earlier work. */
export async function discoverProvider(source,read,{cancelled=()=>false,onProgress=async()=>{}}={}) {
  const byId=new Map(),warnings=[];
  if(source==='perplexity'){const result=await read('sidebar',{});return {items:result.items,coverage:'partial',warnings:['Perplexity uses visible/sidebar page capture; complete account history is not verified.']};}
  let streams=[{}];
  if(source==='chatgpt')streams=[{archived:false},{archived:true}];
  if(source==='gemini')streams=[{mode:1},{mode:0}];
  if(source==='claude') {
    try {const bootstrap=await read('organizations',{});const orgs=bootstrap?.account?.memberships?.map(x=>x.organization?.uuid||x.organization?.id).filter(x=>typeof x==='string'&&/^[A-Za-z0-9_-]+$/.test(x));if(!orgs?.length)throw new Error('Claude membership list unavailable');streams=[...new Set(orgs)].map(org=>({org}));}
    catch(error){warnings.push(error.message);streams=[];}
  }
  let coverage=streams.length?'full':'partial';
  for(const stream of streams) {
    let cursor='',offset=0,endpoint='current';const seen=new Set();
    try {
      for(let page=0;page<2000;page++) {
        if(cancelled())throw new Error('Collection cancelled');
        let payload;
        try {payload=await retryRead(()=>read('list',{...stream,cursor,offset,endpoint}),{cancelled});}
        catch(error){if(source==='deepseek'&&page===0&&endpoint==='current'&&!/401|403|429/.test(error.message)){endpoint='legacy';payload=await read('list',{cursor,offset,endpoint});}else throw error;}
        const parsed=parseList(source,payload);
        let added=0;
        for(const item of parsed.items){if(typeof item.id!=='string'||!item.id)continue;const key=stream.org?`${stream.org}:${item.id}`:item.id;if(!byId.has(key)){byId.set(key,{...item,...stream});added++;}}
        await onProgress(byId.size);
        if(!parsed.hasMore)break;
        if(!parsed.items.length||!added)throw new Error('Provider pagination stopped making progress');
        let next=parsed.nextCursor;
        if(source==='deepseek'&&!next&&endpoint==='current')next=parsed.items.at(-1)?.id;
        if(next){if(seen.has(next))throw new Error('Provider pagination cursor repeated');seen.add(next);cursor=next;}else offset+=parsed.items.length;
        if(page===1999)throw new Error('Provider reached the safety page limit; resume or import an export.');
      }
    } catch(error){if(cancelled())throw error;coverage='partial';warnings.push(error.message);}
  }
  if(!byId.size&&coverage==='partial') {
    const fallback=await read('sidebar',{});
    for(const item of fallback.items||[])byId.set(item.id,{...item,domFallback:true});
    warnings.push('API discovery failed. Sidebar discovery may omit older, archived, or virtualized conversations.');
  }
  return {items:[...byId.values()],coverage,warnings};
}
