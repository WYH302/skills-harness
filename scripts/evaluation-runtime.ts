import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelTransport } from '../src/core/mining';
import { hash } from '../src/core/util';

export interface EvaluationCall {key:string;stage:string;status:'reserved'|'completed'|'failed';inputChars:number;outputChars:number;startedAt:string;finishedAt?:string}
export class EvaluationLedger {
  readonly entries:EvaluationCall[];
  stage='generation';cacheHits=0;
  constructor(readonly directory:string,readonly maxCalls:number,readonly maxChars:number,readonly live:boolean,private upstream?:ModelTransport){
    mkdirSync(path.join(directory,'responses'),{recursive:true});
    this.entries=existsSync(this.filename)?JSON.parse(readFileSync(this.filename,'utf8')).entries:[];
  }
  private get filename(){return path.join(this.directory,'usage.json');}
  private persist(){const temporary=this.filename+'.tmp';writeFileSync(temporary,JSON.stringify({maxCalls:this.maxCalls,maxInputChars:this.maxChars,entries:this.entries},null,2)+'\n');renameSync(temporary,this.filename);}
  transport:ModelTransport={id:'public-transfer-pilot-v1',estimateInput:(system,content,schema)=>{
    const key=hash([this.transport.id,system,content,schema]);
    const recorded=this.entries.find(e=>e.key===key);
    return recorded?.inputChars??this.upstream?.estimateInput?.(system,content,schema)??system.length+content.length+JSON.stringify(schema).length;
  },complete:async(system,content,signal,schema)=>{
    const key=hash([this.transport.id,system,content,schema]);const file=path.join(this.directory,'responses',key+'.json');
    if(existsSync(file)){this.cacheHits++;return JSON.parse(readFileSync(file,'utf8')).raw;}
    if(!this.live||!this.upstream)throw new Error('Uncached inference requires --live; replay did not make a model call.');
    signal.throwIfAborted();
    const inputChars=this.upstream.estimateInput?.(system,content,schema)??system.length+content.length+JSON.stringify(schema).length;
    if(this.entries.length>=this.maxCalls||this.entries.reduce((n,e)=>n+e.inputChars,0)+inputChars>this.maxChars)throw new Error('Public pilot cumulative budget reached; saved responses can be replayed.');
    const entry:EvaluationCall={key,stage:this.stage,status:'reserved',inputChars,outputChars:0,startedAt:new Date().toISOString()};this.entries.push(entry);this.persist();
    try{const raw=await this.upstream.complete(system,content,signal,schema);const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify({key,raw})+'\n');renameSync(temporary,file);entry.status='completed';entry.outputChars=raw.length;return raw;}
    catch(error){entry.status='failed';throw error;}
    finally{entry.finishedAt=new Date().toISOString();this.persist();}
  }};
}
