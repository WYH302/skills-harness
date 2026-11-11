# 来源与平台兼容性 / Compatibility

此表描述已实现路径和实际证据。`full` 表示该会话通过当前读取方法没有发现缺口；不承诺平台账号之外、已删除或隐藏的历史。源端接口分页结束也不等于可恢复所有曾经存在的数据。

| 来源 | 检测和自动采集 | 后备入口 | 已执行验证 | 未验证或固有限制 |
| --- | --- | --- | --- | --- |
| ChatGPT | 扩展按来源授权；网页登录探测；普通与归档列表分页；当前分支详情 | 当前页面/侧栏，官方 JSON/ZIP | 解析测试；真实 Chromium 扩展与模拟网站完整链路 | 未登录真实账号；不同工作区和未暴露分支受源端权限限制 |
| Claude | 网页登录探测；组织成员关系；按组织列出和读取会话 | 明确标记的页面回退；官方 JSON/ZIP | 树与工具消息样例测试 | 未登录真实账号；歧义父子树不能假装有唯一答案 |
| Gemini | 当前浏览器账号；两条历史 RPC 流；分页；会话 RPC | 页面回退、Takeout HTML/JSON | 双流/分页/消息字段样例测试 | 未登录真实账号；接口可能改动；达到请求回合上限标部分 |
| DeepSeek | 会话列表游标及历史接口 | 页面回退、已识别 JSON/文本 | 封装/片段/游标样例测试 | 未登录真实账号；未实现的额外消息页标部分 |
| Grok | 会话与响应节点接口、游标 | 页面回退、已识别 JSON/文本 | 缺失响应与规范化样例测试 | 未登录真实账号；缺失正文不作为完整读取 |
| Perplexity | 已授权网页侧栏发现，临时后台标签页读取可见问答 | 官方导出/文本 | 权限、通用 DOM/边界路径实现；无真实账号演示 | **部分自动读取**；虚拟化旧消息、历史侧栏外内容可能缺失 |
| Codex | 已知本地会话/归档目录；多页 JSONL、gzip/zstd；标题索引 | 选择日志或规范化导出 | 多页、压缩、去重、损坏隔离、取消、时间范围测试 | 未在用户真实完整资料库上运行；上下文压缩前原文可能已不在日志中 |
| Claude Code | 已知 projects 目录；JSONL 含文本和工具块 | 单日志/规范化导出 | 工具调用/结果与重复回合测试 | 用户已清理会话不可恢复；未知日志版本有警告 |
| Cursor | 已知用户存储目录；SQLite composer 和 bubble 键 | 规范化 JSON/文本 | 临时只读 SQLite 夹具 | **部分读取**；未保证覆盖未来 schema 或云端独有内容 |
| OpenCode | 已知本地数据目录；SQLite session/message/part 与旧 JSON | 规范化 JSON/文本 | SQLite 和旧目录夹具 | 未在用户真实资料库上运行；仅支持已识别 schema |

Every source is selectable and reports availability. “Local store found” is not proof that every session is readable. Website access and login are separate states. Other sources survive one provider failure. All browser fixtures are non-sensitive and do not use a developer login.

| 运行平台 | 构建目标 | 本次验证状态 |
| --- | --- | --- |
| Windows x64 | Electron 便携 `.exe` | 本机生产构建、Electron UI、打包和启动检查见验收报告 |
| macOS | DMG / ZIP | 提供构建配置；需 macOS runner 实测和发行签名/公证 |
| Linux | AppImage / DEB | 提供构建配置；需 Linux 桌面运行验证 |
| Chrome/Edge Manifest V3 | 已解压扩展 | 真实 Chromium 无头扩展测试通过；Edge 品牌浏览器未单独实测 |
| Firefox / Safari | 无发行目标 | 未实现 |

Codex and Claude Code installation uses detected existing configuration directories. Portable Agent Skills export is available for other products, but compatibility and actual tool invocation are not inferred from Markdown syntax alone.


## 0.1.5 自动发现与生成入口

检测读取已知存储中的真实消息，不把空目录、应用安装或网页权限当作可读历史。支持 CODEX_HOME、CLAUDE_CONFIG_DIR、XDG 与保存过的位置，Windows 可补查用户保存的路径变量，OpenCode 存在时尝试查询其数据路径。原生与 WSL 实例分开；WSL 真实环境仍待验收。

| 生成方式 | 检测与实现 | 实测范围 |
| --- | --- | --- |
| Codex CLI | 已有登录、隔离非交互分析、无持久会话、禁用工具 | 本机已登录的 0.164.0-alpha.11.1；真实模型的公开示例生成通过。受限真实项目首次生成零结果，未冒充成功；见验收报告。 |
| Claude Code CLI | 登录状态、无工具非交互与无持久会话 | 当前电脑未安装；代码路径存在，实际推理待验。 |
| Ollama | 本机回环服务和已安装模型列表 | 当前服务未运行，不显示为就绪。 |
| 高级兼容 API | 本机或 HTTPS 远程、地址绑定授权与密钥保护 | 边界与响应协议用模拟服务验证；实际服务效果取决于所选模型。 |
| 本机规则提取 | 无模型、明确步骤和证据门槛 | 公开示例与默认流程的重启/增量操作通过。 |

浏览器配置的选择、状态、命令与回传授权分别隔离；多个 Gemini 账户页面需明确选择。真实 Chromium 扩展配对与模拟 ChatGPT 网站链路通过。六个网站的真实账号覆盖仍未验证。

0.1.6 的受限真实 Codex 项目恢复验收已保存 1 个有原文引用的候选，2 段分析完成、1 段待预算；实际安装版重启保留了结果。范围和失败记录见 VERIFICATION.md。此结果不升级为全资料库、新任务效果或其他服务的验证。

## 0.1.8 生成入口更新

上述本机规则行属于历史版本；生产生成现须真实模型。默认入口为我的会员、本机模型、API。ChatGPT 官方直接授权、Codex、Claude、Gemini、Cursor 及 Ollama 的实现与逐项实测限制见 [会员接入表](FOCUS_AND_MEMBERSHIP.md)。历史读取能力与生成账户权限互不等同。

## 0.1.9 主流目录及双语更新

目录扩展至 17 个独立产品，中文/英文别名可搜索，默认按就绪状态与用途分组。原有采集能力不扩大宣称。**豆包、千问、腾讯元宝、Kimi、Microsoft Copilot、Meta AI、GitHub Copilot 目前仅文件导入，自动采集未实现**；可读取带角色的通用 JSON、Markdown、文本，不承诺兼容全部专有格式。新导入复用完整处理流水线，见 [格式样例](../examples/mainstream-import/README.md)。

生成助手按品牌合并，新增官方 API 预设区分地区和独立计费。界面语言与 Skill 输出语言分开，实际通过中文历史生成英文 Skill 的 Codex 套餐验收。其他新增平台账号未实测。详细实现和状态：[主流平台与双语](MAINSTREAM_AND_BILINGUAL.md)。
