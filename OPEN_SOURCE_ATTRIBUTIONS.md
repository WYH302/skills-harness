# Open-source components and implementation references

Inspected on 2026-10-26. Public repositories were read; no private account data was used. Licenses below apply only to the stated code. A publicly visible repository without a project license was not treated as permission to copy.

| Project | Inspected revision | License verified | Actual use |
| --- | --- | --- | --- |
| [pinguarmy/ai-chat-exporter](https://github.com/pinguarmy/ai-chat-exporter) | `58d7d9f5e729ef47e3fec326115b79f607af576a` | MIT, copyright 2024 AI Chat Exporter Contributors | Adapted provider normalization, Gemini/DeepSeek decoding, ChatGPT/Claude/Grok request and pagination sequences in `extension/vendor/provider-normalizer.mjs` and `extension/providers.mjs`. Removed the Plasmo/export UI framework and credential transport. Changes documented in `third_party/pinguarmy/README.md`. Full license accompanies source and extension. |
| [rc2barrington/ai-chat-exporter](https://github.com/rc2barrington/ai-chat-exporter) | master retrieved 2026-10-26 | **No repository license found; GitHub license metadata null** | Architecture/format reference only. Examined local discovery, multipage/compressed session considerations, website boundaries and test coverage. No source copied or bundled. Local adapters were independently implemented against supported log/SQLite formats. |
| [Qwen-Applications/Trace2Skill](https://github.com/Qwen-Applications/Trace2Skill) | `3d0b52a140f002a512930252b613c49048f7d5ac` | **No root project license found; GitHub license metadata null** | Concepts only: successful and failed traces as distinct evidence, local lesson extraction followed by deduplication and consolidation. Reviewed evolution coordinator/prompts; no code, prompts, released Skills, datasets or benchmark framework copied. Licenses inside particular bundled assets do not license the entire project. |
| [microsoft/SkillOpt](https://github.com/microsoft/SkillOpt) | `e2edfa9721ce41c98e50fa129da87cf1f53c2f7f` | MIT, copyright 2026 Microsoft Corporation | **Source and prompt adaptation since 0.1.2**: SkillOpt-Sleep's Codex context/replay filtering, model JSON extraction, checkable task mining prompt, rubric/check normalization, integer-bound validation and formatting-only distinction in `src/vendor/skillopt/`. Called by the production mining pipeline and reflected in generated Skill criteria. Full mapping, modifications and license in `third_party/skillopt/`. The heavyweight replay/benchmark framework is not included. |

The browser exporter is an extension-oriented source with provider and recovery tests and recent October 2026 activity; its isolated API logic fits the browser bridge. The second exporter combines a local Node service and browser extension with format/reliability tests, but absent licensing prevents reuse. Trace2Skill is a Python research/evaluation tree with task-agent dependencies; incorporating it would add unrelated workloads. SkillOpt also contains a separate, lightweight `skillopt_sleep` implementation: selected source and prompt logic are now adapted into the desktop runtime. Its full training loop remains outside this product's cost and dependency requirements. No upstream test result is presented as a SkillHarbor test result.

## Runtime dependencies

Dependencies are pinned in `package-lock.json`. Their distributions retain their own license files. Electron packages also include Chromium/Node and third-party license notices.

| Dependency | License | Purpose |
| --- | --- | --- |
| Electron | MIT, with bundled third-party notices | Cross-platform desktop runtime and OS credential encryption |
| React / React DOM | MIT | User interface |
| Lucide React | ISC | Interface icons |
| fflate | MIT | ZIP export/import |
| [jsdiff / diff 9.0.0](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Line-by-line revision comparison in `src/renderer/RevisionDiff.tsx`. Uses bounded `diffLines` with timeout/edit-distance limits. No network service or model call. Full license copied to `third_party/jsdiff/LICENSE`. |
| yaml | ISC | Agent Skills metadata parsing and generation |
| [jose 6.2.13](https://github.com/panva/jose) | MIT | OpenID Connect ID-token signature/JWKS verification for official ChatGPT plan authorization. Full license: `third_party/jose/LICENSE`. |
| Zod | MIT | Boundary/schema validation |
| Node.js | MIT and bundled notices | SQLite, read-only local file handling, compression and loopback server |
| Inter Variable 5.3.0 / Noto Sans SC Variable 5.3.1, distributed by Fontsource | SIL Open Font License 1.1 | Bundled Latin/CJK UI fonts. Assets are served from the packaged app, with no font CDN requests. Full licenses are in `third_party/fonts/`. |
| Vite, esbuild, TypeScript, tsx, Playwright, electron-builder | MIT / Apache-2.0 as distributed | Build and verification tools; not a hosted runtime service |

See `third_party/pinguarmy/LICENSE`, `extension/vendor/PINGUARMY_LICENSE.txt` and `third_party/skillopt/LICENSE` for adapted-code notices. Original SkillHarbor code is MIT licensed. The user retains control of imported records and generated personal Skills; the app's source-code license does not grant access to those private records.

## Local selection reference (0.1.7)

The sparse TF-IDF/cosine selector in `src/core/selection.ts` is original TypeScript, reusing this application's existing SkillOpt-adapted context filtering and tokenizer. The [scikit-learn text clustering example](https://scikit-learn.org/stable/auto_examples/text/plot_document_clustering.html) was read as an algorithm reference, not copied or bundled. No scikit-learn/Python runtime, remote embedding service, downloaded model or new dependency is implied. The lexical method has explicit cross-language and long-context limitations; see `docs/LOW_COST_AND_UX.md`.

## Mainstream/bilingual integration (0.1.9)

The catalog, alias routing, bilingual display, output-language snapshot and API presets are original integration code. New file-only sources reuse the existing import/normalization, hashing, mining and delivery components; new API presets reuse the endpoint-bound compatible transport, rather than bundling seven SDKs. Provider documentation was used as interface reference only; no additional repository code or dependencies were incorporated. Existing MIT/BSD/ISC/OFL notices remain included. API documentation and unverified live-account limits are recorded in docs/MAINSTREAM_AND_BILINGUAL.md.
