import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BrowserConnection, CollectionOptions, CollectorEvent, Conversation, SourceAvailability, SourceId } from '../shared/types';
import { SOURCE_IDS, SOURCE_NAMES, WEB_SOURCES } from '../shared/types';
import type { Store } from './store';
import { hash } from './util';

const messageSchema=z.object({id:z.string().max(300),role:z.enum(['user','assistant','system','tool']),text:z.string().max(8_000_000),timestamp:z.string().max(100).optional(),toolName:z.string().max(300).optional(),artifactRefs:z.array(z.string().max(2000)).max(500).optional()});
export const conversationSchema=z.object({source:z.enum(SOURCE_IDS),externalId:z.string().min(1).max(500),title:z.string().max(2000),createdAt:z.string().max(100).optional(),updatedAt:z.string().max(100).optional(),url:z.string().max(3000).optional(),messages:z.array(messageSchema).max(100000),completeness:z.enum(['full','partial','unknown']),warnings:z.array(z.string().max(2000)).max(1000).default([]),locator:z.string().max(1000).optional()});
interface Command {id:string;client:string;source:SourceId;action?:'open';dateFrom?:string;dateTo?:string;cursor?:string;events:BridgeEvent[];lastEvent:number;done:boolean}
interface BridgeEvent {commandId:string;source:SourceId;type:string;conversation?:Conversation;discovered?:number;imported?:number;skipped?:number;failed?:number;detail?:string;message?:string;cursor?:string;coverage?:'full'|'partial'|'unknown'}
const eventSchema=z.object({commandId:z.string().max(100),source:z.enum(SOURCE_IDS),type:z.enum(['conversation','progress','warning','checkpoint','done','error']),conversation:conversationSchema.optional(),discovered:z.number().int().min(0).optional(),imported:z.number().int().min(0).optional(),skipped:z.number().int().min(0).optional(),failed:z.number().int().min(0).optional(),detail:z.string().max(2000).optional(),message:z.string().max(2000).optional(),cursor:z.string().max(64000).optional(),coverage:z.enum(['full','partial','unknown']).optional()});

export class BrowserBridge {
  private server?:Server;
  private commands=new Map<string,Command>();
  private cancelled=new Map<string,string>();
  private clients=new Map<string,number>();
  private statuses=new Map<string,Map<SourceId,SourceAvailability>>();
  private code=String(randomInt(10000000,99999999));
  private codeExpires=Date.now()+600000;
  private pairAttempts:number[]=[];
  private changed=()=>{};
  port=42837;
  constructor(private store:Store) {}
  setListener(cb:()=>void):void {this.changed=cb;}
  private selected():string {return this.store.getMeta<string>('selectedBridgeClient','');}
  info():BrowserConnection {
    const selected=this.selected();const names=this.store.getMeta<Record<string,string>>('bridgeClientNames',{});
    const clients=this.store.getMeta<string[]>('bridgeClients',[]).map(id=>({id,name:names[id]||`Browser · ${id.slice(0,6)}`,online:Date.now()-(this.clients.get(id)||0)<35000}));
    return {port:this.port,paired:!!clients.find(client=>client.id===selected)?.online,pairingCode:this.code,clients,selectedClientId:selected};
  }
  selectClient(id:string):void {
    if(!this.store.getMeta<string[]>('bridgeClients',[]).includes(id))throw new Error('Unknown browser / 未找到此浏览器');
    if([...this.commands.values()].some(command=>!command.done&&!command.action))throw new Error('Finish collection before changing browser / 请先结束采集');
    this.store.setMeta('selectedBridgeClient',id);this.changed();
  }
  openSource(source:SourceId):void {
    if(!WEB_SOURCES.includes(source)||!this.info().paired)throw new Error('Connect the selected browser first / 请先连接所选浏览器');
    const id=randomBytes(12).toString('hex');this.commands.set(id,{id,client:this.selected(),source,action:'open',events:[],lastEvent:Date.now(),done:false});
  }
  rotateCode():string {this.code=String(randomInt(10000000,99999999));this.codeExpires=Date.now()+600000;return this.code;}
  revoke():void {this.store.setMeta('bridgeClients',[]);this.store.setMeta('bridgeClientNames',{});this.store.setMeta('selectedBridgeClient','');this.clients.clear();this.statuses.clear();this.rotateCode();this.changed();}
  sourceStatuses():SourceAvailability[] {
    const alive=this.info().paired;const statuses=this.statuses.get(this.selected());
    return WEB_SOURCES.map(id=>alive&&statuses?.has(id)?statuses.get(id)!:{id,title:SOURCE_NAMES[id],kind:'web',available:false,connected:false,mode:'import',authorization:'unknown',detail:'连接所选浏览器扩展后检测登录状态。 / Connect the selected browser to check website sign-in.'});
  }
  async start(port=42837):Promise<void> {
    this.port=port;
    this.server=createServer((req,res)=>{void this.handle(req,res);});
    await new Promise<void>((resolve,reject)=>{this.server!.once('error',reject);this.server!.listen(port,'127.0.0.1',()=>{this.port=(this.server!.address() as {port:number}).port;resolve();});});
  }
  async close():Promise<void> {for(const c of this.commands.values())c.done=true;await new Promise<void>(resolve=>this.server?this.server.close(()=>resolve()):resolve());}
  private reply(res:ServerResponse,status:number,value:unknown,origin?:string):void {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(origin?{'Access-Control-Allow-Origin':origin,'Vary':'Origin'}:{})});res.end(JSON.stringify(value));
  }
  private async body(req:IncomingMessage):Promise<unknown> {
    let length=0;const chunks:Buffer[]=[];
    for await(const chunk of req){length+=chunk.length;if(length>12*1024*1024)throw new Error('Body too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private token(req:IncomingMessage):string|null {
    const bearer=req.headers.authorization;
    if(!bearer?.startsWith('Bearer '))return null;
    const key=hash(bearer.slice(7));
    const clients=this.store.getMeta<string[]>('bridgeClients',[]);
    if(!clients.includes(key))return null;
    this.clients.set(key,Date.now());return key;
  }
  private async handle(req:IncomingMessage,res:ServerResponse):Promise<void> {
    const origin=req.headers.origin||'';
    const allowed=/^chrome-extension:\/\/[a-p]{32}$/.test(origin)||!origin&&req.headers['x-skillharbor-client']==='extension';
    if(req.headers.host!==`127.0.0.1:${this.port}`||!allowed){this.reply(res,403,{error:'Forbidden'});return;}
    if(req.method==='OPTIONS') {res.writeHead(204,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type, X-SkillHarbor-Client','Access-Control-Max-Age':'600','Vary':'Origin'});res.end();return;}
    req.setTimeout(15000,()=>req.destroy());
    try {
      if(req.url==='/pair'&&req.method==='POST') {
        this.pairAttempts=this.pairAttempts.filter(t=>Date.now()-t<60000);
        if(this.pairAttempts.length>=5){this.reply(res,429,{error:'Try again in a minute'},origin);return;}
        this.pairAttempts.push(Date.now());
        const data=z.object({code:z.string().max(20),clientName:z.string().max(100).optional()}).parse(await this.body(req));
        const received=Buffer.from(data.code),expected=Buffer.from(this.code);
        if(Date.now()>this.codeExpires||received.length!==expected.length||!timingSafeEqual(received,expected)){this.reply(res,401,{error:'Pairing code invalid or expired'},origin);return;}
        const token=randomBytes(32).toString('hex');const clients=this.store.getMeta<string[]>('bridgeClients',[]);
        const key=hash(token);this.store.setMeta('bridgeClients',[...clients.slice(-4),key]);this.clients.set(key,Date.now());
        const names=this.store.getMeta<Record<string,string>>('bridgeClientNames',{});names[key]=data.clientName||`Browser · ${key.slice(0,6)}`;this.store.setMeta('bridgeClientNames',names);
        if(!this.selected())this.store.setMeta('selectedBridgeClient',key);
        this.rotateCode();this.changed();
        this.reply(res,200,{token},origin);return;
      }
      const client=this.token(req);if(!client){this.reply(res,401,{error:'Pairing required'},origin);return;}
      if(req.url==='/commands'&&req.method==='GET') {
        // A healthy extension may queue later sources behind a large first source.
        // Authenticated polling keeps those queued commands alive without inventing collection progress.
        for(const command of this.commands.values())if(!command.done&&command.client===client)command.lastEvent=Date.now();
        this.reply(res,200,{commands:[...this.commands.values()].filter(c=>!c.done&&c.client===client).map(({id,source,action,dateFrom,dateTo,cursor})=>({id,source,action,dateFrom,dateTo,cursor})),cancelled:[...this.cancelled].filter(([,owner])=>owner===client).map(([id])=>id).slice(-100)},origin);return;
      }
      if(req.url==='/status'&&req.method==='POST') {
        const schema=z.object({clientName:z.string().max(100).optional(),sources:z.array(z.object({id:z.enum(SOURCE_IDS),available:z.boolean(),connected:z.boolean(),mode:z.enum(['automatic','limited','import']),authorization:z.enum(['permission','login','ready','unknown']).optional(),detail:z.string().max(2000)})).max(10)});
        const data=schema.parse(await this.body(req));
        if(!this.statuses.has(client))this.statuses.set(client,new Map());
        for(const status of data.sources)if(WEB_SOURCES.includes(status.id))this.statuses.get(client)!.set(status.id,{...status,title:SOURCE_NAMES[status.id],kind:'web'});
        if(data.clientName){const names=this.store.getMeta<Record<string,string>>('bridgeClientNames',{});if(names[client]!==data.clientName){names[client]=data.clientName;this.store.setMeta('bridgeClientNames',names);}}
        this.changed();this.reply(res,200,{ok:true},origin);return;
      }
      if(req.url==='/events'&&req.method==='POST') {
        const event=eventSchema.parse(await this.body(req)) as BridgeEvent;
        const command=this.commands.get(event.commandId);
        if(!command||command.done||command.client!==client||command.source!==event.source||event.conversation&&event.conversation.source!==command.source){this.reply(res,409,{error:'No matching active collection'},origin);return;}
        if(command.action){if(!['done','error'].includes(event.type)){this.reply(res,409,{error:'Not a collection command'},origin);return;}this.commands.delete(command.id);this.changed();this.reply(res,200,{ok:true},origin);return;}
        if(command.events.length>100){this.reply(res,429,{error:'Consumer busy, retry'},origin);return;}
        if(event.type==='conversation'&&!event.conversation){this.reply(res,400,{error:'Conversation required'},origin);return;}
        command.events.push(event);command.lastEvent=Date.now();
        if(event.type==='checkpoint'&&event.cursor)command.cursor=event.cursor;
        this.reply(res,200,{ok:true},origin);return;
      }
      this.reply(res,404,{error:'Not found'},origin);
    }catch{this.reply(res,400,{error:'Invalid request'},origin);}
  }
  async *collect(source:SourceId,options:CollectionOptions):AsyncGenerator<CollectorEvent> {
    if(!this.info().paired)throw new Error('Pair browser extension first');
    const id=randomBytes(12).toString('hex');const command:Command={id,client:this.selected(),source,dateFrom:options.dateFrom,dateTo:options.dateTo,cursor:options.cursor,events:[],lastEvent:Date.now(),done:false};this.commands.set(id,command);
    try {
      while(!command.done) {
        options.signal.throwIfAborted();
        const event=command.events.shift();
        if(!event) {
          if(Date.now()-command.lastEvent>120000)throw new Error('Browser collector disconnected; resume after reconnecting');
          await new Promise<void>(resolve=>{const timer=setTimeout(resolve,100);timer.unref?.();});continue;
        }
        if(event.type==='done') {
          command.done=true;
          if(event.coverage!=='full')yield {type:'warning',message:`${SOURCE_NAMES[source]}: partial or unknown history coverage / 历史范围为部分或未知`};
        }else if(event.type==='error') {throw new Error('Browser collection failed; check the platform tab and retry');}
        else if(event.type==='conversation'&&event.conversation)yield {type:'conversation',conversation:event.conversation};
        else if(event.type==='progress')yield {type:'progress',discovered:event.discovered,skipped:event.skipped,failed:event.failed,detail:event.detail};
        else if(event.type==='checkpoint'&&event.cursor)yield {type:'checkpoint',cursor:event.cursor};
        else if(event.type==='warning')yield {type:'warning',message:event.message||event.detail||'Partial history / 部分历史'};
      }
    }finally{command.done=true;this.cancelled.set(id,command.client);if(this.cancelled.size>500)this.cancelled.delete(this.cancelled.keys().next().value!);this.commands.delete(id);}
  }
}
