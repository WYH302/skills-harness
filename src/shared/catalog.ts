import { IMPORT_SOURCES, type SourceId, type Language } from './types';

export interface Product {id:SourceId;zh:string;en:string;aliases:string[];developer?:boolean;chinese?:boolean;recommended?:boolean;color:string;glyph:string}
export const PRODUCTS:Product[]=[
  {id:'chatgpt',zh:'ChatGPT',en:'ChatGPT',aliases:['openai'],recommended:true,color:'#247660',glyph:'G'},
  {id:'gemini',zh:'Gemini',en:'Gemini',aliases:['bard','google'],recommended:true,color:'#576AD8',glyph:'✦'},
  {id:'claude',zh:'Claude',en:'Claude',aliases:['anthropic'],recommended:true,color:'#B96D50',glyph:'C'},
  {id:'deepseek',zh:'DeepSeek',en:'DeepSeek',aliases:['深度求索'],recommended:true,chinese:true,color:'#416ED3',glyph:'D'},
  {id:'doubao',zh:'豆包',en:'Doubao',aliases:['doubao','字节跳动','bytedance'],recommended:true,chinese:true,color:'#477BD8',glyph:'豆'},
  {id:'qwen',zh:'千问',en:'Qwen',aliases:['qwen','通义千问','tongyi','qianwen','阿里'],recommended:true,chinese:true,color:'#7154D4',glyph:'Q'},
  {id:'copilot',zh:'Microsoft Copilot',en:'Microsoft Copilot',aliases:['微软','bing chat','microsoft copilot'],color:'#5775BC',glyph:'M'},
  {id:'perplexity',zh:'Perplexity',en:'Perplexity',aliases:['pplx'],color:'#32858A',glyph:'P'},
  {id:'grok',zh:'Grok',en:'Grok',aliases:['xai','x.ai'],color:'#28343B',glyph:'𝕏'},
  {id:'meta-ai',zh:'Meta AI',en:'Meta AI',aliases:['meta','facebook','meta ai'],color:'#3D7BE8',glyph:'∞'},
  {id:'yuanbao',zh:'腾讯元宝',en:'Tencent Yuanbao',aliases:['元宝','yuanbao','tencent'],chinese:true,color:'#28947E',glyph:'元'},
  {id:'kimi',zh:'Kimi',en:'Kimi',aliases:['月之暗面','moonshot'],chinese:true,color:'#3F4F6F',glyph:'K'},
  {id:'codex',zh:'Codex',en:'Codex',aliases:['openai codex'],developer:true,color:'#354B48',glyph:'›_'},
  {id:'claude-code',zh:'Claude Code',en:'Claude Code',aliases:['claude code'],developer:true,color:'#B96D50',glyph:'C_'},
  {id:'antigravity',zh:'谷歌反重力 · Antigravity',en:'Google Antigravity',aliases:['antigravity','google antigravity','agy','反重力','谷歌反重力'],developer:true,recommended:true,color:'#4285F4',glyph:'AG'},
  {id:'gemini-cli',zh:'Gemini CLI',en:'Gemini CLI',aliases:['gemini cli','google gemini cli'],developer:true,recommended:true,color:'#576AD8',glyph:'G_'},
  {id:'openclaw',zh:'OpenClaw',en:'OpenClaw',aliases:['openclaw','claw','clawdbot','moltbot'],developer:true,recommended:true,color:'#E05A47',glyph:'OC'},
  {id:'hermes',zh:'Hermes',en:'Hermes Agent',aliases:['hermes','hermes agent','nous','nous hermes'],developer:true,recommended:true,color:'#7C5CBF',glyph:'H_'},
  {id:'deepseek-harness',zh:'DeepSeek Harness',en:'DeepSeek Harness',aliases:['deepseek harness','deepseek-cli','deepseek cli','deepseek code'],developer:true,chinese:true,recommended:true,color:'#3B68D9',glyph:'DS'},
  {id:'cursor',zh:'Cursor',en:'Cursor',aliases:['cursor agent'],developer:true,color:'#3F4854',glyph:'↗'},
  {id:'github-copilot',zh:'GitHub Copilot',en:'GitHub Copilot',aliases:['github copilot','copilot chat'],developer:true,color:'#545065',glyph:'GH'},
  {id:'opencode',zh:'OpenCode',en:'OpenCode',aliases:['open code'],developer:true,color:'#7C6650',glyph:'O_'}
];
export const product=(id:SourceId)=>PRODUCTS.find(p=>p.id===id)!;
export const sourceName=(id:SourceId,language:Language)=>product(id)[language];
export function matchesProduct(id:SourceId,query:string):boolean {const p=product(id),q=query.toLocaleLowerCase().trim();return !q||[p.zh,p.en,p.id,...p.aliases].some(s=>s.toLocaleLowerCase().includes(q));}
export function resolveSource(value:unknown):SourceId|undefined {if(typeof value!=='string')return;const q=value.trim().toLocaleLowerCase();return PRODUCTS.find(p=>[p.id,p.zh,p.en,...p.aliases].some(s=>s.toLocaleLowerCase()===q))?.id;}
export const importOnly=(id:SourceId)=>IMPORT_SOURCES.includes(id);
export const MAIN_ASSISTANTS:SourceId[]=['chatgpt','gemini','claude','antigravity','openclaw','hermes','deepseek','deepseek-harness','qwen','doubao'];
export const MORE_ASSISTANTS:SourceId[]=['kimi','grok','perplexity','cursor'];
export interface ApiPreset {id:string;brand:SourceId;label:string;labelEn?:string;endpoint:string;docs:string;manualModel?:boolean}
export const API_PRESETS:ApiPreset[]=[
  {id:'openai',brand:'chatgpt',label:'OpenAI',endpoint:'https://api.openai.com/v1',docs:'https://developers.openai.com/api/docs'},
  {id:'gemini',brand:'gemini',label:'Google AI Studio',endpoint:'https://generativelanguage.googleapis.com/v1beta/openai',docs:'https://ai.google.dev/gemini-api/docs/openai'},
  {id:'antigravity-gemini',brand:'antigravity',label:'Google AI Studio (Gemini)',endpoint:'https://generativelanguage.googleapis.com/v1beta/openai',docs:'https://ai.google.dev/gemini-api/docs/openai'},
  {id:'deepseek',brand:'deepseek',label:'DeepSeek',endpoint:'https://api.deepseek.com',docs:'https://api-docs.deepseek.com/quick_start/agent_integrations/'},
  {id:'deepseek-harness-api',brand:'deepseek-harness',label:'DeepSeek API',endpoint:'https://api.deepseek.com',docs:'https://api-docs.deepseek.com/quick_start/agent_integrations/'},
  {id:'qwen-cn',brand:'qwen',label:'Model Studio · 北京',labelEn:'Model Studio · Beijing',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1',docs:'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope'},
  {id:'qwen-intl',brand:'qwen',label:'Model Studio · 新加坡',labelEn:'Model Studio · Singapore',endpoint:'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',docs:'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope'},
  {id:'doubao',brand:'doubao',label:'火山方舟 · 北京',labelEn:'Volcano Ark · Beijing',endpoint:'https://ark.cn-beijing.volces.com/api/v3',docs:'https://docs.volcengine.com/docs/ark/quick-start?lang=zh',manualModel:true},
  {id:'kimi-cn',brand:'kimi',label:'Moonshot · 中国',labelEn:'Moonshot · China',endpoint:'https://api.moonshot.cn/v1',docs:'https://www.kimi.com/en/help/kimi-api/api-overview'},
  {id:'kimi-intl',brand:'kimi',label:'Moonshot · International',endpoint:'https://api.moonshot.ai/v1',docs:'https://www.kimi.com/en/help/kimi-api/api-overview'},
  {id:'grok',brand:'grok',label:'xAI',endpoint:'https://api.x.ai/v1',docs:'https://docs.x.ai/developers/rest-api-reference/inference'},
  {id:'perplexity',brand:'perplexity',label:'Perplexity',endpoint:'https://api.perplexity.ai/orchestrator/v1',docs:'https://docs.perplexity.ai/getting-started/quickstart'}
];
