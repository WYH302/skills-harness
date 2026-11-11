import {PROVIDERS} from './providers.mjs';
let language='zh',status;
const $=id=>document.getElementById(id);
function translate(){document.documentElement.lang=language==='zh'?'zh-CN':'en';document.querySelectorAll('[data-zh]').forEach(el=>el.textContent=el.dataset[language]);$('language').textContent=language==='zh'?'EN':'中文';render();}
function connection(text,error=false){$('connection').textContent=text;$('connection').className=error?'error':'';}
function render(){
  if(!status)return;
  const checked=new Set([...document.querySelectorAll('.source input:checked')].map(x=>x.value));
  $('sources').replaceChildren();
  for(const [id,provider] of Object.entries(PROVIDERS)){
    const source=status.sources?.find(x=>x.id===id),row=document.createElement('div'),input=document.createElement('input'),label=document.createElement('label'),badge=document.createElement('span');
    row.className='source';input.type='checkbox';input.id=`source-${id}`;input.value=id;input.checked=checked.has(id)||source?.available===true;label.htmlFor=input.id;label.textContent=provider.name;
    badge.className=`badge ${source?.connected?'connected':''}`;
    badge.textContent=source?.connected?(language==='zh'?'已连接':'Connected'):source?.available?(language==='zh'?'请打开并登录':'Open & sign in'):(language==='zh'?'未授权':'Not allowed');
    if(provider.mode==='limited')badge.textContent+=language==='zh'?' · 部分':' · Partial';
    row.append(input,label,badge);$('sources').append(row);
    const tabs=(status.tabs||[]).filter(tab=>tab.source===id),contexts=[...new Set(tabs.map(tab=>tab.context))];
    if(contexts.length>1){const select=document.createElement('select');select.setAttribute('aria-label',`${provider.name} account`);const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=language==='zh'?'选择要使用的账户页面':'Choose account page';select.append(placeholder);for(const context of contexts){const tab=tabs.find(tab=>tab.context===context),option=document.createElement('option');option.value=String(tab.id);option.textContent=`${provider.name} ${context||'current'}`;option.selected=status.sourceTabs?.[id]?.context===context;select.append(option);}select.addEventListener('change',async()=>{if(select.value)await chrome.runtime.sendMessage({type:'chooseTab',source:id,tabId:Number(select.value)});await refresh();});$('sources').append(select);}
  }
  connection(status.error||(status.paired?(language==='zh'?`已配对 · ${status.clientName}。本机应用控制采集。`:`Paired · ${status.clientName}. Collection is controlled by the desktop app.`):(language==='zh'?'尚未配对':'Not paired')),Boolean(status.error));
  const requested=new URLSearchParams(location.search).get('source');if(PROVIDERS[requested]&&!status.sources?.find(source=>source.id===requested)?.available){const input=document.getElementById(`source-${requested}`);if(input)input.checked=true;}
}
async function refresh(){try{status=await chrome.runtime.sendMessage({type:'status'});render();}catch{connection(language==='zh'?'扩展连接暂不可用，请刷新扩展':'Extension unavailable; reload it',true);}}
$('pair').addEventListener('click',async()=>{
  $('pair').disabled=true;
  try{const result=await chrome.runtime.sendMessage({type:'pair',code:$('code').value});if(result.error)connection(result.error,true);else{$('code').value='';await refresh();}}catch{connection(language==='zh'?'连接失败，请确认桌面应用已打开':'Connection failed; open the desktop app',true);}finally{$('pair').disabled=false;}
});
$('allow').addEventListener('click',async()=>{
  const selected=[...document.querySelectorAll('.source input:checked')].map(x=>x.value);
  const origins=selected.flatMap(id=>PROVIDERS[id].hosts.map(host=>`https://${host}/*`));
  if(!origins.length){connection(language==='zh'?'请先选择网站':'Select at least one website',true);return;}
  const granted=await chrome.permissions.request({origins});
  if(!granted)connection(language==='zh'?'网站权限未授予':'Website permission was not granted',true);
  const requested=new URLSearchParams(location.search).get('source');
  if(granted&&PROVIDERS[requested]&&selected.includes(requested))await chrome.tabs.create({url:PROVIDERS[requested].url,active:true});
  await refresh();
});
$('refresh').addEventListener('click',refresh);
$('unpair').addEventListener('click',async()=>{await chrome.runtime.sendMessage({type:'unpair'});await refresh();});
$('language').addEventListener('click',async()=>{language=language==='zh'?'en':'zh';await chrome.storage.local.set({language});translate();});
language=(await chrome.storage.local.get('language')).language||'zh';translate();await refresh();
