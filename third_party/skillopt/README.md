# SkillOpt-Sleep components used in SkillHarbor

Upstream: https://github.com/microsoft/SkillOpt

Pinned revision: `e2edfa9721ce41c98e50fa129da87cf1f53c2f7f`.
License: MIT, Copyright (c) 2026 Microsoft Corporation. The complete notice is in `LICENSE`.

These are TypeScript adaptations of specific upstream source, called by the application at runtime. They are not an installation of the whole Python framework.

| Upstream source | Adapted implementation | Production caller |
| --- | --- | --- |
| `skillopt_sleep/harvest_codex.py`: `_strip_codex_meta`, `_is_codex_replay` | `src/vendor/skillopt/history.ts` | `src/core/mining.ts`: both extractive and model analysis |
| `skillopt_sleep/backend.py`: `_extract_json` | `src/vendor/skillopt/history.ts` | Model response decoding |
| `skillopt_sleep/llm_miner.py`: `_mk_task` check normalization and rubric priority | `src/vendor/skillopt/task-contract.ts` | Source-supported task acceptance requirements |
| `skillopt_sleep/judges.py`: `char_bound`, `is_shape_only`, semantic descriptions rather than verifier syntax | `src/vendor/skillopt/task-contract.ts` | Criterion parsing and formatting-only warnings |
| `skillopt_sleep/prompts.py`: `_MINER` | `src/vendor/skillopt/prompts.ts` | The actual configured model's extraction system prompt |

## Changes for this application

- Replaced Python dataclasses and backend classes with the desktop app's typed episode/criterion records. No Python runtime or upstream training dependencies are required by the delivered app.
- Recover a request appended after a standalone environment wrapper as well as an AGENTS wrapper. Keep original messages unchanged in the private history store.
- JSON decoding throws on absent/malformed objects so the existing bounded fallback is invoked; upstream returns `None`.
- Require exact citations to user messages for rubrics/checks. Missing, fabricated, assistant-authored or malformed criteria are discarded. A source citation establishes where a requirement came from; it does not prove the model's paraphrase is semantically correct.
- Preserve upstream integer/regex-whitespace parsing; additionally reject integers outside JavaScript's safe range and omit checks without a plain-language description. Never execute imported regexes or tools.
- Prefer substantive rubrics; distinguish formatting-only checks. Put criteria into the generated Skill for future use without claiming that a new task passed. A task without criteria can still supply an explicitly accepted reusable procedure; missing criteria are not invented.
- Replace the upstream miner's Boolean satisfaction inference with the app's explicit user-feedback chronology, preserving unknown outcomes. A later rejection invalidates the earlier procedure; a later corrected method supersedes a longer rejected answer. This chronology fix is SkillHarbor code, not attributed as an upstream feature.
- Retain local processing by default, endpoint-bound remote consent, redaction, shared call/input limits, chunk caches and safe fallback. No raw prompts/responses are written to diagnostics.
- No replay agents, automatic command execution, judge-score optimization, large benchmark loops, automatic prompt overrides or remote telemetry were adopted.

`tests/skillopt.test.ts` exercises the production call path. `scripts/check-skillopt-port.ts` compares common cases against pure functions from a local checkout of the pinned upstream revision; it needs Python for this development-only comparison. Deliberate adaptation differences above are checked separately by the TypeScript tests.

The absence of a project-wide license still prevents copying code/prompts from the other inspected Trace2Skill and rc2barrington repositories. Their conceptual references remain separately identified in `OPEN_SOURCE_ATTRIBUTIONS.md`.

0.1.5 separates evidence extraction from candidate promotion: the adapted miner no longer requires within-session repetition or explicit approval before extracting an executed procedure. Outcomes remain unknown unless supported. This avoids rejecting all evidence before cross-history organization can operate. Model analysis can use a documented, bounded focused view; exact source citations are still required.
