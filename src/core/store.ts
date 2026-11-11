import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import type { Conversation, Episode, Run, Settings, Skill, SkillVersion } from '../shared/types';
import { conversationHash, hash, normalizeConversation, now, transcriptHash } from './util';

export const defaultSettings:Omit<Settings,'dataDir'> = {language:'zh',skillOutputLanguage:'interface',analysisMode:'extractive',model:'',endpoint:'http://127.0.0.1:11434/v1',apiKeySet:false,remoteConsent:false,maxModelCalls:12,maxInputChars:120000,maxOutputTokens:4000,incremental:true,redactSensitive:true,autoConsolidate:true,analysisDetail:'focused',processingStrategy:'representative'};

export class Store {
  readonly db:DatabaseSync;
  private cachedStats:{conversations:number;messages:number;episodes:number;skills:number}|null=null;
  batch<T>(fn:()=>T):T {this.db.exec('SAVEPOINT sp_batch');try{const res=fn();this.db.exec('RELEASE sp_batch');return res;}catch(e){this.db.exec('ROLLBACK TO sp_batch; RELEASE sp_batch');throw e;}}
  constructor(readonly dir:string) {
    mkdirSync(dir,{recursive:true,mode:0o700});
    const filename=path.join(dir,'skillharbor.sqlite');
    this.db=new DatabaseSync(filename);
    try {chmodSync(filename,0o600);} catch { /* Windows ACLs use the user's profile permissions. */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,source TEXT NOT NULL,external_id TEXT NOT NULL,hash TEXT NOT NULL,transcript_hash TEXT NOT NULL,body TEXT NOT NULL,processed_hash TEXT, UNIQUE(source,external_id));
      CREATE INDEX IF NOT EXISTS transcript_idx ON conversations(transcript_hash);
      CREATE TABLE IF NOT EXISTS aliases(source TEXT NOT NULL,external_id TEXT NOT NULL,canonical_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,PRIMARY KEY(source,external_id));
      CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,version INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(skill_id,version));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoints(source TEXT PRIMARY KEY,cursor TEXT NOT NULL);
      PRAGMA user_version=1;`);
    for(const row of this.db.prepare('SELECT id,body FROM runs').all() as {id:string;body:string}[]) {
      const run=JSON.parse(row.body) as Run;
      if(run.status==='running') {run.status='interrupted';run.warnings.push('Application closed; resume will reuse imported records and cached analysis. / 应用曾关闭，可继续处理。');this.saveRun(run);}
    }
  }
  close():void {this.db.close();}
  getMeta<T>(key:string,fallback:T):T {const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value:string}|undefined;return row?JSON.parse(row.value):fallback;}
  setMeta(key:string,value:unknown):void {this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run(key,JSON.stringify(value));}
  settings():Settings {return {...defaultSettings,...this.getMeta<Partial<Settings>>('settings',{}),dataDir:this.dir};}
  saveSettings(settings:Partial<Settings>):Settings {const merged={...this.settings(),...settings,dataDir:this.dir};this.setMeta('settings',merged);return merged;}
  import(input:Conversation):{status:'imported'|'skipped';id:string} {
    const c=normalizeConversation(input);const contentHash=conversationHash(c);
    const old=this.db.prepare('SELECT id,hash FROM conversations WHERE source=? AND external_id=?').get(c.source,c.externalId) as {id:string;hash:string}|undefined;
    if(old?.hash===contentHash) return {status:'skipped',id:old.id};
    const th=transcriptHash(c);this.cachedStats=null;
    const alias=this.db.prepare('SELECT canonical_id FROM aliases WHERE source=? AND external_id=?').get(c.source,c.externalId) as {canonical_id:string}|undefined;
    const duplicate=this.db.prepare('SELECT id FROM conversations WHERE transcript_hash=? AND id<>?').get(th,c.id) as {id:string}|undefined;
    if(duplicate&&!old) {this.db.prepare('INSERT OR REPLACE INTO aliases VALUES(?,?,?)').run(c.source,c.externalId,duplicate.id);return {status:'skipped',id:duplicate.id};}
    if(alias) this.db.prepare('DELETE FROM aliases WHERE source=? AND external_id=?').run(c.source,c.externalId);
    this.db.prepare(`INSERT INTO conversations(id,source,external_id,hash,transcript_hash,body) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,transcript_hash=excluded.transcript_hash,body=excluded.body`).run(c.id,c.source,c.externalId,contentHash,th,JSON.stringify(c));
    return {status:'imported',id:c.id};
  }
  conversation(id:string):Conversation|null {const row=this.db.prepare('SELECT body FROM conversations WHERE id=?').get(id) as {body:string}|undefined;return row?JSON.parse(row.body):null;}
  conversations(onlyPending=false):Conversation[] {const rows=this.db.prepare('SELECT body FROM conversations'+(onlyPending?' WHERE processed_hash IS NULL OR processed_hash<>hash':'')+' ORDER BY rowid').all() as {body:string}[];return rows.map(r=>JSON.parse(r.body));}
  conversationSummaries():unknown[] {return this.db.prepare(`SELECT c.id,c.source,json_extract(c.body,'$.title') AS title,json_extract(c.body,'$.updatedAt') AS updatedAt,json_extract(c.body,'$.completeness') AS completeness,json_array_length(c.body,'$.messages') AS messages,(SELECT count(*) FROM episodes e WHERE e.conversation_id=c.id) AS episodes FROM conversations c ORDER BY c.rowid DESC`).all();}
  pendingIds():string[] {return (this.db.prepare('SELECT id FROM conversations WHERE processed_hash IS NULL OR processed_hash<>hash ORDER BY rowid').all() as {id:string}[]).map(r=>r.id);}
  analysisKey(c:Conversation,modeKey:string):string {return hash([conversationHash(c),modeKey]);}
  cache<T>(key:string):T|undefined {const row=this.db.prepare('SELECT body FROM cache WHERE key=?').get(key) as {body:string}|undefined;return row?JSON.parse(row.body):undefined;}
  putCache(key:string,body:unknown):void {this.db.prepare('INSERT OR REPLACE INTO cache VALUES(?,?)').run(key,JSON.stringify(body));}
  setEpisodes(c:Conversation,episodes:Episode[],markProcessed=true):void {
    this.cachedStats=null;this.db.exec('SAVEPOINT sp_ep');
    try {
      this.db.prepare('DELETE FROM episodes WHERE conversation_id=?').run(c.id!);
      const insert=this.db.prepare('INSERT OR REPLACE INTO episodes VALUES(?,?,?)');
      for(const e of episodes)insert.run(e.id,c.id!,JSON.stringify(e));
      if(markProcessed)this.db.prepare('UPDATE conversations SET processed_hash=hash WHERE id=?').run(c.id!);
      this.db.exec('RELEASE sp_ep');
    } catch(e){this.db.exec('ROLLBACK TO sp_ep; RELEASE sp_ep');throw e;}
  }
  episodes():Episode[] {return (this.db.prepare('SELECT body FROM episodes ORDER BY rowid').all() as {body:string}[]).map(r=>JSON.parse(r.body));}
  episode(id:string):Episode|null {const row=this.db.prepare('SELECT body FROM episodes WHERE id=?').get(id) as {body:string}|undefined;return row?JSON.parse(row.body):null;}
  skills():Skill[] {return (this.db.prepare('SELECT body FROM skills ORDER BY rowid DESC').all() as {body:string}[]).map(r=>JSON.parse(r.body));}
  skill(id:string):Skill {const row=this.db.prepare('SELECT body FROM skills WHERE id=?').get(id) as {body:string}|undefined;if(!row)throw new Error('Skill not found');return JSON.parse(row.body);}
  saveSkill(skill:Skill,reason='generated'):Skill {
    const old=this.db.prepare('SELECT body FROM skills WHERE id=?').get(skill.id) as {body:string}|undefined;
    const previous:Skill|undefined=old?JSON.parse(old.body):undefined;
    const changed=!previous||previous.markdown!==skill.markdown||JSON.stringify(previous.resources||[])!==JSON.stringify(skill.resources||[]);
    const version=changed?(previous?.version||0)+1:previous!.version;
    const next={...skill,version,updatedAt:changed?now():skill.updatedAt};
    this.cachedStats=null;this.db.exec('SAVEPOINT sp_ep');
    try {
      this.db.prepare('INSERT INTO skills VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,body=excluded.body').run(next.id,next.name,JSON.stringify(next));
      if(changed)this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(next.id,version,JSON.stringify({version,markdown:next.markdown,resources:next.resources,createdAt:next.updatedAt,reason}));
      this.db.exec('RELEASE sp_ep');
    }catch(e){this.db.exec('ROLLBACK TO sp_ep; RELEASE sp_ep');throw e;}
    return next;
  }
  versions(id:string):SkillVersion[] {return (this.db.prepare('SELECT body FROM versions WHERE skill_id=? ORDER BY version DESC').all(id) as {body:string}[]).map(r=>JSON.parse(r.body));}
  deleteSkill(id:string):void {this.cachedStats=null;this.db.prepare('DELETE FROM skills WHERE id=?').run(id);}
  saveRun(run:Run):void {this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(run.id,JSON.stringify(run));}
  latestRun():Run|null {const row=this.db.prepare('SELECT body FROM runs ORDER BY rowid DESC LIMIT 1').get() as {body:string}|undefined;return row?JSON.parse(row.body):null;}
  checkpoint(source:string,cursor?:string):string|undefined {if(cursor!==undefined)this.db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?)').run(source,cursor);return (this.db.prepare('SELECT cursor FROM checkpoints WHERE source=?').get(source) as {cursor:string}|undefined)?.cursor;}
  clearCheckpoints():void {this.db.exec('DELETE FROM checkpoints');}
  clearCheckpoint(source:string):void {this.db.prepare('DELETE FROM checkpoints WHERE source=?').run(source);}
  invalidateAnalysis():void {this.cachedStats=null;this.db.exec("UPDATE conversations SET processed_hash=NULL; DELETE FROM meta WHERE key='selectionCorpusSig' OR key='selectionSummaryCache';");}
  forget(scope:'history'|'derived'|'skills'|'all'):void {
    this.cachedStats=null;this.db.exec('SAVEPOINT sp_ep');
    try {
      if(scope==='skills'||scope==='all')this.db.exec('DELETE FROM skills');
      if(scope==='derived') {
        // Cache reset preserves source evidence, user edits, lifecycle and all versions.
        this.db.exec('DELETE FROM cache; UPDATE conversations SET processed_hash=NULL;');
      }
      this.cachedStats=null;
      if(scope==='history'||scope==='derived'||scope==='all')this.db.exec("DELETE FROM meta WHERE key='selectedMaterialPlan' OR key='selectionCorpusSig' OR key='selectionSummaryCache' OR key='procedureOrganization' OR key LIKE 'selection-source:%' OR key LIKE 'localSessionSigs:%' OR key LIKE 'localMetaCache:%'");
      if(scope==='history'||scope==='all') {
        // Raw-history erasure preserves separately managed skills and user edits, but invalidates their provenance.
        if(scope==='history')for(const s of this.skills()) {
          const invalid={...s,evidenceIds:[],enabled:false,state:s.state==='archived'?'archived':'candidate',validation:{valid:false,issues:['Source history was deleted; review this skill before use. / 来源历史已删除，使用前请复核。'],warnings:s.validation.warnings}};
          this.db.prepare('UPDATE skills SET body=? WHERE id=?').run(JSON.stringify(invalid),s.id);
        }
        this.db.exec("DELETE FROM episodes; DELETE FROM cache; DELETE FROM runs; DELETE FROM checkpoints; DELETE FROM meta WHERE key='lastImport'; UPDATE conversations SET processed_hash=NULL;");
      }
      if(scope==='history'||scope==='all')this.db.exec('DELETE FROM aliases; DELETE FROM conversations');
      this.db.exec('RELEASE sp_ep; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
    }catch(e){try{this.db.exec('ROLLBACK TO sp_ep; RELEASE sp_ep');}catch{}throw e;}
  }
  stats():{conversations:number;messages:number;episodes:number;skills:number} {if(this.cachedStats)return this.cachedStats;this.cachedStats={conversations:Number((this.db.prepare('SELECT count(*) AS n FROM conversations').get() as {n:number}).n),messages:Number((this.db.prepare("SELECT coalesce(sum(json_array_length(body,'$.messages')),0) AS n FROM conversations").get() as {n:number}).n),episodes:Number((this.db.prepare('SELECT count(*) AS n FROM episodes').get() as {n:number}).n),skills:Number((this.db.prepare('SELECT count(*) AS n FROM skills').get() as {n:number}).n)};return this.cachedStats;}
}
