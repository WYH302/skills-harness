// Adapted from microsoft/SkillOpt, skillopt_sleep/harvest_codex.py and backend.py.
// Copyright (c) 2026 Microsoft Corporation. MIT; see third_party/skillopt/LICENSE.
// Upstream: e2edfa9721ce41c98e50fa129da87cf1f53c2f7f. Port and changes documented there.

export function stripCodexMeta(text:string):string {
  let stripped=text.trim();
  if(stripped.startsWith('<external_codex_apps_open_page>')) {
    const end=stripped.indexOf('</external_codex_apps_open_page>');
    stripped=end>=0?stripped.slice(end+'</external_codex_apps_open_page>'.length).trim():'';
  }
  if(!stripped||stripped.startsWith('<codex_internal_context')||stripped.startsWith('<subagent_notification')||stripped.startsWith('<turn_aborted')||stripped.startsWith('<app-context')||stripped.startsWith('<send_user_message_question_reply'))return '';
  if(/^#?\s*Files mentioned by the user:/i.test(stripped)) {
    for(const marker of ['## My request for Codex:','## My request:']) {
      const idx=stripped.lastIndexOf(marker);
      if(idx>=0) {
        const tail=stripped.slice(idx+marker.length).trim();
        const imgIdx=tail.indexOf('<image ');
        const cleanTail=(imgIdx>=0?tail.slice(0,imgIdx):tail).trim();
        if(cleanTail)return cleanTail;
      }
    }
    const firstNewline=stripped.indexOf('\n');
    return firstNewline>=0?stripped.slice(firstNewline+1).trim():'';
  }
  const wrapped=/^(?:#\s*AGENTS\.md instructions|<environment_context\b|<INSTRUCTIONS>|<permissions instructions>|<recommended_plugins>)/i.test(stripped)||stripped.includes('--- project-doc ---');
  if(!wrapped)return stripped;
  // Upstream recovers the real request appended after the harness wrapper.
  // Also accept an environment-only wrapper followed by a request.
  for(const marker of ['</environment_context>','</INSTRUCTIONS>','</permissions>','</recommended_plugins>']) {
    const index=stripped.lastIndexOf(marker);
    if(index<0)continue;
    const tail=stripped.slice(index+marker.length).trim();
    if(tail&&!tail.startsWith('<')&&!/^#\s*AGENTS\.md instructions/i.test(tail))return tail;
  }
  return '';
}

export function isCodexReplay(prompts:string[]):boolean {
  const prompt=prompts[0]||'';
  return prompt.startsWith('[skillopt-sleep:codex-engine:v1]\n\n')||
    prompts.some(p=>p.startsWith("You are SkillOpt's optimizer.")||p.includes("You are mining a user's past AI-assistant sessions to find RECURRING tasks")||p.startsWith('[skillopt-sleep:'))||
    (['Complete the task. Apply the skill and memory rules exactly,','Complete the task. Apply the skill and memory rules EXACTLY,'].some(prefix=>prompt.startsWith(prefix))&&
    ['\n# Skill\n','\n# Memory\n','\n# Task\n'].every(section=>prompt.includes(section)));
}

export function extractJsonObject(raw:string):unknown {
  // The upstream CLI adapter accepts an object surrounded by explanatory prose.
  // JSON.parse still rejects malformed/multiple objects; no eval or JSON execution.
  const match=raw.match(/\{[\s\S]*\}/);
  if(!match)throw new Error('Model did not return a JSON object');
  return JSON.parse(match[0]);
}
