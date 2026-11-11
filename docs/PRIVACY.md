# 隐私与数据控制 / Privacy and control

## 默认处理 / Defaults

历史存储、结构化、缓存和技能管理在本机运行。启动时可以检查已知历史位置和工具登录状态；选择生成方式并确认前，不向 AI 服务发送历史，不采集使用统计，也不设置隐藏遥测。公开源码、发行包、截图和演示只使用人工构造的非敏感内容。

History, analysis caches, task episodes, provenance and Skills are stored locally in SQLite. Example data and your real library use separate databases. There is no analytics service or hosted conversation database.

## 访问范围 / Access

本地采集只读访问已知应用会话目录和受支持的日志/数据库。不会把聊天中出现的任意路径当成读取许可，也不读取配置中的 API 密钥、浏览器密码或认证文件。目录扫描跳过符号链接，输入和解压有大小限制，失败会报告。

Browser access uses optional website permissions and authenticated in-page requests. The extension has no cookies, debugger or browser-history permission. Website request credentials remain inside the website context, are not sent to the desktop bridge, and are not imported as history. The extension accepts commands only from the paired desktop queue, not from page messages.

配对只在 `127.0.0.1:42837` 提供服务。短期配对码和随机访问令牌共同防止外部页面直接导入或启动采集。桌面保存令牌哈希。Host、来源或专用扩展请求头、Bearer 以及命令来源都受检查。

## 模型传输 / Model transfer

本地模型模式仅接受明确的回环地址，并禁止跳转。远程模式要求 HTTPS、选定地址的明确同意和必要的服务密钥。更换地址或模式会清除旧授权，保存的密钥绑定到原地址和模式，不会转发给新服务或本地推理。

When remote processing is enabled, task-related user/assistant messages and necessary tool text are sent to the configured provider in bounded windows. Common keys, email addresses, home paths and phone-like numbers are redacted by default. This filter cannot identify every private detail in arbitrary free text; inspect history and provider choice before consenting. The provider receives message excerpts rather than the SQLite file. Provider retention policies are outside this application.

模型没有执行工具、访问文件或安装技能的权限。它必须返回结构化经验及来源引用；不存在于输入消息中的引文会被拒绝。来源文字、提示词和生成指令均视为不可信内容，不能授权应用运行命令。生成 Skills 默认待确认、未启用。

## 密钥和日志 / Keys and diagnostics

手动保存的密钥使用 Electron `safeStorage` 和操作系统密钥保护，不写入 SQLite、源码或一般日志。移除密钥会删除加密文件，并禁用应用中的环境密钥。环境变量密钥还必须具有匹配的服务地址。

Operational errors use fixed text or sanitized status/code values, not response bodies, private source text or complete request URLs. The app does not write raw transcripts into diagnostic files. OS permissions restrict the local database to its user profile; full-disk encryption and OS account protection remain the user's environment controls.

## 导出和安装 / Export and installation

分享 ZIP 不包含原始消息、账号、会话 ID、来源链接或数据库。包中包括技能正文、聚合依据和验证范围说明，正文也应用常见敏感模式脱敏。用户手工写入的姓名、机密业务内容等仍可能存在于正文，分享前应预览。

Installation writes reviewed files only to a detected compatible agent directory. Existing skills are not overwritten. No generated script is automatically executed. “Installed” means files were written; “available” depends on the receiving agent; “used” needs actual task evidence. The router only suggests enabled active Skills and does not report those suggestions as real usage.

## 删除和保留 / Deletion and retention

| 操作 | 实际影响 |
| --- | --- |
| 清除分析缓存 | 删除缓存并使记录待重新处理；保留原始历史、任务依据、技能编辑和版本 |
| 删除导入历史 | 删除原始记录、片段、缓存和运行记录；保留独立管理的技能与版本，清空可追溯依据、禁用并标为待复核 |
| 删除技能库 | 删除技能和对应版本；不删除原始历史 |
| 删除全部工作空间资料 | 删除当前资料库的历史、衍生内容、技能、版本和运行记录 |

操作不会删除网站或源应用中的历史，也不会移除已经安装到其他助手的独立副本。删除全部资料不替用户撤销浏览器端权限；可以在扩展管理页撤销权限或删除扩展。改存储位置时为恢复保留的旧副本也需单独处理。

SQLite vacuum/checkpoint is used after erasure. Secure recovery guarantees for SSDs, backups and OS caches are not asserted. The app preserves valuable dormant/archived skills until the user removes them; it does not delete them solely because six months passed.


## 已登录工具与重点分析

Codex / Claude Code 的登录状态由各工具自己的状态命令确认，认证文件内容不由 SkillHarbor 读取或复制。调用使用当前登录账户，可能消耗其额度或 API 费用；首次选择远程生成方式需同意。工具会自行处理其认证。CLI 子进程通过标准输入接收片段，使用隔离目录，不保存分析会话，不启用执行工具或插件。工具版本不足以隔离时会要求更新。

默认重点分析会跳过系统和大段重复输出、选取部分工具证据，并对很长消息抽取原文片段；原始历史完整保存在本机。可以切换为完整记录分析。此范围会在界面和运行说明中标注。引用需要匹配原始消息。

浏览器状态与采集命令绑定到所选配置。其他配对浏览器不能获取或提交该任务的内容。授权不足和登录失效分别显示，使用该浏览器的官方页面补足授权，不请求密码或复制 Cookie。

0.1.6 的本机分析缓存可保存待校验模型回复，供格式和引用校验重验使用，以避免反复传输同一片段。它属于私有衍生资料，不是公开诊断日志；清除分析缓存或对应资料会按现有删除范围清除这些缓存。错误分类只保留固定类型及校验字段路径，不写原文或服务响应正文。

0.1.7 默认先做本地 TF-IDF 去重、分组和代表材料选择，预筛不调用远程摘要/embedding 或本机推理，也不下载模型。只有选中的代表片段进入已授权的生成方式。代表预览及组级缓存包含私有摘录，保存在同一个本机资料库，不进入诊断日志或导出技能；删除历史、衍生资料或全部资料都会删除这些摘录元数据。初始长任务说明使用相关片段，不声称逐字完整理解全部历史。

## 0.1.8 官方套餐授权

ChatGPT 直接账号授权使用官方 OAuth 页面和公开推理接口，回环回调和 ID Token 经校验，令牌以操作系统加密文件独立保存，不进入 SQLite、日志或导出包。退出尝试远程撤销并清除本机令牌；撤销未确认时会说明。CLI 账号继续由官方客户端保存，不复制网页认证数据。Gemini 禁用工具、钩子、扩展、技能和 MCP；Cursor 在全局自动化无法隔离时拒绝自动分析，当前参数输入也有长度限制。详见 [账号与数据](FOCUS_AND_MEMBERSHIP.md)。
