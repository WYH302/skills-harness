/**
 * Optional workspace-specific status/replay filter patterns.
 * Separated from the core domain-agnostic procedural miner (`src/core/mining.ts`)
 * so deployments can customize or disable local log boilerplate filters cleanly.
 */
export const WORKSPACE_STATUS_PATTERNS: readonly RegExp[] = [
  /(?:严重问题|主要问题|次要[^：:]{0,6}问题|最终判断|表格整体判断|这版最重要的)[：:]|(?:论文(?:现在|最有价值|把|说明|报告|提出|的新意)|作者(?:对|已|没有|应)|需要作者(?:补充|提供|确认|公开|从|用)|不能直接生成、必须作者完成|审稿人(?:会|可能|最核心))|\b(?:The (?:statistical|derived|authors|paper|manuscript|proposed|current|main|primary)|Reproducibility remains|Uncertain,\s*needs author check|Some sentences are not|It is recommended to|Under review;\s*(?:first|second)\s*author|First author\.|Second author\.|Proficient with\s+Slurm|Hands-on experience|Native Mandarin)/i,
  /(?:^这说明|^所以会出现|^不是我不能|^是\s+\S+\s+子\s*Agent|^正文一共只有|^但这些\s+`\\cite|^当前客栈|^这还不是|^看起来像|^两个子代理|人家也没说|是不是应该|把下一页截图发给我|我再告诉你|此前证据主要涉及|是否导致难读|呢[？?]$|[?？]\s*$|\((?:<)?\/?(?:[A-Za-z]:[\\/]|Users\/|home\/|\[USER_HOME\])|(?:[，,；;：:\s]|^)(?:[A-Za-z]:\\[^\s`]+|\[USER_HOME\][^\s`]+)|\b(?:Table|Figure|Fig\.|Section|Eq\.|Layer|Boundary|Round)\s*(?:\d+|[IVX]+|\(\d+\)|[A-Z]\b)|表\s*\d+|图\s*\d+(?:\.\d+)?|第\s*\d+(?:[-–—、,，]\d+)*\s*[页章节]|:contentReference)/i,
  /(?:可调用$|全部可打开|都能正常读取|没有增删、修改或移动|病句消失|^(?:编译后的|新增直接|更新\s+\S+\s*图).*\[[^\]]+\]\()|^(?:\d[\d,]*\s*(?:个|份|封|条|篇|页|处)|`?\d{3,4}`?\s*[：:]|\[\d+\](?:\[\d+\])*\s*[：:]|`?\d{1,2}:\d{2}:\d{2}`?\s)|^(?:[\w-]+\s*[：:]\s*)?面向.+的.+(?:网络|系统|方法|模型|框架|协议|研究|导出|编译)$|^[\w\s/+.-]+(?:正式检索)?导出文件$|^(?:[a-z0-9/_-]+\s+){1,5}(?:audit|formulation|reductions?|table|protocol(?:\s*表)?)$/i,
];

export const WORKSPACE_SELF_REPLAY_PATTERN =
  /#\s*SkillHarbor[：:].*改造任务书|SkillHarbor_(?:Auto_Discovery|Low_Cost|Focus_and_Membership|Mainstream_and_Bilingual)_Brief/i;

export function matchesWorkspaceStatusFilter(core: string): boolean {
  return WORKSPACE_STATUS_PATTERNS.some(pattern => pattern.test(core));
}
