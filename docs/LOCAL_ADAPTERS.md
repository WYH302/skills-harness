# Local history adapters / 本地历史采集

All local stores are opened read-only. Discovery is limited to the documented session directories below, respects `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, and does not read credentials, arbitrary paths mentioned in conversations, or attachment contents. Symbolic links are skipped. Tests use synthetic stores under the OS temporary directory, never the developer's real history.

| Source | Automatically discovered storage | Reading behavior and limits |
|---|---|---|
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions` | Joins rollout pages by session UUID; chooses one copy of each page across archive and compressed copies; reads `.jsonl`, `.jsonl.gz`, `.jsonl.zst`; preserves user, assistant, function calls and results; suppresses mirrored `event_msg` records where a matching `response_item` exists. Compacted context and malformed/interrupted lines are reported as partial. |
| Claude Code | `~/.claude/projects/**/*.jsonl` | Reads user/assistant content blocks, tool calls and results. Stable event UUIDs deduplicate repeated records while distinct user turns remain distinct. Subagent session logs are separate conversations. |
| Cursor | Windows `%APPDATA%/Cursor/User/{globalStorage,workspaceStorage}`, macOS `~/Library/Application Support/Cursor/User/...`, Linux `$XDG_CONFIG_HOME/Cursor/User/...` | Read-only `state.vscdb`; supports `cursorDiskKV` composer/bubble keys and legacy `ItemTable` chat records. Always reports partial coverage because the private storage schema, unloaded bubbles and cloud-only data cannot be verified. |
| OpenCode | `$XDG_DATA_HOME/opencode` or `~/.local/share/opencode` | Read-only `opencode.db` session/message/part schema and legacy `storage/{session,message,part}` JSON. Tool calls and tool results remain separate events. |

Missing applications or stores are shown as unavailable. New or incompatible schemas emit a warning rather than inventing empty successful history. Per-file failures do not abort other sessions or sources. Date filters retain conversations whose recorded time range overlaps the requested dates; records without timestamps are retained with a warning because their dates cannot be verified. Cancellation checks occur during enumeration and between streamed records. Checkpoints identify the last discovered session; safe resumed runs re-enumerate current stores and rely on the central stable-identity/content-hash importer to skip unchanged records. These adapters do not bypass source privacy controls or recover deleted history.

Each ordinary session file and expanded compressed session is limited to 512 MiB. Larger records are explicitly rejected. This prevents a malformed or compressed file from exhausting memory. The application does not silently truncate content.

## Manual provider export import / 手动导出补充入口

- Canonical SkillHarbor JSON, including source, original IDs, roles, timestamps, tool names and completeness.
- ChatGPT `conversations.json`, including the current branch. Alternative answer branches are reported as excluded; such conversations are marked partial.
- Claude official JSON `chat_messages` exports.
- Structured Gemini turn/history JSON.
- Codex / Claude Code JSONL, gzip and zstd logs.
- ZIP archives containing supported exports. Names are validated against traversal; compressed input and total expanded selected entries are limited to 512 MiB, each expanded entry to 256 MiB. When `conversations.json` exists its HTML mirror is not imported twice. Account/profile/settings/auth JSON entries are excluded.
- Gemini Takeout activity HTML is preserved as explicitly partial activity text. It does not invent assistant/user boundaries or successful outcomes.
- Role-labelled XML and Markdown/text exports with recognizable user/assistant headings preserve those roles. Unlabelled text is imported as system context and marked partial rather than treated as successful task evidence.

Manual exports supplement automatic collectors. They do not establish that a whole account was collected. Original provider timestamps and branch limits remain visible in provenance. Live schema compatibility still requires user-authorized verification with the respective application versions; synthetic format tests do not prove access to a real logged-in account.

## 0.1.5 availability

Known application data locations are inventoried asynchronously; readable conversation records, empty stores, permissions and absent stores are distinct. Native and WSL stores are separate instances. No whole-drive scan runs at startup. Large Codex metadata headers are skipped structurally before determining message availability, rather than mistaking a fixed-size header sample for the complete store. Manual folder selection remains a recovery entry.

A controlled real-data QA mode filters Codex session metadata by the explicitly authorized project before importing any messages. It can exclude the currently active session so an unchanged rerun can be checked reproducibly. Those controls are test-only and never silently narrow a normal user's collection.
