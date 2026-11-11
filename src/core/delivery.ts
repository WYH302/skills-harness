import { access, mkdir, readFile, realpath, lstat, rename, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { Destination, Skill, SkillResource } from '../shared/types';
import { SAFE_RESOURCE_PATH, validateSkill } from './skills';
import { redact, hash } from './util';

const exists=async(p:string)=>access(p).then(()=>true,()=>false);
export async function detectDestinations(home=homedir()):Promise<Destination[]> {
  const codex=await exists(path.join(home,'.codex'));
  const claude=await exists(path.join(home,'.claude'));
  const antigravity=await exists(path.join(home,'.gemini','antigravity'))||await exists(path.join(home,'.antigravity'));
  const gemini=await exists(path.join(home,'.gemini'));
  const openclaw=await exists(path.join(home,'.openclaw'));
  const hermes=await exists(path.join(home,'.hermes'));
  const deepseek=await exists(path.join(home,'.deepseek'))||await exists(path.join(home,'.deepseek-harness'));
  const cursor=await exists(path.join(home,'.cursor'));
  const codexPath=await exists(path.join(home,'.agents','skills'))?path.join(home,'.agents','skills'):await exists(path.join(home,'.codex','skills'))?path.join(home,'.codex','skills'):path.join(home,'.agents','skills');
  const agyPath=await exists(path.join(home,'.gemini','antigravity','skills'))?path.join(home,'.gemini','antigravity','skills'):await exists(path.join(home,'.gemini','config','skills'))?path.join(home,'.gemini','config','skills'):path.join(home,'.gemini','antigravity','skills');
  return [
    {id:'codex',title:'Codex · Personal Skills',path:codexPath,exists:await exists(codexPath),verified:codex,detail:codex?'Detected Codex configuration. Agent availability depends on the installed version. / 已检测到 Codex 配置，是否加载取决于客户端版本。':'Codex configuration not detected / 未检测到 Codex 配置'},
    {id:'claude-code',title:'Claude Code · Personal Skills',path:path.join(home,'.claude','skills'),exists:await exists(path.join(home,'.claude','skills')),verified:claude,detail:claude?'Detected Claude configuration; restart or refresh the target agent if required. / 已检测到 Claude 配置。':'Claude Code configuration not detected / 未检测到 Claude Code 配置'},
    {id:'antigravity',title:'Google Antigravity (谷歌反重力) · Skills',path:agyPath,exists:await exists(agyPath),verified:antigravity,detail:antigravity?'Detected Google Antigravity configuration. / 已检测到 Google Antigravity（谷歌反重力）配置。':'Google Antigravity configuration not detected / 未检测到 Google Antigravity 配置'},
    {id:'gemini-cli',title:'Gemini CLI · Personal Skills',path:path.join(home,'.gemini','skills'),exists:await exists(path.join(home,'.gemini','skills')),verified:gemini,detail:gemini?'Detected Gemini CLI configuration. / 已检测到 Gemini CLI 配置。':'Gemini CLI configuration not detected / 未检测到 Gemini CLI 配置'},
    {id:'openclaw',title:'OpenClaw · Agent Skills',path:path.join(home,'.openclaw','skills'),exists:await exists(path.join(home,'.openclaw','skills')),verified:openclaw,detail:openclaw?'Detected OpenClaw configuration. / 已检测到 OpenClaw 配置。':'OpenClaw configuration not detected / 未检测到 OpenClaw 配置'},
    {id:'hermes',title:'Hermes Agent · Skills',path:path.join(home,'.hermes','skills'),exists:await exists(path.join(home,'.hermes','skills')),verified:hermes,detail:hermes?'Detected Hermes Agent configuration. / 已检测到 Hermes Agent 配置。':'Hermes Agent configuration not detected / 未检测到 Hermes Agent 配置'},
    {id:'deepseek-harness',title:'DeepSeek Harness · Skills',path:path.join(home,'.deepseek','skills'),exists:await exists(path.join(home,'.deepseek','skills')),verified:deepseek,detail:deepseek?'Detected DeepSeek Harness configuration. / 已检测到 DeepSeek Harness 配置。':'DeepSeek Harness configuration not detected / 未检测到 DeepSeek Harness 配置'},
    {id:'cursor',title:'Cursor · Personal Skills',path:path.join(home,'.cursor','skills'),exists:await exists(path.join(home,'.cursor','skills')),verified:cursor,detail:cursor?'Detected Cursor configuration. / 已检测到 Cursor 配置。':'Cursor configuration not detected / 未检测到 Cursor 配置'}
  ];
}
export function portableMarkdown(skill:Skill):string {
  // Export carries procedures and aggregate provenance, never the imported transcript or local source paths.
  return redact(skill.markdown).replace(/\]\((?:file:\/\/|[A-Z]:\\|\/(?:Users|home)\/)[^)]+\)/g,']([LOCAL_REFERENCE_REMOVED])');
}
export function portableResourceContent(resource:SkillResource):string {
  return redact(resource.content).replace(/\]\((?:file:\/\/|[A-Z]:\\|\/(?:Users|home)\/)[^)]+\)/g,']([LOCAL_REFERENCE_REMOVED])');
}
export function exportSkills(skills:Skill[]):Uint8Array {
  const files:Record<string,Uint8Array>={};
  for(const skill of skills) {
    if(!validateSkill(skill.markdown,skill.name,skill.resources).valid)throw new Error('Invalid skill cannot be exported');
    files[`${skill.name}/SKILL.md`]=strToU8(portableMarkdown(skill));
    for(const res of skill.resources||[]) {
      if(!SAFE_RESOURCE_PATH.test(res.path)||res.path.includes('..'))throw new Error('Unsafe resource path');
      files[`${skill.name}/${res.path}`]=strToU8(portableResourceContent(res));
    }
  }
  files['README.txt']=strToU8('SkillHarbor portable Agent Skills. Review each SKILL.md before installation. Source transcripts are not included.\n');
  return zipSync(files,{level:6});
}
export async function installSkill(skill:Skill,destination:Destination):Promise<string> {
  if(!destination.verified)throw new Error('Compatible agent not detected');
  if(!validateSkill(skill.markdown,skill.name,skill.resources).valid)throw new Error('Skill validation failed');
  // Known verified destinations only; callers never pass arbitrary target paths from history or extension data.
  const parent=path.dirname(destination.path);
  await mkdir(parent,{recursive:true});
  if((await lstat(parent)).isSymbolicLink())throw new Error('Symlink destination not allowed');
  await mkdir(destination.path,{recursive:true});
  if((await lstat(destination.path)).isSymbolicLink())throw new Error('Symlink destination not allowed');
  const base=await realpath(destination.path);
  const target=path.join(base,skill.name);
  if(path.dirname(target)!==base)throw new Error('Unsafe skill name');
  if(await exists(target))throw new Error('Destination already exists; export and merge manually to preserve existing edits / 目标已存在，请导出后合并以保留修改');
  const temp=path.join(base,`.skillharbor-${randomUUID()}`);
  await mkdir(temp,{mode:0o700});
  try {
    await writeFile(path.join(temp,'SKILL.md'),portableMarkdown(skill),{mode:0o600});
    for(const res of skill.resources||[]) {
      if(!SAFE_RESOURCE_PATH.test(res.path)||res.path.includes('..'))throw new Error('Unsafe resource path');
      const resTarget=path.resolve(temp,...res.path.split('/'));
      const rel=path.relative(temp,resTarget);
      if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('Unsafe resource path');
      await mkdir(path.dirname(resTarget),{recursive:true,mode:0o700});
      await writeFile(resTarget,portableResourceContent(res),{mode:0o600});
    }
    await writeFile(path.join(temp,'SKILLHARBOR.json'),JSON.stringify({generator:'SkillHarbor',version:skill.version,contentHash:hash([portableMarkdown(skill),(skill.resources||[]).map(r=>[r.path,portableResourceContent(r)])]),resources:(skill.resources||[]).map(r=>r.path)}),{mode:0o600});
    await rename(temp,target);
  }catch(e){await rm(temp,{recursive:true,force:true});throw e;}
  return target;
}
