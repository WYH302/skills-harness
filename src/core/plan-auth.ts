import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { GenerationOption, Settings } from '../shared/types';
import type { ModelTransport } from './mining';
import { hash } from './util';

const ISSUER='https://auth.openai.com';const RESOURCE='https://api.openai.com/v1';
const TOKEN=ISSUER+'/api/accounts/oauth/token';const SCOPE='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const JWKS=createRemoteJWKSet(new URL(ISSUER+'/.well-known/jwks.json'));
export interface PlanAccount {id:string;clientId:string;subject:string;email?:string;label:string;accessToken?:string;refreshToken?:string;idToken?:string;expiresAt:number;scopes:string[];models:{slug:string;name:string}[]}
export interface PlanVault {read:()=>PlanAccount[];write:(accounts:PlanAccount[])=>void}
export interface PlanAuthState {status:'idle'|'waiting'|'connected'|'error';message:string}
interface Pending {state:string;nonce:string;verifier:string;redirect:string;account?:PlanAccount;used:boolean}
export interface PlanAuthDependencies {fetch?:typeof fetch;verify?:(token:string,clientId:string,nonce:string)=>Promise<JWTPayload>;timeoutMs?:number}
const opaque=()=>randomBytes(32).toString('base64url');
function equal(a:string,b:string):boolean {const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export async function verifyPlanIdentity(token:string,clientId:string,nonce:string,keySet:JWTVerifyGetKey=JWKS):Promise<JWTPayload>{
  const {payload}=await jwtVerify(token,keySet,{issuer:ISSUER,audience:clientId,algorithms:['RS256'],requiredClaims:['sub','exp','iat','nonce'],clockTolerance:10});
  if(payload.nonce!==nonce)throw new Error('Invalid account authorization');return payload;
}
export class PlanAuth {
  state:PlanAuthState={status:'idle',message:''};private server?:Server;private timer?:ReturnType<typeof setTimeout>;private pending?:Pending;
  private refreshing=new Map<string,Promise<PlanAccount>>();private http:typeof fetch;private verify:NonNullable<PlanAuthDependencies['verify']>;
  constructor(private vault:PlanVault,readonly hostId:string,private open:(url:string)=>Promise<unknown>,private notify:()=>void,private deps:PlanAuthDependencies={}){this.http=deps.fetch||fetch;this.verify=deps.verify||verifyPlanIdentity;}
  private status(status:PlanAuthState['status'],message:string){this.state={status,message};this.notify();}
  options():GenerationOption[]{
    const accounts=this.vault.read();return accounts.map(a=>({id:'chatgpt-plan:'+a.id,title:'ChatGPT',kind:'chatgpt-plan',brand:'chatgpt',channel:'membership',billing:'plan',accountLabel:a.label,ready:!!a.accessToken&&a.scopes.includes('chatgpt.tokens.use.direct')&&a.models.length>0,status:a.accessToken?a.models.length?'authenticated':'error':'login',detail:a.accessToken&&!a.models.length?'账号已授权，暂未取得可用模型，请重新读取模型。 / Account authorized; reload the model catalog.':'通过官方账号授权使用套餐额度；历史采集另行连接。 / Official ChatGPT plan authorization; history collection is separate.',privacy:'remote',consentIdentity:hash(['chatgpt-plan',a.id,a.clientId,a.subject]),authMode:'subscription',model:a.models[0]?.slug}));
  }
  async start(accountId?:string):Promise<void>{
    if(this.pending)throw new Error('Authorization already in progress / 正在等待官方授权');
    const account=accountId?this.vault.read().find(a=>a.id===accountId):undefined;if(accountId&&!account)throw new Error('Account not found');
    const state=opaque(),nonce=opaque(),verifier=opaque();const server=createServer((req,res)=>{
      void (async()=>{
        const p=this.pending;const expected=p?new URL(p.redirect):undefined;
        if(!p||req.method!=='GET'||req.headers.host!==expected?.host){res.writeHead(400);res.end('Invalid callback');return;}
        const u=new URL(req.url||'/',p.redirect);
        if(u.pathname!=='/auth/callback'){res.writeHead(404);res.end();return;}
        if(p.used||u.searchParams.getAll('state').length!==1||!equal(u.searchParams.get('state')||'',p.state)){res.writeHead(400);res.end('Invalid authorization state');return;}
        p.used=true;
        try{await this.accept(u,p);res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'"});res.end('<meta charset="utf-8"><title>SkillHarbor</title><p>授权完成，请返回 SkillHarbor。 Authorization complete. Return to SkillHarbor.</p>');if(this.pending===p)this.status('connected','ChatGPT 授权已完成，可选择账号生成。 / ChatGPT connected. Choose the account to generate.');}
        catch{res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end('授权未完成，请返回软件重试。 Authorization not completed. Return to the app.');if(this.pending===p)this.status('error','官方授权未完成或未开放套餐权限，请重试。 / Authorization incomplete or plan permission unavailable. Please try again.');}
        finally{if(this.pending===p)this.close();}
      })().catch(()=>{res.writeHead(400);res.end('Authorization failed');this.close();});
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    this.server=server;const port=(server.address() as {port:number}).port;
    this.pending={state,nonce,verifier,redirect:`http://127.0.0.1:${port}/auth/callback`,account,used:false};
    const url=new URL(ISSUER+'/api/accounts/authorize');const params:Record<string,string>={client_id:account?.clientId||'dynamic_agent_client',ext_agent_host_id:this.hostId,response_type:'code',redirect_uri:this.pending.redirect,scope:SCOPE,resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
    if(!account)params.agent_name_hint='SkillHarbor';else if(account.idToken)params.id_token_hint=account.idToken;
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
    this.timer=setTimeout(()=>{this.status('error','授权等待已超时，请重新连接。 / Authorization timed out; connect again.');this.close();},this.deps.timeoutMs||300000);this.timer.unref();
    this.status('waiting','请在官方网页完成授权，完成后自动返回。 / Complete authorization in the official browser page.');
    try{await this.open(url.href);}catch{this.close();this.status('error','未能打开官方授权页面。 / Could not open the authorization page.');}
  }
  private async token(body:Record<string,string>):Promise<any>{
    const response=await this.http(TOKEN,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,resource:RESOURCE})});
    if(!response.ok)throw new Error('Account authorization expired / 账号授权已失效，请重新连接');return response.json();
  }
  private async accept(url:URL,p:Pending):Promise<void>{
    if(url.searchParams.has('error'))throw new Error('Authorization declined');
    const code=url.searchParams.get('code');const supplied=url.searchParams.get('client_id');const clientId=p.account?.clientId||supplied;
    if(!code||url.searchParams.getAll('code').length!==1||!clientId||clientId==='dynamic_agent_client'||clientId.length>300||supplied&&p.account&&supplied!==p.account.clientId)throw new Error('Invalid registration');
    const data=await this.token({grant_type:'authorization_code',client_id:clientId,code,code_verifier:p.verifier,redirect_uri:p.redirect});
    if(typeof data.id_token!=='string'||typeof data.access_token!=='string'||data.token_type?.toLowerCase()!=='bearer'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new Error('Invalid token response');
    const identity=await this.verify(data.id_token,clientId,p.nonce);
    if(!identity.sub||p.account&&identity.sub!==p.account.subject)throw new Error('Account changed');
    const scopes=typeof data.scope==='string'?data.scope.split(/\s+/):[];if(!scopes.includes('chatgpt.tokens.use.direct'))throw new Error('Plan permission required');
    const account:PlanAccount={id:p.account?.id||hash([clientId,identity.sub]).slice(0,24),clientId,subject:identity.sub,email:typeof identity.email==='string'?identity.email:undefined,label:typeof identity.email==='string'?identity.email:`ChatGPT ${clientId.slice(-6)}`,accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:undefined,idToken:data.id_token,expiresAt:Date.now()+Math.min(data.expires_in,86400)*1000,scopes,models:[]};
    // A temporary model-catalog failure must not discard an already verified
    // authorization or force the user through a second registration.
    try{account.models=await this.models(account.accessToken!);}catch{}
    if(this.pending!==p)throw new Error('Authorization cancelled');const all=this.vault.read();this.vault.write([...all.filter(a=>a.id!==account.id),account]);
  }
  private async models(accessToken:string):Promise<PlanAccount['models']>{
    const r=await this.http(RESOURCE+'/models',{headers:{Authorization:`Bearer ${accessToken}`},redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Model catalog unavailable');
    const data=await r.json() as {models?:{slug?:string;display_name?:string;visibility?:string}[]};
    return (data.models||[]).filter(m=>m.visibility==='list'&&typeof m.slug==='string'&&m.slug.length<300).slice(0,100).map(m=>({slug:m.slug!,name:m.display_name||m.slug!}));
  }
  async refreshCatalog(id:string):Promise<void>{const account=await this.account(id);const models=await this.models(account.accessToken!);this.vault.write(this.vault.read().map(a=>a.id===id&&a.accessToken===account.accessToken?{...a,models}:a));this.notify();}
  private async account(id:string):Promise<PlanAccount>{
    const saved=this.vault.read().find(a=>a.id===id);if(!saved?.accessToken||!saved.scopes.includes('chatgpt.tokens.use.direct'))throw new Error('Reconnect your ChatGPT account / 请重新连接 ChatGPT 账号');
    if(saved.expiresAt>Date.now()+60000)return saved;
    if(!this.refreshing.has(id))this.refreshing.set(id,(async()=>{
      if(!saved.refreshToken)throw new Error('Reconnect your ChatGPT account / 请重新连接 ChatGPT 账号');
      const data=await this.token({grant_type:'refresh_token',client_id:saved.clientId,refresh_token:saved.refreshToken});
      if(typeof data.access_token!=='string'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new Error('Reconnect your ChatGPT account');
      const scopes=typeof data.scope==='string'?data.scope.split(/\s+/):saved.scopes;if(!scopes.includes('chatgpt.tokens.use.direct'))throw new Error('Plan permission revoked');
      if(this.vault.read().find(a=>a.id===id)?.accessToken!==saved.accessToken)throw new Error('Account changed during refresh');const next={...saved,accessToken:data.access_token,refreshToken:typeof data.refresh_token==='string'?data.refresh_token:saved.refreshToken,expiresAt:Date.now()+Math.min(data.expires_in,86400)*1000,scopes};
      this.vault.write(this.vault.read().map(a=>a.id===id?next:a));return next;
    })().finally(()=>this.refreshing.delete(id)));
    return this.refreshing.get(id)!;
  }
  transport(settings:Settings):ModelTransport {
    const id=settings.generatorId?.replace(/^chatgpt-plan:/,'');const option=this.options().find(o=>o.id===settings.generatorId);
    if(!id||!option||settings.generationConsentIdentity!==option.consentIdentity)throw new Error('Confirm use of this ChatGPT account before sending / 请先确认使用此 ChatGPT 账号');
    const body=(system:string,content:string,schema:unknown)=>JSON.stringify({model:settings.model||option.model,instructions:system,input:content,store:false,stream:true,max_output_tokens:settings.maxOutputTokens,text:{format:{type:'json_schema',name:'skillharbor_episodes',strict:true,schema}}});
    return {id:option.consentIdentity,estimateInput:(system,content,schema)=>body(system,content,schema).length,complete:async(system,content,signal,schema)=>{
      const account=await this.account(id);if(!account.models.some(m=>m.slug===(settings.model||option.model)))throw new Error('Choose a model available to this account');
      const r=await this.http(RESOURCE+'/responses',{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(180000)]),headers:{Authorization:`Bearer ${account.accessToken}`,'Content-Type':'application/json'},body:body(system,content,schema)});
      if(!r.ok)throw new Error(r.status===429?'套餐额度不足，进度已保存；不会自动改用付费 API。 / Plan limit reached; progress saved.':'ChatGPT 暂不可用，请检查授权，进度已保存。 / ChatGPT unavailable; check authorization.');
      return readResponsesStream(r);
    }};
  }
  async signOut(id:string):Promise<boolean>{
    const account=this.vault.read().find(a=>a.id===id);if(!account)return true;let revoked=!account.refreshToken;
    if(account.refreshToken)try{const r=await this.http(ISSUER+'/api/accounts/oauth/revoke',{method:'POST',redirect:'error',signal:AbortSignal.timeout(12000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:account.refreshToken,token_type_hint:'refresh_token',client_id:account.clientId})});revoked=r.status===200;}catch{}
    this.vault.write(this.vault.read().map(a=>a.id===id?{...a,accessToken:undefined,refreshToken:undefined,idToken:undefined,expiresAt:0,models:[]}:a));this.notify();return revoked;
  }
  cancel(){this.close();this.status('idle','');}
  close(){if(this.timer)clearTimeout(this.timer);this.timer=undefined;this.pending=undefined;this.server?.close();this.server=undefined;}
}
export async function readResponsesStream(response:Response):Promise<string>{
  if(!response.body)throw new Error('No response stream');const reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',text='',complete=false,bytes=0;
  const consume=(event:string)=>{const payload=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!payload||payload==='[DONE]')return;
    const data=JSON.parse(payload);if(data.type==='response.output_text.delta'&&typeof data.delta==='string')text+=data.delta;
    if(['response.failed','response.incomplete','error'].includes(data.type))throw new Error('ChatGPT generation interrupted or quota unavailable / 生成中断或套餐额度不足，进度已保存');
    if(data.type==='response.completed'){complete=true;if(!text)text=(data.response?.output||[]).flatMap((o:any)=>o.content||[]).filter((c:any)=>c.type==='output_text').map((c:any)=>c.text).join('');}
  };
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>6000000)throw new Error('Response exceeds limit');buffer+=(decoder.decode(value,{stream:true})).replace(/\r/g,'');let index;while((index=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,index));buffer=buffer.slice(index+2);}}buffer+=decoder.decode();if(buffer.trim())consume(buffer);if(!complete)throw new Error('Response did not complete / 模型响应未完成，进度已保存');return text;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
