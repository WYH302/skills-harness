import {PROVIDERS,sourceForUrl,pageRead,discoverProvider,normalizeConversation,retryRead,pause} from './providers.mjs';

const BASE='http://127.0.0.1:42837';
let polling=false,draining=false,liveToken='',cancelledIds=new Set(),lastStatus=0,writeTail=Promise.resolve();
const activeTasks=new Set();
const originsFor=id=>PROVIDERS[id].hosts.map(host=>`https://${host}/*`);
async function clientName() {
  const stored=await chrome.storage.local.get(['profileTag','clientName']);
  if(stored.clientName)return stored.clientName;
  const tag=stored.profileTag||crypto.randomUUID().slice(0,6);if(!stored.profileTag)await chrome.storage.local.set({profileTag:tag});
  return `${/Edg\//.test(navigator.userAgent)?'Edge':'Chrome'} · ${tag}`;
}
const accountContext=(source,url)=>source==='gemini'?(new URL(url).pathname.match(/^\/u\/\d+/)?.[0]||'/u/0'):'';
function updateQueue(change) {
  const work=writeTail.then(async()=>{const state=await chrome.storage.local.get(['queue','finished']);await chrome.storage.local.set(change(state));});
  writeTail=work.catch(()=>{});return work;
}

async function bridge(path,{method='GET',body,token=liveToken}={}) {
  const response=await fetch(BASE+path,{method,headers:{'X-SkillHarbor-Client':'extension',...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(!response.ok){if(response.status===401){liveToken='';await chrome.storage.local.remove('bridgeToken');}throw new Error(`Desktop connection failed (${response.status})`);}
  return response.json();
}
const emit=(command,type,data={})=>retryRead(()=>bridge('/events',{method:'POST',body:{commandId:command.id,source:command.source,type,...data}}),{attempts:3});

async function readTab(tabId,source,operation,args) {
  const tab=await chrome.tabs.get(tabId);
  if(sourceForUrl(tab.url)!==source)throw new Error('Provider tab changed; reopen the selected service.');
  const result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:pageRead,args:[source,operation,args||{}]});
  if(result?.[0]?.error)throw new Error('Provider page read failed');
  if(!result?.[0]||result[0].result===undefined)throw new Error('Provider page returned no data');
  return result[0].result;
}
async function findTab(source,{create=false,url}={}) {
  if(!PROVIDERS[source])throw new Error('Unsupported source');
  const granted=await chrome.permissions.contains({origins:originsFor(source)});
  if(!granted)throw new Error('Website permission required: open the SkillHarbor extension and allow this source.');
  const tabs=await chrome.tabs.query({url:originsFor(source)});
  const bindings=(await chrome.storage.local.get('sourceTabs')).sourceTabs||{};
  const bound=bindings[source];
  const contexts=new Set(tabs.map(tab=>accountContext(source,tab.url)));
  if(!bound&&contexts.size>1)throw new Error('Choose this website account in the SkillHarbor extension first.');
  const matching=bound?tabs.filter(tab=>accountContext(source,tab.url)===bound.context):tabs;
  if(!url&&matching.length){const tab=matching.find(t=>t.id===bound?.id)||matching.find(t=>t.active)||matching[0];if(!bound){bindings[source]={id:tab.id,context:accountContext(source,tab.url)};await chrome.storage.local.set({sourceTabs:bindings});}return tab.id;}
  if(!create)throw new Error('Open this service in a browser tab and sign in.');
  if(url&&sourceForUrl(url)!==source)throw new Error('Conversation URL origin mismatch');
  const target=url||(source==='gemini'&&bound?`https://gemini.google.com${bound.context}/app`:PROVIDERS[source].url);
  if(source==='gemini'&&bound&&accountContext(source,target)!==bound.context)throw new Error('Selected website account changed; choose it again in the extension.');
  const tab=await chrome.tabs.create({url:target,active:false});
  for(let attempt=0;attempt<90;attempt++){const current=await chrome.tabs.get(tab.id);if(current.status==='complete'){await pause(900);return tab.id;}await pause(500);}
  throw new Error('Provider tab timed out while loading');
}
async function statuses() {
  const list=[];
  for(const [id,provider] of Object.entries(PROVIDERS)) {
    const granted=await chrome.permissions.contains({origins:originsFor(id)});
    let connected=false,detail='请在扩展中允许此网站 / Allow website access in the extension';
    if(granted) {
      try {const tabId=await findTab(id);const probe=await readTab(tabId,id,'probe');connected=probe.connected===true;detail=connected?(provider.mode==='limited'?'已连接；仅页面可见范围 / Connected; rendered history only':'已连接；读取接口可访问历史 / Connected; provider-accessible history'):'请登录并打开一段历史 / Sign in and open a conversation';}
      catch {detail='请打开网站并登录；也可导入官方导出 / Open and sign in, or import a provider export';}
    }
    list.push({id,title:provider.name,kind:'web',available:granted,connected,mode:provider.mode,authorization:!granted?'permission':connected?'ready':'login',detail});
  }
  return list;
}
async function reportStatus() {
  if(!liveToken)return;
  await bridge('/status',{method:'POST',body:{clientName:await clientName(),sources:await statuses()}});
  lastStatus=Date.now();
}
function parseResume(cursor) {
  try {const c=JSON.parse(cursor);if(c.version===2&&typeof c.orderHash==='string'&&Number.isSafeInteger(c.nextIndex)&&c.nextIndex>=0&&Array.isArray(c.retryIds))return c;}catch{}
  return {version:2,orderHash:'',nextIndex:0,retryIds:[]};
}
async function checkpoint(command,resume) {
  const cursor=JSON.stringify(resume);
  await updateQueue(state=>({queue:(state.queue||[]).map(x=>x.id===command.id?{...x,cursor}:x)}));
  await emit(command,'checkpoint',{cursor});
}
async function captureDom(source,item) {
  const tabId=await findTab(source,{create:true,url:item.url||new URL(({chatgpt:'/c/',claude:'/chat/',gemini:'/app/',deepseek:'/a/chat/s/',grok:'/c/',perplexity:'/search/'}[source])+encodeURIComponent(item.id),PROVIDERS[source].url).href});
  try {
    for(let attempt=0;attempt<12;attempt++) {
      const conversation=await readTab(tabId,source,'dom',{id:item.id});
      if(conversation.messages.length)return conversation;
      await pause(800);
    }
    throw new Error('No recognized messages in the rendered page. Import an official export for this source.');
  } finally {await chrome.tabs.remove(tabId).catch(()=>{});}
}
async function runCommand(command) {
  if(command.action==='open') {
    try {
      const granted=await chrome.permissions.contains({origins:originsFor(command.source)});
      if(!granted)await chrome.tabs.create({url:chrome.runtime.getURL(`popup.html?source=${command.source}`),active:true});
      else {const tabId=await findTab(command.source,{create:true});await chrome.tabs.update(tabId,{active:true});}
      await emit(command,'done');await reportStatus();
    }catch{await emit(command,'error');}
    return;
  }
  const stopped=()=>cancelledIds.has(command.id);
  let resume=parseResume(command.cursor);
  let discovered=0,imported=0,skipped=0,failed=0,coverage='unknown';
  try {
    if(stopped())throw new Error('Collection cancelled');
    const tabId=await findTab(command.source,{create:true});
    const read=(op,args)=>readTab(tabId,command.source,op,args);
    const listing=await discoverProvider(command.source,read,{cancelled:stopped,onProgress:async count=>{discovered=count;await emit(command,'progress',{discovered,imported,skipped,failed,detail:'正在发现可访问历史 / Discovering accessible history'});}});
    if(command.source==='gemini') {
      const current=await chrome.tabs.get(tabId);const account=new URL(current.url).pathname.match(/^\/u\/\d+/)?.[0]||'';
      for(const item of listing.items)item.url=new URL(`${account}/app/${encodeURIComponent(item.id)}`,PROVIDERS.gemini.url).href;
    }
    discovered=listing.items.length;coverage=listing.coverage;
    for(const message of listing.warnings)await emit(command,'warning',{message});
    // A compact checkpoint is valid only for this exact deterministic list.
    // New or modified history invalidates it and is safely deduplicated by core.
    listing.items.sort((a,b)=>`${a.org||''}:${a.id}`.localeCompare(`${b.org||''}:${b.id}`));
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(listing.items.map(x=>`${x.org||''}:${x.id}:${x.updatedAt||''}`).join('\n')));
    const orderHash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
    if(resume.orderHash!==orderHash)resume={version:2,orderHash,nextIndex:0,retryIds:[]};
    const retryIds=new Set(resume.retryIds);
    for(const [index,item] of listing.items.entries()) {
      if(stopped())throw new Error('Collection cancelled');
      const identity=item.org?`${item.org}:${item.id}`:item.id;
      if(index<resume.nextIndex&&!retryIds.has(identity)){skipped++;continue;}
      const stamp=item.updatedAt||item.createdAt;
      // Date filtering is at conversation activity level. A missing timestamp
      // is retained rather than silently dropped; it is reported explicitly.
      if(stamp&&((command.dateFrom&&stamp.slice(0,10)<command.dateFrom)||(command.dateTo&&stamp.slice(0,10)>command.dateTo))){skipped++;resume.nextIndex=Math.max(resume.nextIndex,index+1);await checkpoint(command,resume);continue;}
      if(!stamp&&(command.dateFrom||command.dateTo))await emit(command,'warning',{message:'A conversation has no provider date; it is retained and cannot be reliably date-filtered.'});
      try {
        let conversation;
        if(command.source==='perplexity'||item.domFallback)conversation=await captureDom(command.source,item);
        else {
          try {const payload=await retryRead(()=>read('detail',{id:item.id,org:item.org}),{cancelled:stopped});conversation=normalizeConversation(command.source,item,payload);}
          catch(error){if(/401|403|429/.test(error.message))throw error;conversation=await captureDom(command.source,item);await emit(command,'warning',{message:'A provider detail request failed; rendered-page fallback is marked partial.'});}
        }
        if(conversation.completeness!=='full')coverage='partial';
        await emit(command,'conversation',{conversation});
        imported++;retryIds.delete(identity);
      } catch(error){if(stopped())throw error;failed++;coverage='partial';retryIds.add(identity);await emit(command,'warning',{message:safeError(error)});}
      resume={...resume,nextIndex:Math.max(resume.nextIndex,index+1),retryIds:[...retryIds]};
      await checkpoint(command,resume);
      if(retryIds.size>=100)throw new Error('100 conversation reads failed; reconnect this source and resume to retry.');
      await emit(command,'progress',{discovered,imported,skipped,failed,detail:'正在读取会话 / Reading conversations'});
      await pause(180);
    }
    await emit(command,'done',{discovered,imported,skipped,failed,coverage,detail:coverage==='full'?'接口分页已结束；仅当前账号可访问内容 / API pagination ended for accessible account history':'部分读取；请检查来源限制 / Partial collection; review source limitations'});
  } catch(error){await emit(command,stopped()?'done':'error',{discovered,imported,skipped,failed,coverage:'partial',message:safeError(error),detail:stopped()?'已取消；已导入内容保留 / Cancelled; imported work retained':safeError(error)}).catch(()=>{});}
}
function safeError(error) {
  // Provider errors are fixed local strings/status codes, never response bodies.
  const value=String(error?.message||'Browser collection failed');
  return value.replace(/https?:\/\/\S+/g,'[provider URL]').replace(/Bearer\s+\S+/gi,'[redacted]').slice(0,300);
}
async function drain() {
  if(draining||!liveToken)return;draining=true;
  try {
    for(;;) {
      const state=await chrome.storage.local.get('queue');const command=state.queue?.[0];
      if(!command)break;
      activeTasks.add(command.id);
      await runCommand(command);
      activeTasks.delete(command.id);
      // Checkpoint writes and command arrivals can happen during a run.
      await updateQueue(latest=>({queue:(latest.queue||[]).filter(x=>x.id!==command.id),finished:[...(latest.finished||[]),command.id].slice(-500)}));
    }
  } finally {draining=false;}
}
async function tick() {
  if(polling)return;polling=true;
  try {
    if(!liveToken)liveToken=(await chrome.storage.local.get('bridgeToken')).bridgeToken||'';
    if(!liveToken)return;
    const response=await bridge('/commands');
    cancelledIds=new Set(response.cancelled||[]);
    await updateQueue(state=>{const queue=state.queue||[],finished=new Set(state.finished||[]);for(const command of response.commands||[])if(PROVIDERS[command.source]&&typeof command.id==='string'&&!queue.some(x=>x.id===command.id)&&!finished.has(command.id))queue.push({id:command.id,source:command.source,action:command.action,dateFrom:command.dateFrom,dateTo:command.dateTo,cursor:command.cursor});return {queue};});
    void drain();
    if(Date.now()-lastStatus>60000)await reportStatus();
    await chrome.storage.local.set({connectionError:''});
  } catch {await chrome.storage.local.set({connectionError:'请打开本机 SkillHarbor；若已重启，请重新配对 / Open SkillHarbor; pair again if restarted'});}
  finally {polling=false;}
}
chrome.alarms.create('skillharbor-poll',{periodInMinutes:0.5});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='skillharbor-poll')void tick();});
chrome.runtime.onStartup.addListener(()=>void tick());
chrome.runtime.onInstalled.addListener(()=>void tick());
chrome.tabs.onUpdated.addListener((_id,change,tab)=>{if(change.status==='complete'&&sourceForUrl(tab.url))lastStatus=0;});
chrome.permissions.onAdded.addListener(()=>{lastStatus=0;void tick();});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
  // Only our own extension UI may pair or request status. There is deliberately
  // no externally_connectable section or page message listener.
  if(sender.id!==chrome.runtime.id||(sender.url||'').split(/[?#]/)[0]!==chrome.runtime.getURL('popup.html'))return false;
  if(message?.type==='pair') {
    const code=String(message.code||'').trim();
    if(!/^[A-Za-z0-9-]{4,20}$/.test(code)){sendResponse({error:'请输入桌面显示的配对码 / Enter the code shown in SkillHarbor'});return false;}
    void clientName().then(name=>bridge('/pair',{method:'POST',body:{code,clientName:name},token:''})).then(async result=>{
      if(typeof result.token!=='string'||result.token.length<16)throw new Error('Invalid desktop pairing response');
      liveToken=result.token;await chrome.storage.local.set({bridgeToken:liveToken,queue:[],finished:[],connectionError:''});await reportStatus();void tick();sendResponse({ok:true});
    }).catch(error=>sendResponse({error:safeError(error)}));return true;
  }
  if(message?.type==='status') {void Promise.all([chrome.storage.local.get(['bridgeToken','connectionError','queue','sourceTabs']),statuses(),chrome.tabs.query({}),clientName()]).then(async([state,sources,tabs,name])=>{sendResponse({paired:Boolean(state.bridgeToken),error:state.connectionError,sources,queued:state.queue?.length||0,clientName:name,sourceTabs:state.sourceTabs||{},tabs:tabs.filter(tab=>sourceForUrl(tab.url)).map(tab=>({id:tab.id,source:sourceForUrl(tab.url),context:accountContext(sourceForUrl(tab.url),tab.url)}))});if(liveToken){await bridge('/status',{method:'POST',body:{clientName:name,sources}}).catch(()=>{});lastStatus=Date.now();}});void tick();return true;}
  if(message?.type==='chooseTab') {void (async()=>{const tab=await chrome.tabs.get(Number(message.tabId));const source=sourceForUrl(tab.url);if(!source||source!==message.source)throw new Error('Invalid source tab');const bindings=(await chrome.storage.local.get('sourceTabs')).sourceTabs||{};bindings[source]={id:tab.id,context:accountContext(source,tab.url)};await chrome.storage.local.set({sourceTabs:bindings});await reportStatus();sendResponse({ok:true});})().catch(()=>sendResponse({error:'Could not select account'}));return true;}
  if(message?.type==='unpair') {liveToken='';cancelledIds=new Set(activeTasks);void chrome.storage.local.remove(['bridgeToken','queue','finished']).then(()=>sendResponse({ok:true}));return true;}
  return false;
});
// During active work requests keep the worker alive; alarms restore it after
// suspension. The persisted queue replays only unacknowledged conversations.
setInterval(()=>void tick(),2000);
void tick();
