import type { Language, Settings, Run, Episode } from './types';

export function resolveOutputLanguage(settings:Settings):NonNullable<Run['outputLanguage']>{return settings.skillOutputLanguage==='source'?'source':settings.skillOutputLanguage==='en'?'en':settings.skillOutputLanguage==='zh'?'zh':settings.language;}
export function matchesOutputLanguage(episodes:Episode[],language:Run['outputLanguage']):boolean{
  if(!language||language==='source')return true;
  return episodes.every(e=>{const text=[e.goal,...e.inputs,...e.outputs,...e.steps,...e.preferences,...e.corrections,e.quality?.rubric?.text||'',...(e.quality?.checks.map(c=>c.description)||[])].join('\n');const chinese=/[\p{Script=Han}]/u.test(text);return language==='zh'?chinese:!chinese;});
}
const messages:Record<string,[string,string]>={
  'A run is already active':['已有任务正在运行。','A run is already active.'],
  'Finish the current run first':['请先完成或暂停当前任务。','Finish or pause the current run first.'],
  'Finish this run first':['请先完成或暂停当前任务。','Finish or pause the current run first.'],
  'Connect a model first':['请先连接生成助手。','Connect an AI assistant first.'],
  'Select at least one source':['请至少选择一个历史来源。','Select at least one history source.'],
  'Model catalog unavailable':['暂时无法读取可用模型，请稍后重试。','The model catalog is temporarily unavailable. Try again.'],
  'Choose a model available to this account':['请选择此账号可用的模型。','Choose a model available to this account.'],
  'user edit':['手动修改','User edit'],
  'evidence consolidation':['根据历史经验整理','Evidence consolidation'],
  'evidence reconciliation':['核对当前历史依据','Evidence reconciliation'],
  'proposed revision; user edit preserved':['建议修订，已保留手动修改','Proposed revision; user edit preserved'],
  'Account not found':['未找到这个账号，请重新连接。','Account not found. Connect again.'],
  'Assistant not found':['未找到这个助手，请重新检测。','Assistant not found. Check again.'],
  'Settings cannot change during a run':['运行时可以切换界面语言；其他设置请在暂停后修改。','Interface language can change during a run. Pause before changing other settings.'],
  'Invalid date range':['结束日期不能早于开始日期。','The end date must follow the start date.'],
  'Unrecognized conversation export format.':['无法识别此导出格式，请使用带消息角色的 JSON 或文本文件。','Unrecognized export format. Use role-labeled JSON or text.'],
  'Model catalog too large':['服务返回的模型列表过大。','The model catalog is too large.'],
  'Invalid endpoint':['服务地址无效，请检查地址。','Invalid service address. Check the endpoint.'],
  'No supported conversations were found. Choose a provider conversation export or a SkillHarbor canonical JSON file.':['文件中未找到受支持的对话。请选择带消息角色的导出或 SkillHarbor JSON 文件。','No supported conversations were found. Choose role-labeled history or a SkillHarbor JSON file.'],
  'Imported the current conversation branch. Alternative answer branches remain in the original provider export.':['已导入当前对话分支；其他回答分支仍保留在原始导出中。','Imported the current branch; alternatives remain in the original export.'],
  'Export does not provide an independently verifiable full-history marker.':['此导出没有可独立核验的完整历史标记。','This export has no independently verifiable completeness marker.'],
  'Skill name must match its directory':['技能名称必须与目录名一致。','The skill name must match its directory.'],
  'Invalid name: use 1–64 lowercase letters/numbers/hyphens':['名称须为 1–64 个小写英文字母、数字或连字符。','Use 1–64 lowercase letters, numbers or hyphens for the name.'],
  'Description must contain 1–1024 characters':['技能描述须为 1–1024 个字符。','The description must contain 1–1024 characters.'],
  'Invalid YAML frontmatter':['技能文件的元数据格式无效。','Invalid skill metadata format.'],
  'Invalid input':['输入格式无效。','Invalid input.']
};
/** For application-owned notices only. Never apply to transcripts or citations. */
export function localizeNotice(value:string|undefined,language:Language):string{
  if(!value)return '';const exact=messages[value];if(exact)return exact[language==='zh'?0:1];
  const parts=value.split(' / ');if(parts.length<2)return value;
  const zh=parts.filter(p=>/[\p{Script=Han}]/u.test(p)),en=parts.filter(p=>!/[\p{Script=Han}]/u.test(p));
  if(!zh.length||!en.length)return value;return (language==='zh'?zh:en).join(' / ').trim();
}
