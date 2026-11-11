import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlanAuth, verifyPlanIdentity, readResponsesStream, type PlanAccount } from '../src/core/plan-auth';
import { encryptedPlanVault } from '../src/core/plan-vault';
import { verifyOllamaModel } from '../src/core/generators';
import { Store } from '../src/core/store';
import { Pipeline, type Collector } from '../src/core/pipeline';
import { demoConversations } from '../src/core/demo-data';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { memberTransport } from '../src/core/member-cli';

const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
test('official dynamic registration uses PKCE, state and issued client id; callback replay cannot overwrite an account',async()=>{
  let accounts:PlanAccount[]=[];let opened='';let exchanges=0;let finished!:()=>void;const done=new Promise<void>(r=>finished=r);
  const auth=new PlanAuth({read:()=>structuredClone(accounts),write:a=>{accounts=structuredClone(a);finished();}},'urn:uuid:synthetic-host',async url=>{opened=url;},()=>{},{
    verify:async(_token,client,nonce)=>{assert.equal(client,'oaiapp_synthetic');assert.ok(nonce);return {sub:'synthetic-user',email:'synthetic@example.invalid',nonce};},
    fetch:async(url,init)=>{if(String(url).endsWith('/oauth/token')){exchanges++;const body=new URLSearchParams(String(init?.body));assert.equal(body.get('client_id'),'oaiapp_synthetic');assert.ok(body.get('code_verifier')!.length>=43);assert.equal(body.get('resource'),'https://api.openai.com/v1');return json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id',expires_in:3600,token_type:'Bearer',scope:'openid chatgpt.tokens.use.direct'});}return json({models:[{slug:'model-from-account',display_name:'Account model',visibility:'list'}]});}
  });
  try{await auth.start();const url=new URL(opened);assert.equal(url.origin,'https://auth.openai.com');assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('agent_name_hint'),'SkillHarbor');
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state','wrong');callback.searchParams.set('code','synthetic-code');callback.searchParams.set('client_id','oaiapp_synthetic');assert.equal((await fetch(callback)).status,400);assert.equal(exchanges,0);assert.equal(accounts.length,0);
    callback.searchParams.set('state',url.searchParams.get('state')!);const result=await fetch(callback);assert.equal(result.status,200);await done;assert.equal(accounts[0].clientId,'oaiapp_synthetic');assert.equal(auth.options()[0].billing,'plan');assert.equal(auth.options()[0].ready,true);assert.ok(!JSON.stringify(auth.options()).includes('synthetic-access'));assert.equal(exchanges,1);
  }finally{auth.close();}
});
test('ID tokens must verify issuer, signature, audience, expiry and nonce',async()=>{
  const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='fixture-key';const keys=createLocalJWKSet({keys:[jwk]});
  const token=await new SignJWT({nonce:'right-nonce'}).setProtectedHeader({alg:'RS256',kid:'fixture-key'}).setIssuer('https://auth.openai.com').setAudience('issued-client').setSubject('user').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  assert.equal((await verifyPlanIdentity(token,'issued-client','right-nonce',keys)).sub,'user');await assert.rejects(verifyPlanIdentity(token,'another-client','right-nonce',keys));await assert.rejects(verifyPlanIdentity(token,'issued-client','wrong-nonce',keys));
});
test('account mismatch and absent plan scopes cannot replace saved credentials',async()=>{
  const original:PlanAccount={id:'saved',clientId:'oaiapp_saved',subject:'original-user',label:'saved account',accessToken:'old-token',idToken:'hint',expiresAt:0,scopes:['chatgpt.tokens.use.direct'],models:[]};let accounts=[original];let opened='';
  const auth=new PlanAuth({read:()=>structuredClone(accounts),write:a=>{accounts=a;}},'host',async url=>{opened=url;},()=>{},{verify:async()=>({sub:'different-user'}),fetch:async()=>json({access_token:'new-token',id_token:'new-id',expires_in:3600,token_type:'Bearer',scope:'openid chatgpt.tokens.use.direct'})});
  try{await auth.start('saved');const query=new URL(opened);assert.equal(query.searchParams.get('client_id'),'oaiapp_saved');assert.equal(query.searchParams.has('agent_name_hint'),false);const callback=new URL(query.searchParams.get('redirect_uri')!);callback.searchParams.set('state',query.searchParams.get('state')!);callback.searchParams.set('code','fake');assert.equal((await fetch(callback)).status,400);assert.equal(accounts[0].accessToken,'old-token');assert.equal(auth.state.status,'error');}finally{auth.close();}
});
test('Responses streams require completion and propagate late subscription-limit failures',async()=>{
  const stream=(events:unknown[])=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''));
  assert.equal(await readResponsesStream(stream([{type:'response.output_text.delta',delta:'{"episodes":[]}'},{type:'response.completed'}])),'{"episodes":[]}');
  await assert.rejects(readResponsesStream(stream([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}])));
  await assert.rejects(readResponsesStream(stream([{type:'response.output_text.delta',delta:'partial'}])));
});
test('missing direct-plan permission rejects authorization; catalog failure preserves verified credentials',async()=>{
  for(const hasScope of [false,true]){
    let accounts:PlanAccount[]=[];let opened='';let catalogWorks=false;
    const auth=new PlanAuth({read:()=>structuredClone(accounts),write:a=>{accounts=structuredClone(a);}},'fixture',async url=>{opened=url;},()=>{},{verify:async()=>({sub:'fixture'}),fetch:async(url)=>String(url).endsWith('/oauth/token')?json({access_token:'fixture-access',refresh_token:'fixture-refresh',id_token:'fixture-id',token_type:'Bearer',expires_in:3600,scope:hasScope?'chatgpt.tokens.use.direct':'openid'}):catalogWorks?json({models:[{slug:'fixture-model',visibility:'list'}]}):json({},503)});
    try{await auth.start();const u=new URL(opened),callback=new URL(u.searchParams.get('redirect_uri')!);callback.searchParams.set('state',u.searchParams.get('state')!);callback.searchParams.set('code','fixture');callback.searchParams.set('client_id','issued-fixture');assert.equal((await fetch(callback)).status,hasScope?200:400);assert.equal(accounts.length,hasScope?1:0);if(hasScope){assert.equal(auth.options()[0].ready,false);catalogWorks=true;await auth.refreshCatalog(accounts[0].id);assert.equal(auth.options()[0].ready,true);}}finally{auth.close();}
  }
});
test('cancelling during token exchange cannot save credentials or revive a closed authorization',async()=>{
  let opened='';let accounts:PlanAccount[]=[];let release!:()=>void;let started!:()=>void;const waiting=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>started=r);
  const auth=new PlanAuth({read:()=>accounts,write:a=>{accounts=a;}},'fixture',async url=>{opened=url;},()=>{},{verify:async()=>({sub:'fixture'}),fetch:async()=>{started();await waiting;return json({access_token:'fixture',id_token:'fixture',token_type:'Bearer',expires_in:3600,scope:'chatgpt.tokens.use.direct'});}});
  try{await auth.start();const u=new URL(opened),callback=new URL(u.searchParams.get('redirect_uri')!);callback.searchParams.set('state',u.searchParams.get('state')!);callback.searchParams.set('code','fixture');callback.searchParams.set('client_id','issued-fixture');const result=fetch(callback);await entered;auth.cancel();release();assert.equal((await result).status,400);assert.equal(accounts.length,0);assert.equal(auth.state.status,'idle');}finally{release?.();auth.close();}
});
test('Gemini uses stdin, disables tools, hooks and extensions, and does not inherit API credentials',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-cli-fixture-'));const entry=path.join(dir,'mock.cjs');await writeFile(entry,`const fs=require('node:fs');let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const config=JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH));process.stdout.write(JSON.stringify({response:JSON.stringify({input:text,args:process.argv.slice(2),config,inheritedKey:!!process.env.OPENAI_API_KEY})}));});`);
  const store=new Store(path.join(dir,'data'));const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-secret';
  try{const option={id:'fixture',kind:'gemini-cli' as const,title:'Gemini',detail:'synthetic CLI fixture',ready:true,status:'authenticated' as const,privacy:'remote' as const,consentIdentity:'fixture'};const transport=memberTransport({executable:process.execPath,prefix:[entry],option},{...store.settings(),generationConsentIdentity:'fixture'});const output=JSON.parse(await transport.complete('task','non-sensitive-fixture',new AbortController().signal,{type:'object'}));assert.match(output.input,/non-sensitive-fixture/);assert.equal(output.args.includes('non-sensitive-fixture'),false);assert.equal(output.config.hooksConfig.enabled,false);assert.equal(output.config.admin.mcp.enabled,false);assert.equal(output.config.admin.extensions.enabled,false);assert.deepEqual(output.config.tools.core,[]);assert.equal(output.inheritedKey,false);}finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;store.close();}
});
test('protected local vault contains no plaintext tokens and erases credentials',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-plan-vault-'));const key=randomBytes(32),iv=randomBytes(12);
  const vault=encryptedPlanVault(dir,{available:()=>true,encrypt:text=>{const c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([c.update(text),c.final(),c.getAuthTag()]);},decrypt:bytes=>{const d=createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(bytes.subarray(-16));return Buffer.concat([d.update(bytes.subarray(0,-16)),d.final()]).toString();}});
  const record:PlanAccount={id:'fixture',clientId:'client',subject:'subject',label:'account',accessToken:'private-fixture-token',expiresAt:1000,scopes:[],models:[]};vault.write([record]);assert.equal(vault.read()[0].accessToken,'private-fixture-token');assert.ok(!(await readFile(path.join(dir,'plan-accounts.bin'))).includes(Buffer.from('private-fixture-token')));vault.erase();assert.deepEqual(vault.read(),[]);
});
test('localhost alone does not establish local model execution',async()=>{
  assert.equal(await verifyOllamaModel('model-cloud',async()=>{throw new Error('should not be probed');}),false);
  assert.equal(await verifyOllamaModel('model',async()=>json({remote_model:'cloud-model',model_info:{parameter_count:1},modelfile:'FROM /blobs/sha256-fixture'})),false);
  assert.equal(await verifyOllamaModel('model',async()=>json({model_info:{parameter_count:100},modelfile:'FROM /blobs/sha256-fixture'})),true);
  assert.equal(await verifyOllamaModel('model',async()=>json({model_info:{}})),false);
});
test('production model-required flow never presents rule extraction as AI-generated skills',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'skillharbor-require-ai-'));const store=new Store(dir);const collector:Collector=async function*(){yield {type:'conversation',conversation:demoConversations()[0]};};
  try{const pipeline=new Pipeline(store,null,()=>{},()=>'',collector,{requireModel:true});pipeline.start({sources:['chatgpt']});await pipeline.wait();assert.equal(store.stats().conversations,1);assert.equal(store.skills().length,0);assert.equal(pipeline.run!.modelCalls,0);assert.ok(pipeline.run!.pendingAnalysis);assert.match(pipeline.run!.warnings.join('\n'),/尚未进行 AI 生成/);}finally{store.close();}
});
