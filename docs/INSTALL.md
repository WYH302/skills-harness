# 安装与使用 / Install and use

## Windows

双击交付目录中的 **`SkillHarbor-Setup-0.1.12-x64.exe`**。一键安装完成后，直接双击桌面 **SkillHarbor** 图标，或从开始菜单打开。程序自带运行环境，安装到当前用户，不请求管理员权限。可以在 Windows「已安装的应用」中找到卸载入口；卸载程序的配置保留个人资料库。

Run the Windows installer, then open SkillHarbor from its desktop or Start menu entry. It bundles the runtime and installs per user without administrator elevation. The Windows Installed Apps entry provides an uninstaller. Personal libraries are stored separately and configured to survive uninstall.

免安装用户仍可打开 `SkillHarbor-0.1.12-Windows-x64.exe`。便携包将程序资源解压到临时位置，资料库仍保存在用户目录。当前安装包和程序均未做代码签名，不代表已取得发行者认证。

The portable executable remains available. Both distributions are unsigned; no verified-publisher claim is made.

首次打开可先体验独立的示例工作空间。示例包含 8 段人工构造的非敏感对话，可以得到 3 个候选 Skills。退出示例后，真实资料库仍然独立。检测到目录只表示存在本地存储，不保证其中每条会话均可读取。

Use the isolated sample workspace first if desired. Returning to the real workspace does not mix example conversations into your private library.

## 浏览器首次连接 / Browser setup

在应用里点击「连接浏览器」，再点击「打开扩展文件夹」。程序把随附扩展复制到资料库下的固定 `browser-extension` 目录；Chromium 不会依赖便携程序的临时解压目录。

1. 打开 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions`。
2. 打开「开发者模式」，加载刚才文件夹中的已解压扩展。
3. 在扩展弹窗输入桌面配对码。配对码有效期十分钟，过期可在桌面刷新。
4. 在扩展中允许准备使用的网站，然后到网站自行登录。
5. 回到桌面选择来源，开始采集。扩展只向 `127.0.0.1:42837` 传送选定任务的数据。

Load the stable unpacked extension folder, pair it, grant access to selected websites, and sign in normally. The app does not ask for passwords or copied cookies. The supplied browser-extension ZIP is an additional distribution of the same extension. Chrome/Edge unpacked loading is supported; Firefox/Safari are not implemented.

See [BROWSER.md](BROWSER.md) for website-specific methods, limits and troubleshooting.

## 分析方式 / Analysis

默认先在本机整理并精选材料，预筛不调用模型。首页“切换助手”默认提供“我的会员／本机模型／API 接入”。可通过官方 ChatGPT 页面授权，或沿用已登录的官方客户端。普通 API Key 不是默认门槛。规则仅预处理，无模型时引导连接，不生成替代技能。具体账号、费用和实测范围见 [会员接入说明](FOCUS_AND_MEMBERSHIP.md)。没有足够具体步骤时，可能不生成技能。可以在设置中连接本机 Ollama 等 OpenAI 兼容服务，例如地址 `http://127.0.0.1:11434/v1`，并填写本机已经安装的模型名称。模型安装与下载由用户自己控制，应用不会自动下载大模型。

Local extraction has no model cost. A local OpenAI-compatible server can interpret less structured histories. Choose a model that is actually installed on that server; the app does not download model weights automatically.

远程服务需要完整服务地址、模型名称、必要的密钥，以及对该地址的明确传输同意。切换地址或处理方式会重置授权；密钥也绑定到保存时的服务地址和方式，不转发给另一个服务。设置的是兼容协议，不代表每个服务都已经测试。

Remote processing requires explicit endpoint-specific consent. Saved keys are bound to both endpoint and processing mode. Changing providers requires entering the relevant key and approving transfer again. Requests have timeouts, no redirects, and call/input/output budgets.

高级开发环境可使用 `SKILLHARBOR_API_KEY` 和匹配的 `SKILLHARBOR_API_ENDPOINT`。环境密钥只用于匹配的远程地址；点击移除密钥会在应用中禁用该环境密钥。不能使用操作系统加密的环境不会把密钥降级为普通明文文件。

## 导入、导出和安装 / Import, export and install

导入支持官方/规范化 JSON、JSONL、gzip/zstd 日志、ZIP、HTML、XML、Markdown 和文本。文本缺失的角色、日期或历史范围会保留未知标记，不会猜成完整对话。导入文件也是自动进入提炼流程，不要求手动挑选对话。

ZIP exports contain focused skill directories with `SKILL.md` and aggregate provenance. They omit source transcripts and local database files. Review the generated instructions and free text before sharing or installing.

应用只向检测到的 Codex / Claude Code 个人技能目录安装。路径来自已知目录与现有配置的检测，不来自模型输出。若目标技能已经存在，安装会停止以保留现有修改；使用导出进行人工合并。安装成功只说明文件写入目标位置，不证明助手已加载或执行该技能。

## 存储和恢复 / Storage and recovery

设置页可选择新存储文件夹。应用在重启时复制资料库和加密密钥；原位置保留，便于恢复。确认新位置正常后，可由用户处理旧副本。不要把资料库放在公开仓库或共享同步文件夹中。

Changed storage locations are applied on restart; the original copy is retained. Incomplete runs retain imported records and checkpoints. A source error does not erase successful sources. Failed sources can be retried independently. Unchanged conversations and completed model chunks reuse cached analysis.

自动生成不会覆盖用户修改；提案需要在技能详情中接受。恢复旧版本会创建新版本，保留原版本链。休眠和归档可恢复，不按固定六个月期限删除。

## 从源码构建 / Build from source

```sh
npm ci --registry=https://registry.npmjs.org
npm run typecheck
npm run build
npm start
```

`npm run package` builds a Windows x64 portable executable. `npm run package:all` selects the configured native target on its host. Windows builds were executed in this delivery; macOS/Linux builds require the corresponding machine, platform dependencies and any release signing/notarization desired by the publisher. CI configuration is supplied, but remote CI has not been dispatched or claimed as passing.

开发时可用 `SKILLHARBOR_DATA_DIR` 指定隔离资料库。测试使用临时目录和人工构造的数据，不读取开发者聊天历史。

## 常见问题 / Troubleshooting

| 情况 / Situation | 处理 / Action |
| --- | --- |
| 没生成 Skills | 检查是否有具体流程或重复任务。默认提取对模糊上下文保守；可配置本地模型。不要靠降低标准生成填充内容。 |
| 来源不可用 | 查看来源说明。打开本地应用产生会话，或连接浏览器；必要时导入官方导出。 |
| 接口失效或部分历史 | 保留警告和已导入结果，重试失败来源或补充导出文件。部分页面采集不能升级宣称为完整历史。 |
| 模型预算达到上限 | 已完成的分块缓存保留。增加预算或再次运行；不重放已经成功分析的块。 |
| 端口被占用 | 关闭另一个 SkillHarbor 实例。默认采集桥接固定为 42837，避免扩展连接任意网络地址。 |
| Electron 下载慢（开发） | 从 Electron 官方 Release 获取与锁文件相同的版本，核对官方 SHA256；不要安装未验证来源的二进制。 |


默认入口已改为自动发现与一键生成，见 [操作说明](ONE_CLICK.md)。无需先手动指定历史目录或新建 API 配置。`npm run package` 现在同时生成 Windows 安装程序与便携程序。

## 语言与主流品牌

顶栏或弹窗的“简体中文｜English”即时切换界面，不消耗模型额度。设置中另选 Skill 输出语言。生成助手先选择品牌，再连接官方账号、已登录客户端或对应 API；地区与计费类型需按所选服务确认。新增豆包等七个来源目前仅文件导入，详见 [能力范围](MAINSTREAM_AND_BILINGUAL.md)。
