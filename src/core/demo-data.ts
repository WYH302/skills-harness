import type { Conversation, SourceId } from '../shared/types';

const procedures=[
 {goal:'面向新手评估一个开源工具是否值得采用',input:'输入：项目仓库链接、预期用途和可投入的安装时间。',output:'输出：用途说明、证据对比表、安装成本和采用建议。',steps:['先确认用户的实际用途、已有工具和能接受的安装维护成本。','读取仓库说明、许可证和最近的发布记录，记录每一项判断的公开来源。','区分仓库宣称的功能与实际文档或运行记录能够支持的功能。','比较候选工具与现有方案在目标任务、配置要求和维护投入方面的差异。','给出采用、暂缓或替代方案的建议，并明确哪些功能尚未验证。']},
 {goal:'围绕研究问题分析长文档并交付证据报告',input:'输入：文档文件、研究问题和所需报告语言。',output:'输出：问题对应的证据表、引用位置、结论和未知项。',steps:['先明确需要回答的研究问题，以及最后报告要支持的决策。','根据目录和关键词定位相关章节，记录章节号和原文页码。','提取能够直接支持问题的原文证据，保留引用位置和必要的上下文。','把不同章节的证据整理成比较表，区分文档事实、作者主张和自己的推断。','依据证据回答问题，并列出文档没有提供答案的部分。']},
 {goal:'定位应用故障并验证最小范围的修复',input:'输入：错误现象、复现步骤、项目环境和最近的相关改动。',output:'输出：可复现原因、最小修复、相关验证结果和剩余限制。',steps:['先复现用户报告的故障，记录触发条件、预期行为与实际行为。','读取错误发生位置附近的实现和调用路径，提出一个可以验证的原因。','用针对性的日志或最小输入验证该原因，避免同时修改多个无关模块。','根据确认的原因修改最小负责范围，并保留用户已有的有效改动。','重新运行原先的失败场景和受影响的相关检查，报告验证结果与仍未覆盖的范围。']}
];
export function demoConversations(extra=false):Conversation[] {
  const sources:SourceId[]=['chatgpt','claude','gemini','codex','claude-code','cursor'];
  const records:Conversation[]=procedures.flatMap((p,i)=>[0,1].map(j=>({source:sources[i*2+j],externalId:`demo-${i}-${j}`,title:`示例 · ${p.goal} ${j+1}`,createdAt:`2026-10-${String(10+i*2+j).padStart(2,'0')}T09:00:00Z`,updatedAt:`2026-10-${String(10+i*2+j).padStart(2,'0')}T09:30:00Z`,completeness:'full' as const,warnings:['Synthetic example / 人工构造的非敏感示例'],messages:[{id:'request',role:'user' as const,text:`请${p.goal}。\n这是第 ${j+1} 个不同案例。\n${p.input}\n${p.output}`},{id:'procedure',role:'assistant' as const,text:`本次采用了以下方法：\n${p.steps.map((s,k)=>`${k+1}. ${s}`).join('\n')}\n\n${p.output}\n案例 ${j+1} 的具体结论已按以上结构交付。`},{id:'acceptance',role:'user' as const,text:'这次的结果很好，符合要求。以后就按这种结构交付，结论中保留尚未验证的部分。'}]})));
  records.push({source:'chatgpt',externalId:'demo-topic',title:'关于显卡的闲聊',completeness:'full',warnings:[],messages:[{id:'u',role:'user',text:'显卡的颜色一般有哪些？'},{id:'a',role:'assistant',text:'常见的外壳颜色有黑色、白色和银色。'}]});
  records.push({source:'claude',externalId:'demo-once',title:'一次性格式要求',completeness:'full',warnings:[],messages:[{id:'u',role:'user',text:'仅这一次，把这段文字变成大写，不要保存为以后规则。'},{id:'a',role:'assistant',text:'这是一段大写文字。'}]});
  if(extra) {const p=procedures[0];records.push({source:'opencode',externalId:'demo-incremental',title:'新增开源工具评估案例',completeness:'full',warnings:['Synthetic incremental example'],messages:[{id:'u',role:'user',text:`再次${p.goal}，这次比较另一个非敏感示例项目。\n${p.input}\n${p.output}`},{id:'a',role:'assistant',text:p.steps.map((s,i)=>`${i+1}. ${s}`).join('\n')},{id:'ok',role:'user',text:'很好，这个结构很有用。'}]});}
  return records;
}
