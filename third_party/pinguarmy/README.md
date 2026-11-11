# Reused provider code

Source: https://github.com/pinguarmy/ai-chat-exporter

Pinned commit: `58d7d9f5e729ef47e3fec326115b79f607af576a` (inspected 2026-10-26).

License: MIT. The upstream copyright and license are reproduced in LICENSE and in the extension's vendor/PINGUARMY_LICENSE.txt.

`extension/vendor/provider-normalizer.mjs` adapts the timestamp, role, text/envelope normalization from `src/lib/api-message-normalizer.ts`, DeepSeek fragment/history decoding from `src/contents/deepseek-parser.ts`, and Gemini RPC list/turn parsing from `src/contents/gemini-parser.ts`. `extension/providers.mjs` adapts API request sequences and pagination from the ChatGPT/Claude/Gemini/DeepSeek parsers and `src/lib/grok-api.ts`.

Changes include removing extension-framework dependencies, keeping provider credentials only transiently inside the original website context, normalizing to SkillHarbor's schema, retaining tool roles, resuming at conversation boundaries, and reporting partial coverage conservatively. No code from rc2barrington/ai-chat-exporter is included because no license was present at inspection.
