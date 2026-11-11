import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { collectLocal, detectLocalSources } from '../src/adapters/local';
import { importHistory, parseHistoryJSON, parseHistoryText } from '../src/adapters/import';
import type { CollectorEvent, Conversation, SourceId } from '../src/shared/types';

const TEMP_PREFIX=path.join(tmpdir(),'skillharbor-adapter-test-');
async function fixture<T>(run:(dir:string)=>Promise<T>):Promise<T>{const dir=await mkdtemp(TEMP_PREFIX);try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function put(dir:string,name:string,body:string|Uint8Array){const filename=path.join(dir,name);await mkdir(path.dirname(filename),{recursive:true});await writeFile(filename,body);return filename;}
async function collected(source:SourceId,dir:string,options:Record<string,unknown>={}){const out:CollectorEvent[]=[];for await(const e of collectLocal(source,{signal:new AbortController().signal,home:dir,...options}))out.push(e);return out;}
const conversations=(events:CollectorEvent[])=>events.filter((e):e is {type:'conversation';conversation:Conversation}=>e.type==='conversation').map(e=>e.conversation);
const jsonl=(rows:unknown[])=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';

test('availability checks only standard local stores, with isolated fixture home',()=>fixture(async dir=>{
  let result=await detectLocalSources({home:dir});assert.equal(result.some(s=>s.available),false);
  await mkdir(path.join(dir,'.codex','sessions'),{recursive:true});
  result=await detectLocalSources({home:dir});assert.equal(result.find(s=>s.id==='codex')?.available,false);assert.equal(result.find(s=>s.id==='codex')?.discoveryState,'empty');
  await writeFile(path.join(dir,'.codex','sessions','session.jsonl'),JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'A real saved request'}]}})+'\n');
  result=await detectLocalSources({home:dir});assert.equal(result.find(s=>s.id==='codex')?.available,true);assert.equal(result.find(s=>s.id==='codex')?.historyCount,1);assert.equal(result.find(s=>s.id==='claude-code')?.available,false);
}));
test('Codex joins plain/gzip/zstd pages and skips archive copies and mirrored events',()=>fixture(async dir=>{
  const id='11111111-2222-3333-4444-555555555555',t='2026-10-01T10:00:00Z';
  const first=jsonl([{type:'session_meta',timestamp:t,payload:{id,timestamp:t}},{type:'event_msg',timestamp:t,payload:{type:'user_message',message:'Evaluate a public tool.'}},
    {type:'response_item',timestamp:t,payload:{type:'message',id:'u1',role:'user',content:[{type:'input_text',text:'Evaluate a public tool.'}]}},
    {type:'response_item',timestamp:'2026-10-01T10:00:01Z',payload:{type:'message',id:'a1',role:'assistant',content:[{type:'output_text',text:'1. Read the README.\n2. Verify its license.\n3. Compare installation requirements.'}]}}]);
  await put(dir,`.codex/sessions/rollout-2026-10-01-${id}.jsonl`,first);
  await put(dir,`.codex/archived_sessions/rollout-2026-10-01-${id}.jsonl.gz`,gzipSync(first));
  await put(dir,`.codex/sessions/rollout-2026-10-02-${id}.jsonl.gz`,gzipSync(jsonl([{type:'response_item',timestamp:'2026-10-02T10:00:00Z',payload:{type:'function_call',name:'readme',call_id:'c1',arguments:'{"file":"README.md"}'}},{type:'response_item',timestamp:'2026-10-02T10:00:01Z',payload:{type:'function_call_output',call_id:'c1',output:'MIT license'}}])));
  await put(dir,`.codex/sessions/rollout-2026-10-03-${id}.jsonl.zst`,zstdCompressSync(jsonl([{type:'response_item',timestamp:'2026-10-03T10:00:00Z',payload:{type:'message',id:'u2',role:'user',content:[{type:'input_text',text:'Good, use this method again.'}]}}])));
  const result=conversations(await collected('codex',dir));assert.equal(result.length,1);assert.equal(result[0].messages.length,5);assert.equal(result[0].externalId,id);assert.equal(result[0].messages.filter(m=>m.text==='Evaluate a public tool.').length,1);assert.equal(result[0].messages.find(m=>m.role==='tool')?.text,'MIT license');assert.equal(result[0].completeness,'full');
}));
test('malformed trailing log records report partial coverage and date filter excludes old sessions',()=>fixture(async dir=>{
  await put(dir,'.codex/sessions/old.jsonl',jsonl([{type:'event_msg',timestamp:'2020-01-01T00:00:00Z',payload:{type:'user_message',message:'Old task'}}]));
  await put(dir,'.codex/sessions/new.jsonl',jsonl([{type:'event_msg',timestamp:'2026-10-20T00:00:00Z',payload:{type:'user_message',message:'New task'}}])+'{"unfinished":');
  const result=conversations(await collected('codex',dir,{dateFrom:'2026-10-01'}));assert.equal(result.length,1);assert.equal(result[0].completeness,'partial');assert.match(result[0].warnings.join(' '),/malformed/);
}));
test('Claude Code preserves text, tools, results and repeated turns with distinct identities',()=>fixture(async dir=>{
  await put(dir,'.claude/projects/demo/session.jsonl',jsonl([
    {type:'user',sessionId:'s1',uuid:'u1',timestamp:'2026-10-01T10:00:00Z',message:{role:'user',content:'Read the project.'}},
    {type:'assistant',uuid:'a1',timestamp:'2026-10-01T10:00:01Z',message:{role:'assistant',content:[{type:'text',text:'I will read its files.'},{type:'tool_use',id:'call1',name:'Read',input:{file_path:'README.md'}}]}},
    {type:'user',uuid:'tool1',timestamp:'2026-10-01T10:00:02Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'call1',content:'Public README text'}]}},
    {type:'user',uuid:'u2',timestamp:'2026-10-01T10:00:03Z',message:{role:'user',content:'Read the project.'}}
  ]));
  const result=conversations(await collected('claude-code',dir));assert.equal(result.length,1);assert.equal(result[0].messages.length,5);assert.equal(result[0].messages.filter(m=>m.text==='Read the project.').length,2);assert.equal(result[0].messages.find(m=>m.role==='tool')?.text,'Public README text');assert.ok(result[0].messages.some(m=>m.toolName==='Read'));
}));
test('Cursor reads composer and bubble rows using read-only SQLite',()=>fixture(async dir=>{
  const file=await put(dir,'cursor/state.vscdb','');const db=new DatabaseSync(file);db.exec('CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value TEXT)');
  const insert=db.prepare('INSERT INTO cursorDiskKV VALUES (?,?)');
  insert.run('composerData:c1',JSON.stringify({name:'Repair procedure',createdAt:1790812800000,fullConversation:[{bubbleId:'u1'},{bubbleId:'a1'}]}));
  insert.run('bubbleId:c1:u1',JSON.stringify({type:1,text:'Fix a parser defect.'}));insert.run('bubbleId:c1:a1',JSON.stringify({type:2,text:'1. Reproduce.\n2. Inspect input.\n3. Fix and rerun.'}));db.close();
  const result=conversations(await collected('cursor',dir,{roots:{cursor:[path.dirname(file)]}}));assert.equal(result.length,1);assert.equal(result[0].messages.length,2);assert.equal(result[0].completeness,'partial');
}));
test('OpenCode reads SQLite message/part schema and retains tools',()=>fixture(async dir=>{
  const file=await put(dir,'.local/share/opencode/opencode.db','');const db=new DatabaseSync(file);
  db.exec('CREATE TABLE session(id TEXT,title TEXT,time_created INTEGER,time_updated INTEGER);CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);CREATE TABLE part(id TEXT,message_id TEXT,time_created INTEGER,data TEXT)');
  db.prepare('INSERT INTO session VALUES(?,?,?,?)').run('s1','Useful workflow',1790812800000,1790812801000);
  db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('u1','s1',1790812800000,JSON.stringify({role:'user'}));
  db.prepare('INSERT INTO message VALUES(?,?,?,?)').run('a1','s1',1790812801000,JSON.stringify({role:'assistant'}));
  db.prepare('INSERT INTO part VALUES(?,?,?,?)').run('p1','u1',1,JSON.stringify({type:'text',text:'Review this document.'}));
  db.prepare('INSERT INTO part VALUES(?,?,?,?)').run('p2','a1',2,JSON.stringify({type:'tool',tool:'read',state:{input:{file:'public.pdf'},output:'Document text'}}));db.close();
  const result=conversations(await collected('opencode',dir));assert.equal(result.length,1);assert.equal(result[0].messages.length,3);assert.equal(result[0].messages[2].role,'tool');
}));
test('OpenCode legacy JSON stores are discovered without scanning attachments',()=>fixture(async dir=>{
  await put(dir,'.local/share/opencode/storage/session/demo/s1.json',JSON.stringify({id:'s1',title:'Legacy',time:{created:1790812800000}}));
  await put(dir,'.local/share/opencode/storage/message/s1/u1.json',JSON.stringify({id:'u1',role:'user',time:{created:1790812800000}}));
  await put(dir,'.local/share/opencode/storage/part/u1/p1.json',JSON.stringify({type:'text',text:'Use the same evidence extraction method.'}));
  const result=conversations(await collected('opencode',dir));assert.equal(result.length,1);assert.equal(result[0].messages[0].text,'Use the same evidence extraction method.');
}));
test('cancelled source collection throws before reading stores',()=>fixture(async dir=>{
  const controller=new AbortController();controller.abort();await assert.rejects(async()=>{for await(const event of collectLocal('codex',{signal:controller.signal,home:dir}))void event;},/abort/i);
}));
test('one corrupted compressed session does not destroy another session',()=>fixture(async dir=>{
  await put(dir,'.codex/sessions/broken.jsonl.gz','not a gzip stream');
  await put(dir,'.codex/sessions/good.jsonl',jsonl([{type:'event_msg',timestamp:'2026-10-01T00:00:00Z',payload:{type:'user_message',message:'A retained task'}}]));
  const events=await collected('codex',dir);assert.equal(conversations(events).length,1);assert.ok(events.some(e=>e.type==='progress' && e.failed===1));
}));
test('ChatGPT imports the selected branch and marks unimported alternatives',()=>{
  const result=parseHistoryJSON([{id:'c1',title:'Example',current_node:'a2',mapping:{root:{children:['u1']},u1:{parent:'root',children:['a1','a2'],message:{id:'u1',author:{role:'user'},content:{parts:['Assess a tool.']}}},a1:{parent:'u1',children:[],message:{id:'a1',author:{role:'assistant'},content:{parts:['Old answer']}}},a2:{parent:'u1',children:[],message:{id:'a2',author:{role:'assistant'},content:{parts:['Revised answer']}}}}}]);
  assert.equal(result.length,1);assert.equal(result[0].messages.at(-1)?.text,'Revised answer');assert.equal(result[0].messages.length,2);assert.equal(result[0].completeness,'partial');
});
test('Claude official and canonical exports preserve original roles and times',()=>{
  const claude=parseHistoryJSON([{uuid:'c1',name:'Writing',created_at:'2026-10-01T00:00:00Z',chat_messages:[{uuid:'u1',sender:'human',text:'Revise this paragraph.'},{uuid:'a1',sender:'assistant',content:[{type:'text',text:'Keep concrete verbs.'}]}]}]);
  assert.equal(claude[0].source,'claude');assert.equal(claude[0].messages[0].role,'user');
  const canonical=parseHistoryJSON({source:'codex',externalId:'c1',title:'Task',completeness:'full',messages:[{id:'a',role:'tool',text:'Result',timestamp:'2026-10-01T00:00:00Z',toolName:'Read'}]});assert.equal(canonical[0].messages[0].toolName,'Read');assert.equal(canonical[0].source,'codex');
});
test('ZIP provider import avoids duplicate HTML mirrors and rejects traversal paths',()=>fixture(async dir=>{
  const data={source:'chatgpt',externalId:'one',messages:[{role:'user',text:'A task'}]};
  const file=await put(dir,'history.zip',zipSync({'conversations.json':strToU8(JSON.stringify([data])),'chat.html':strToU8('<p>A task</p>')}));
  const imported:Conversation[]=[];for await(const c of importHistory(file))imported.push(c);assert.equal(imported.length,1);
  const unsafe=await put(dir,'unsafe.zip',zipSync({'../history.json':strToU8(JSON.stringify([data]))}));await assert.rejects(async()=>{for await(const c of importHistory(unsafe))void c;},/unsafe/i);
}));
test('Takeout and unlabelled HTML never fabricate an assistant outcome',()=>{
  const result=parseHistoryText('<div class="outer-cell mdl-cell"><div>Gemini Apps</div><div>Prompted Read a document<br>Oct 1, 2026</div></div>','My Activity.html');
  assert.equal(result.length,1);assert.equal(result[0].completeness,'partial');assert.equal(result[0].messages.length,1);assert.equal(result[0].messages[0].role,'user');
  const generic=parseHistoryText('<script>secret()</script><p>Just text</p>','capture.html','claude');assert.equal(generic[0].messages[0].role,'system');assert.doesNotMatch(generic[0].messages[0].text,/secret/);
});
test('role-labelled XML remains partial and ignores executable markup',()=>{
  const result=parseHistoryText('<history><message role="user">Read &amp; compare.</message><message role="assistant"><script>run()</script>Read the source.</message></history>','export.xml','claude');
  assert.equal(result[0].messages.length,2);assert.equal(result[0].messages[0].text,'Read & compare.');assert.equal(result[0].messages[1].text,'Read the source.');assert.equal(result[0].completeness,'partial');
});
test('Antigravity, Gemini CLI, OpenClaw, Hermes and DeepSeek Harness local stores are discovered and collected cleanly',()=>fixture(async dir=>{
  const convId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await put(dir,`.gemini/antigravity/brain/${convId}/.system_generated/logs/transcript.jsonl`,jsonl([
    {step_index:1,type:'USER_INPUT',source:'USER_EXPLICIT',created_at:'2026-10-05T10:00:00Z',content:'<CONTEXT_SUMMARY>Old summary</CONTEXT_SUMMARY>\n<USER_REQUEST>Audit the local harness setup</USER_REQUEST>'},
    {step_index:2,type:'PLANNER_RESPONSE',source:'MODEL',created_at:'2026-10-05T10:00:05Z',content:'1. Inspect local roots.\n2. Verify CLI flags.\n3. Export validated skills.',tool_calls:[{name:'read_file',arguments:{Path:'README.md'}}]}
  ]));
  await put(dir,`.gemini/antigravity/brain/${convId}/.system_generated/logs/transcript_full.jsonl`,jsonl([
    {step_index:1,type:'USER_INPUT',source:'USER_EXPLICIT',created_at:'2026-10-05T10:00:00Z',content:'Duplicate full log'}
  ]));
  await put(dir,'.openclaw/sessions/claw-1.jsonl',jsonl([
    {role:'user',content:'Configure OpenClaw workflow',timestamp:'2026-10-05T11:00:00Z'},
    {role:'assistant',content:'1. Check OpenClaw config.\n2. Validate skill directory.',timestamp:'2026-10-05T11:00:02Z'}
  ]));
  await put(dir,'.hermes/trajectories/hermes-1.jsonl',jsonl([
    {messages:[{role:'user',content:'Run Hermes trajectory verification'},{role:'assistant',content:'1. Load trajectory.\n2. Verify steps.'}]}
  ]));
  await put(dir,'.deepseek/sessions/ds-1.jsonl',jsonl([
    {role:'user',content:'Run DeepSeek harness check'},
    {role:'assistant',content:'1. Inspect DeepSeek config.\n2. Verify output.'}
  ]));
  const detected=await detectLocalSources({home:dir});
  assert.equal(detected.find(s=>s.id==='antigravity')?.available,true);
  assert.equal(detected.find(s=>s.id==='antigravity')?.historyCount,1);
  assert.equal(detected.find(s=>s.id==='openclaw')?.available,true);
  assert.equal(detected.find(s=>s.id==='hermes')?.available,true);
  assert.equal(detected.find(s=>s.id==='deepseek-harness')?.available,true);
  const agyConvs=conversations(await collected('antigravity',dir));
  assert.equal(agyConvs.length,1);
  assert.equal(agyConvs[0].externalId,convId);
  assert.equal(agyConvs[0].messages[0].text,'Audit the local harness setup');
  assert.equal(agyConvs[0].messages.length,3);
}));
