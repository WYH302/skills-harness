# 浏览器连接 / Browser connection

SkillHarbor 的浏览器扩展只把你授权网站中的历史传给同一台电脑的桌面应用。它使用网站当前登录状态，不要求密码或复制 Cookie。扩展没有 `cookies`、`debugger`、浏览器历史记录或下载权限。

The browser extension sends authorized conversations only to the desktop application on the same computer. It uses the signed-in website context. Password entry and copied cookies are not required. It has no cookies, debugger, browsing-history, or download permission.

## 安装 / Install

1. 打开 SkillHarbor，在「连接浏览器」中找到扩展目录和配对码。源码目录是 `extension/`；桌面包内随附同一个目录。
2. 在 Chrome 打开 `chrome://extensions`，或在 Edge 打开 `edge://extensions`，启用「开发者模式」，选择「加载已解压的扩展」，选中该目录。
3. 打开工具栏中的 SkillHarbor 扩展，输入桌面应用显示的配对码。配对码有效期为十分钟；过期后在桌面应用重新生成。
4. 在扩展中勾选准备使用的网站，点击「允许选中的网站」。浏览器会单独显示网站访问授权。未授权的网站不会访问。
5. 打开所选网站并自行登录。回到桌面应用刷新来源状态，勾选来源，点击「收集历史并生成 Skills」。

In Chrome/Edge, load the shipped `extension/` directory as an unpacked extension. Pair it with the code shown in the desktop app, grant access to the websites you select, and sign in to those sites normally. Start collection from the desktop app. No build step or Chrome Store account is required for the unpacked extension. Firefox and Safari builds have not been implemented or verified.

## 实际采集方式 / Collection methods

| 来源 / Source | 自动路径 / Automatic path | 读取范围与限制 / Scope and limitations |
| --- | --- | --- |
| ChatGPT | Same-origin session + conversation list/detail APIs | Paginates normal and archived list partitions; analyzes the structurally selected active message branch. Regenerated alternatives are reported but not merged. Organization/workspace visibility remains controlled by the current account. |
| Claude | Bootstrap organization memberships + per-organization paginated conversation APIs | Lists accessible memberships separately; selects an explicit or unambiguous root-to-leaf message chain, preserving exposed tool blocks. Ambiguous/missing-parent trees fall back to partial page capture. |
| Gemini | `MaZiqc` account-history RPC streams, `hNvQHb` conversation RPC | Reads both provider history streams, follows continuation tokens, and decodes typed user/answer fields. A response at the 1,000-turn request limit is marked partial. The currently open `/u/N/` account is retained. |
| DeepSeek | `chat_session/fetch_page` with cursor; legacy `chat/history` fallback | Decodes provider envelopes and visible fragments. HTTP authentication or API-shape changes may require export import. Hidden reasoning is not imported. Additional unimplemented message pages are marked partial when reported. |
| Grok | Conversations, conversation-v2, response-node and load-responses APIs | Cursor pagination; validates conversation identity and matches requested response IDs to bodies. Missing bodies are partial. |
| Perplexity | Sidebar discovery + rendered message capture in temporary tabs | **Partial automatic collection.** Captures recognized visible questions/answers; earlier virtualized messages and older/archived threads may be absent. Does not claim complete server history. |

以上接口源于网站当前工程实现，不是承诺长期稳定的官方开发接口。对话列表的接口分页结束，不代表已删除的、账号无权限的、平台未暴露的内容能够恢复。接口失败时，扩展保留已经采集的结果；必要时退回侧栏/页面读取，并将覆盖范围标记为部分。

These endpoints follow current website implementations, not guaranteed public APIs. End-of-pagination means the available account response ended; it does not prove deleted, unauthorized, or platform-hidden data was recovered. API failure preserves earlier results. Sidebar/page fallbacks always report partial coverage. No live authenticated-provider collection was performed during development unless specifically recorded in the verification report.

## 恢复、增量和日期 / Recovery, increments and dates

- Every acknowledged conversation is checkpointed. Service-worker suspension resumes the persisted queue; duplicate deliveries are harmless because the desktop normalizes stable identities and content hashes.
- Checkpoints contain a compact index, list fingerprint, and failed IDs. If the discovered list changes, collection restarts safely and existing records are deduplicated. A normal new run rediscovers records so modified conversations are not skipped merely because their IDs were seen before.
- Network/rate-limit retries use at most three attempts with bounded backoff. Authentication failures require the user to reconnect. After 100 conversation failures, a source stops with a recoverable error instead of hammering the service.
- Cancellation is checked between bounded provider reads. It may take one pending request (at most 30 seconds) to stop. Already imported conversations remain available.
- Date selection filters the provider's conversation activity timestamp when available. Conversations with missing dates are retained with a warning; the app does not invent dates or silently omit them.
- The extension briefly opens background tabs for rendered-page fallback, closes only those tabs, and never navigates or closes a user's existing tab. DOM discovery may scroll a sidebar and restores its previous scroll position.

## 隐私与通信 / Privacy and transport

配对使用本机 `127.0.0.1:42837`，配对后每个请求需要随机访问令牌。令牌只存于扩展本地存储；桌面保存哈希。扩展不向网站传送本机访问令牌。网站自己的临时请求令牌只在原网页中的同源请求函数内部使用，不会进入扩展存储或桌面数据库。

The authenticated loopback bridge accepts only the desktop's expected host and approved extension-origin/custom-header requests. Pairing still requires the short-lived code. Provider credentials remain transient inside the original website request function; only imported conversation data and progress enter the bridge. There is no page `postMessage` command channel, arbitrary fetch operation, or externally-connectable extension API. Imported text cannot authorize commands.

## 故障排查 / Troubleshooting

| 现象 / Symptom | 操作 / Action |
| --- | --- |
| 未配对 / Not paired | Open desktop, request a fresh pairing code, then pair again. |
| 网站未授权 / Website not allowed | Select the website in the popup and accept the browser's host permission prompt. |
| 请登录 / Sign-in needed | Open the selected service in this browser profile and sign in yourself. Refresh extension status. |
| 部分读取 / Partial coverage | Read the source warning. Import an official provider export if more history is available there. |
| 更新后仍使用旧扩展 / Old extension after upgrade | Replace the extension folder, click Reload on the browser extensions page, then reopen affected site tabs. |
| 端口被占用 / Port in use | Close another running SkillHarbor instance. The extension deliberately uses a fixed loopback port, not arbitrary network endpoints. |
| 会话过大 / Conversation too large | The bridge rejects bodies above its documented limit instead of truncating them silently. Use an exported file import for that conversation. |

自动接口兼容性需要随网站变更维护。扩展是已实现的产品组件；是否在某个登录账号上实测成功，应以验收报告中的实际记录为准。

## 已执行的开发验证 / Executed development checks

`tests/extension.test.ts` covers provider-domain boundaries, active-branch selection, repeated-text preservation, exposed tool blocks, Gemini typed RPC decoding and dual-stream pagination, DeepSeek envelopes/fragments, missing Grok responses, partial pagination, bounded retries, and extension privileges. The optional `SKILLHARBOR_EXTENSION_SMOKE=1` test also passed in a fresh headless Chromium profile against the actual desktop bridge. It pairs the shipped service worker, routes a non-sensitive synthetic ChatGPT website, exercises ordinary/archived API discovery and canonical conversation delivery, and verifies that the synthetic website session token is absent from imported events. This is an integration demonstration using fixtures, not a claim of live account compatibility.

## 0.1.5 连接和账户

每个浏览器配置显示类似 `Chrome · a1b2c3` 的独立名称。首页选择要使用的浏览器，程序保存该选择；其他浏览器收不到其采集命令，也不能提交其结果。已配对时展开「连接另一个浏览器」可取得新的配对码。

网站缺权限时点「授权访问此网站」，会在所选浏览器打开扩展的授权页；需要登录时点「打开网站并登录」，打开该浏览器的官方网站。授予权限或页面完成加载后自动复检。Gemini 同时打开多个账户页面时，在扩展中选择账户页面，避免自动混入其他账户。没有真实账号时，本地可用来源照常处理。
