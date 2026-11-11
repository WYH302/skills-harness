import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm,cp} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
// The extension is intentionally self-contained JavaScript, not a Node bundle.
// @ts-ignore
import {sourceForUrl,parseList,normalizeConversation,discoverProvider,retryRead,pageRead} from '../extension/providers.mjs';
// @ts-ignore
import {extractApiMessageText,parseGeminiRpc,parseGeminiMessages,resolveClaudeBranch} from '../extension/vendor/provider-normalizer.mjs';

test('provider domain checks reject lookalikes, non-HTTPS and unrelated paths',()=>{
  assert.equal(sourceForUrl('https://chatgpt.com/c/a'),'chatgpt');
  assert.equal(sourceForUrl('https://chatgpt.com.evil.example/c/a'),undefined);
  assert.equal(sourceForUrl('http://claude.ai/chat/a'),undefined);
  assert.equal(sourceForUrl('file:///tmp/chatgpt.com'),undefined);
});
test('normalization preserves repeated paragraphs and user/tool roles',()=>{
  assert.equal(extractApiMessageText({content:{parts:['repeat','repeat']},text:'repeat'}),'repeat\n\nrepeat');
  const result=normalizeConversation('claude',{id:'c',org:'org',title:'test'},{chat_messages:[{uuid:'u',sender:'human',text:'Please inspect.'},{uuid:'a',sender:'assistant',content:[{type:'text',text:'Inspected.'},{type:'tool_use',id:'t',name:'read_file',input:{path:'example.txt'}},{type:'tool_result',tool_use_id:'t',content:'example text'}]}]});
  assert.equal(result.externalId,'org:c');
  assert.deepEqual(result.messages.map((m: any)=>m.role),['user','assistant','tool','tool']);
  assert.equal(result.messages[2].toolName,'read_file');
});
test('ChatGPT active parent chain excludes regenerated alternatives',()=>{
  const result=normalizeConversation('chatgpt',{id:'c'}, {current_node:'accepted',mapping:{root:{id:'root',parent:null},u:{id:'u',parent:'root',message:{id:'u',author:{role:'user'},content:{parts:['Task']}}},old:{id:'old',parent:'u',message:{id:'old',author:{role:'assistant'},content:{parts:['Rejected branch']}}},accepted:{id:'accepted',parent:'u',message:{id:'a',author:{role:'assistant'},content:{parts:['Accepted branch']}}}}});
  assert.deepEqual(result.messages.map((m:any)=>m.text),['Task','Accepted branch']);
  assert.equal(result.completeness,'full');assert.match(result.warnings.join(' '),/active.*branch/);
});
test('Claude branch ambiguity and missing parents never silently choose an answer',()=>{
  const records=[{uuid:'u',sender:'human',parent_message_uuid:'00000000-0000-0000-0000-000000000000'},{uuid:'a',sender:'assistant',parent_message_uuid:'u'},{uuid:'b',sender:'assistant',parent_message_uuid:'u'}];
  assert.throws(()=>resolveClaudeBranch(records,{}),/ambiguous/);
  assert.deepEqual(resolveClaudeBranch(records,{current_leaf_message_uuid:'b'}).records.map((r:any)=>r.uuid),['u','b']);
  assert.throws(()=>resolveClaudeBranch(records,{current_leaf_message_uuid:'absent'}),/incomplete/);
});
test('Gemini typed RPC parser reads actual turn fields and preserves order',()=>{
  const turn=(id:string,user:string,answer:string)=>[[null,id],null,[[user]],[[[null,[answer]]]], [1700000000]];
  const payload=[[turn('new','Second request','Second answer'),turn('old','First request','First answer')],'unrelated citation metadata'];
  const envelope=JSON.stringify([['wrb.fr','hNvQHb',JSON.stringify(payload),null]]);
  const result=parseGeminiMessages(parseGeminiRpc(`)]}'\n\n100\n${envelope}\n`,'hNvQHb'));
  assert.deepEqual(result.map((m:any)=>m.text),['First request','First answer','Second request','Second answer']);
  assert.equal(result[0].timestamp,'2023-11-14T22:13:20.000Z');
  assert.throws(()=>parseGeminiRpc(envelope,'differentRpc'),/Unknown/);
});
test('DeepSeek envelope accepts cursor pagination and excludes hidden reasoning',()=>{
  const page=parseList('deepseek',{data:{biz_data:{chat_sessions:[{id:'c',title:'Task'}],has_more:true,next_cursor:'next'}}});
  assert.equal(page.nextCursor,'next');assert.equal(page.items[0].id,'c');
  const result=normalizeConversation('deepseek',{id:'c'},{data:{biz_data:{messages:[{id:'u',role:'USER',content:'Question'},{id:'a',role:'ASSISTANT',fragments:[{type:'THINK',content:'private reasoning'},{type:'RESPONSE',content:'Visible answer'}]}]}}});
  assert.deepEqual(result.messages.map((m:any)=>m.text),['Question','Visible answer']);
  assert.throws(()=>parseList('deepseek',{data:{unrelated:'metadata'}}),/Unknown/);
});
test('Grok missing response bodies are marked partial',()=>{
  const result=normalizeConversation('grok',{id:'c'},{detail:{conversation:{conversationId:'c',title:'Task'}},nodes:{responseNodes:[{responseId:'u'},{responseId:'a'}]},responses:{responses:[{responseId:'u',sender:'human',message:'Task'}]}});
  assert.equal(result.completeness,'partial');assert.equal(result.messages.length,1);
  assert.throws(()=>normalizeConversation('grok',{id:'wrong'},{detail:{conversation:{conversationId:'c'}}}),/identity/);
});
test('later pagination failure preserves earlier account results and reports partial',async()=>{
  const result=await discoverProvider('grok',async(op:string,args:any)=>{
    assert.equal(op,'list');
    if(args.cursor)throw new Error('Authentication required (401)');
    return {conversations:[{conversationId:'one',title:'One'}],nextPageToken:'next'};
  });
  assert.equal(result.items.length,1);assert.equal(result.coverage,'partial');assert.match(result.warnings.join(' '),/401/);
});
test('Gemini scans both streams, follows cursors and deduplicates overlapping rows',async()=>{
  const requests:any[]=[];
  const rpc=(data:unknown)=>JSON.stringify([['wrb.fr','MaZiqc',JSON.stringify(data),null]]);
  const result=await discoverProvider('gemini',async(op:string,args:any)=>{
    requests.push(args);assert.equal(op,'list');
    if(args.mode===0)return rpc([[['c_one','Task one']],null]);
    if(args.cursor)return rpc([[['c_two','Task two']],null]);
    return rpc([[['c_one','Task one']],'next']);
  });
  assert.equal(result.coverage,'full');assert.equal(result.items.length,2);assert.equal(requests.length,3);
});
test('bounded retry retries rate limits but does not retry authentication failures',async()=>{
  let count=0;const delays:number[]=[];
  const value=await retryRead(async()=>{count++;if(count<3)throw new Error('Provider request failed (429)');return 'ok';},{sleep:async(ms:number)=>{delays.push(ms);}});
  assert.equal(value,'ok');assert.equal(count,3);assert.deepEqual(delays,[500,1000]);
  count=0;await assert.rejects(retryRead(async()=>{count++;throw new Error('Authentication required (401)');},{sleep:async()=>{}}),/401/);assert.equal(count,1);
});
test('page transport rejects origin mismatch before touching provider data',async()=>{
  Object.defineProperty(globalThis,'location',{value:new URL('https://evil.example'),configurable:true});
  try {await assert.rejects(pageRead('chatgpt','detail',{id:'c'}),/origin mismatch/);}
  finally {delete (globalThis as any).location;}
});
test('extension requests optional website access and has no cookie or external-message privileges',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.manifest_version,3);assert.ok(!manifest.permissions.includes('cookies'));
  assert.ok(!manifest.permissions.includes('debugger'));assert.equal(manifest.externally_connectable,undefined);
  assert.deepEqual(manifest.host_permissions,['http://127.0.0.1:42837/*']);
  assert.ok(manifest.optional_host_permissions.includes('https://chatgpt.com/*'));
});

test('real Chromium extension pairs with the authenticated desktop bridge',{skip:process.env.SKILLHARBOR_EXTENSION_SMOKE!=='1',timeout:60000},async()=>{
  const {chromium}=await import('@playwright/test');
  const {Store}=await import('../src/core/store');
  const {BrowserBridge}=await import('../src/core/bridge');
  const temporary=await mkdtemp(path.join(tmpdir(),'skillharbor-extension-'));
  const store=new Store(path.join(temporary,'data'));
  const bridge=new BrowserBridge(store);
  let context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>|undefined;
  try {
    await bridge.start(42837);
    let executablePath=process.env.SKILLHARBOR_CHROMIUM||chromium.executablePath();
    if(!existsSync(executablePath))executablePath=path.join(process.env.LOCALAPPDATA||'','ms-playwright','chromium-1217','chrome-win64','chrome.exe');
    // The isolated smoke profile grants only ChatGPT fixture origins at
    // installation time. Production retains optional permission prompts.
    const extensionPath=path.join(temporary,'extension');await cp(path.resolve('extension'),extensionPath,{recursive:true});
    const manifest=JSON.parse(await readFile(path.join(extensionPath,'manifest.json'),'utf8'));
    manifest.host_permissions.push('https://chatgpt.com/*','https://chat.openai.com/*');
    await writeFile(path.join(extensionPath,'manifest.json'),JSON.stringify(manifest));
    context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{executablePath,headless:true,args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const extensionId=new URL(worker.url()).hostname;
    const popup=await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#code').fill(bridge.info().pairingCode!);
    await popup.locator('#pair').click();
    try {await popup.waitForFunction(()=>document.getElementById('connection')?.textContent?.includes('已配对'),{},{timeout:20000});}
    catch {throw new Error(`Actual extension pairing failed: ${await popup.locator('#connection').innerText()}`);}
    assert.equal(bridge.info().paired,true);
    assert.equal(bridge.sourceStatuses().length,6);
    assert.equal(bridge.sourceStatuses().every(source=>source.connected===false),true);
    const token=await worker.evaluate(async()=>{const chromeApi=(globalThis as any).chrome;return (await chromeApi.storage.local.get('bridgeToken')).bridgeToken;});
    assert.equal(typeof token,'string');assert.ok(token.length>=32);
    // A synthetic provider site exercises MAIN-world reads, both history
    // partitions, canonical messages, bridge queue and acknowledged delivery.
    const requests:string[]=[];
    await context.route('https://chatgpt.com/**',async route=>{
      const url=new URL(route.request().url());requests.push(url.pathname+url.search);
      if(url.pathname==='/api/auth/session'){await route.fulfill({json:{accessToken:'synthetic-test-token-never-exported'}});return;}
      if(url.pathname==='/backend-api/conversations') {await route.fulfill({json:{items:url.searchParams.get('is_archived')==='true'?[]:[{id:'fixture-one',title:'Synthetic procedure',create_time:1700000000,update_time:1700000000}],offset:0,total:url.searchParams.get('is_archived')==='true'?0:1}});return;}
      if(url.pathname==='/backend-api/conversation/fixture-one') {await route.fulfill({json:{id:'fixture-one',title:'Synthetic procedure',current_node:'a',mapping:{root:{id:'root',parent:null},u:{id:'u',parent:'root',message:{id:'u',author:{role:'user'},content:{parts:['Compare two libraries for a small offline app.']}}},a:{id:'a',parent:'u',message:{id:'a',author:{role:'assistant'},content:{parts:['1. Identify the target task and supported runtime.\n2. Compare license, maintenance, and installation needs.\n3. State the tradeoffs and recommend a concrete choice.']}}}}}});return;}
      await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>ChatGPT fixture</title></head><body><main>Non-sensitive provider fixture</main></body></html>'});
    });
    const providerPage=await context.newPage();await providerPage.goto('https://chatgpt.com/');
    const events:any[]=[];const signal=new AbortController();
    const collection=(async()=>{for await(const event of bridge.collect('chatgpt',{signal:signal.signal}))events.push(event);})();
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {await Promise.race([collection,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Synthetic extension collection timed out')),20000);})]);}
    finally {clearTimeout(deadline);signal.abort();}
    const conversations=events.filter(e=>e.type==='conversation');
    assert.equal(conversations.length,1);assert.equal(conversations[0].conversation.externalId,'fixture-one');
    assert.equal(conversations[0].conversation.messages.length,2);assert.equal(conversations[0].conversation.completeness,'full');
    assert.ok(requests.some(url=>url.includes('is_archived=true')));assert.ok(requests.some(url=>url.includes('is_archived=false')));
    assert.ok(!JSON.stringify(events).includes('synthetic-test-token-never-exported'));
    await context.close();context=undefined;
  } finally {await context?.close();await bridge.close();store.close();await rm(temporary,{recursive:true,force:true});}
});
