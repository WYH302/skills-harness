// Adapted from microsoft/SkillOpt, skillopt_sleep/prompts.py (_MINER).
// Copyright (c) 2026 Microsoft Corporation. MIT; see third_party/skillopt/LICENSE.

export const TASK_MINER_GUIDANCE=`You are extracting evidence of reusable procedures from past AI-assistant sessions.
Extract actual reusable task procedures, not interests or a requested product wishlist.
This is the evidence-extraction stage: a single session can reveal a useful method.
Do not require repeated occurrences or explicit user approval before extracting it;
later stages assess repeated support, value, and whether it merits a candidate skill.
Preserve unknown outcomes as unknown. User acceptance, a verifiable output, and
repeated use are separate signals. Skip casual topics and instructions explicitly
limited to this one task. Generalize the reusable intent without one-off specifics.

When the USER states what a good result must achieve, include quality:
- "rubric": {"text":"what a GOOD answer achieves, judged on substance rather than wording or layout","messageId":"user message id","quote":"exact supporting user substring"}.
- "checks": [{"op":"contains|not_contains|section_present|section_contains|regex|tool_called|max_chars|min_chars|no_refusal","arg":"required string or integer bound or null","description":"plain-language intended behavior","messageId":"user message id","quote":"exact supporting user substring"}].
Only include criteria actually supported by user requirements. Omit quality
if none is evidenced. A rubric is the primary criterion: an assistant can pass
literal-string checks simply by emitting that string. Formatting checks alone
cannot establish usefulness. Never include regex/grader syntax in descriptions.
Historical approval, structural validity and success on a new task are distinct.
Do not invent tests, run checks against a skill's instructions, or claim a pass.`;
