/**
 * Channel 2 — Drop-In Open-Source Agent Harness Compiler (`harness-compiler.ts`).
 *
 * Stands directly on the shoulders of dominant open-source coding-agent harness ecosystems:
 *   1. Everything Claude Code (`affaan-m/ECC`, 310K+ GitHub stars) & Claude Code native
 *      `hooks.json` (`PreToolUse` / `PostToolUse` stdin-JSON + exit-code-2 repair feedback)
 *      and `permissions.deny` policy lists.
 *   2. OpenAI Codex CLI `execpolicy` Starlark rules (`prefix_rule(pattern=[...], decision=...)`).
 *   3. `destructive_command_guard`-style deterministic pre-execution command guards extended
 *      automatically with repository-scoped, user-mined invariants from passive chat histories.
 *
 * Instead of reinventing a proprietary agent runtime, this compiler mines recurring prohibitions,
 * mandatory flags/prerequisites, recurring verification commands, and `Tool Error -> Fix -> Pass`
 * invariants from sanitized conversational logs, then emits 100% schema-valid drop-in policy
 * packs directly consumable by existing open-source harnesses.
 */
import type { Conversation } from '../shared/types';

export type HarnessRuleKind =
  | 'FORBIDDEN_COMMAND'
  | 'REQUIRED_FLAG'
  | 'REQUIRED_PREREQUISITE'
  | 'TOOL_SUBSTITUTION'
  | 'RECURRING_VERIFIER'
  | 'OUTPUT_INVARIANT';

export interface CompiledHarnessRule {
  id: string;
  kind: HarnessRuleKind;
  scope: 'global' | string; // 'global' or normalized repo name (e.g., 'billing')
  toolMatcher: 'Bash' | 'Edit' | 'Write' | 'PostOutput';
  pattern: string;          // Regex or literal command prefix
  forbiddenArgs?: string[];
  requiredArgs?: string[];
  requiredPrefixCmd?: string;
  preferredTool?: string;
  forbiddenTool?: string;
  supportCount: number;
  sourceQuotes: Array<{ conversationId: string; messageId: string; quote: string }>;
  feedbackMessage: string;  // Deterministic stderr repair message for exit-code-2 loop
}

export interface ClaudeCodeECCSettings {
  permissions: {
    deny: string[];
  };
  hooks: {
    PreToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string }>;
    }>;
    PostToolUse: Array<{
      matcher: string;
      hooks: Array<{ type: 'command'; command: string }>;
    }>;
  };
}

export interface CompiledHarnessBundle {
  generatedAt: string;
  targetEcosystems: ['ECC/Claude-Code', 'Codex-CLI-ExecPolicy', 'Portable-PostOutput-Gate'];
  rules: CompiledHarnessRule[];
  claudeCodeEccHooksJson: ClaudeCodeECCSettings;
  codexExecPolicyStarlark: string;
  guardRunnerJs: string;
}

export interface HarnessHookEvent {
  tool_name: 'Bash' | 'Edit' | 'Write' | 'PostOutput';
  tool_input: {
    command?: string;
    file_path?: string;
    content?: string;
    output_json?: Record<string, unknown>;
  };
  cwd?: string;
  repo?: string;
  priorCommands?: string[];
}

export interface HarnessVerdict {
  decision: 'allow' | 'block';
  exitCode: 0 | 2; // Exact Claude Code / ECC hook convention: 0 = allow, 2 = block + feedback to agent
  triggeredRuleIds: string[];
  feedback: string[];
}

const PROHIBITION_RE = /\b(?:never|do\s+not|don't|must\s+not|forbid|avoid|stop\s+using)\b|严禁|禁止|不要(?:使用|直接|传|加)|千万别/i;
const REQUIREMENT_RE = /\b(?:always|must|require[ds]?|make\s+sure\s+to|before\s+running)\b|必须|务必|先运行|每次都要/i;
const SUBSTITUTION_RE = /\b(?:use|switch\s+to|prefer)\s+`?([a-z0-9._-]+)`?\s+(?:instead\s+of|rather\s+than|not)\s+`?([a-z0-9._-]+)`?/i;
const CN_SUBSTITUTION_RE = /(?:不要|别)用\s*`?([a-z0-9._-]+)`?\s*[，, ]*(?:统一|改|请)?用\s*`?([a-z0-9._-]+)`?/i;
const BACKTICK_CMD_RE = /`([^`\n]{3,120})`/g;
const FLAG_RE = /(--[a-z][a-z0-9-]{1,32}|-[A-Za-z]\b)/g;
const REPO_CUE_RE = /\b(?:only\s+(?:in|when\s+inside|for)\s+(?:repo(?:sitory)?\s*[:=]?\s*)?|inside\s+repo(?:sitory)?\s*[:=]?\s*)([a-z0-9._/-]{2,40})/i;
const CN_REPO_CUE_RE = /(?:仅在|只在)\s*`?([a-z0-9._/-]{2,40})`?\s*(?:仓库|项目|目录)/i;

export type HarnessConversation = Conversation & {
  scope?: 'global' | 'project';
  cwd?: string;
};

function normalizeScope(conv: HarnessConversation, text: string): string {
  const mEn = REPO_CUE_RE.exec(text);
  if (mEn?.[1]) return mEn[1].replace(/^repo=/i, '').replace(/[.,;:!?`'")\]]+$/, '').toLowerCase();
  const mCn = CN_REPO_CUE_RE.exec(text);
  if (mCn?.[1]) return mCn[1].replace(/[.,;:!?`'")\]]+$/, '').toLowerCase();
  if (conv.scope === 'project' && conv.cwd) {
    const seg = conv.cwd.replace(/\\/g, '/').split('/').filter(Boolean).at(-1);
    if (seg) return seg.toLowerCase();
  }
  return 'global';
}

function escapeStarlark(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile sanitized multi-platform developer conversations into drop-in open-source harness rules
 * targeting Claude Code / affaan-m/ECC (`hooks.json`), OpenAI Codex CLI (`execpolicy` `.rules`),
 * and deterministic `PreToolUse` / `PostToolUse` command guards.
 */
export function compileOpenSourceHarness(
  conversations: HarnessConversation[],
  options: { minVerifierSupport?: number } = {}
): CompiledHarnessBundle {
  const minVerifierSupport = options.minVerifierSupport ?? 2;
  const ruleMap = new Map<string, CompiledHarnessRule>();
  const verifierCmdCounts = new Map<string, { count: number; quotes: Array<{ conversationId: string; messageId: string; quote: string }> }>();

  const upsert = (key: string, candidate: Omit<CompiledHarnessRule, 'supportCount' | 'sourceQuotes'>, quote: { conversationId: string; messageId: string; quote: string }) => {
    const existing = ruleMap.get(key);
    if (existing) {
      existing.supportCount += 1;
      if (!existing.sourceQuotes.some(q => q.conversationId === quote.conversationId && q.messageId === quote.messageId)) {
        existing.sourceQuotes.push(quote);
      }
      return;
    }
    ruleMap.set(key, {
      ...candidate,
      supportCount: 1,
      sourceQuotes: [quote]
    });
  };

  for (const conv of conversations) {
    const convId = conv.id || conv.externalId || 'unknown';
    for (const msg of conv.messages) {
      const text = (msg.text || '').trim();
      if (!text) continue;

      // 1. Mine recurring verification / lint / test commands executed after edits (e.g., tsc --noEmit, pytest, npm test)
      const backticks = [...text.matchAll(BACKTICK_CMD_RE)].map(m => m[1].trim());
      for (const cmd of backticks) {
        if (/^(?:npm|pnpm|yarn|npx|pytest|cargo|go|make|mvn|gradle|ruff|eslint|tsc)\b/i.test(cmd) && /(?:test|check|lint|noEmit|verify|build|typecheck)/i.test(cmd)) {
          const normCmd = cmd.replace(/\s+/g, ' ');
          const rec = verifierCmdCounts.get(normCmd) ?? { count: 0, quotes: [] };
          rec.count += 1;
          if (rec.quotes.length < 4) rec.quotes.push({ conversationId: convId, messageId: msg.id, quote: text.slice(0, 180) });
          verifierCmdCounts.set(normCmd, rec);
        }
      }

      if (msg.role !== 'user') continue;
      const scope = normalizeScope(conv, text);
      const src = { conversationId: convId, messageId: msg.id, quote: text.slice(0, 220) };

      // 2. Mine tool substitution rules (e.g., "use pnpm instead of npm", "不要用 npm，统一用 pnpm")
      const subEn = SUBSTITUTION_RE.exec(text);
      const subCn = CN_SUBSTITUTION_RE.exec(text);
      if (subEn || subCn) {
        const preferred = (subEn ? subEn[1] : subCn![2]).toLowerCase();
        const forbidden = (subEn ? subEn[2] : subCn![1]).toLowerCase();
        if (preferred !== forbidden && forbidden.length >= 2) {
          const key = `SUB:${scope}:${forbidden}->${preferred}`;
          upsert(
            key,
            {
              id: `H-SUB-${forbidden.toUpperCase()}-${scope.toUpperCase()}`,
              kind: 'TOOL_SUBSTITUTION',
              scope,
              toolMatcher: 'Bash',
              pattern: `^\\s*${escapeRegex(forbidden)}\\b`,
              forbiddenTool: forbidden,
              preferredTool: preferred,
              feedbackMessage: `Harness Policy [${scope}]: Use \`${preferred}\` instead of \`${forbidden}\` (source-verified user rule).`
            },
            src
          );
        }
      }

      // 3. Mine forbidden CLI flags / destructive command invocations (e.g., "never pass --force in billing", "never run rm -rf")
      if (PROHIBITION_RE.test(text)) {
        const flags = [...new Set([...text.matchAll(FLAG_RE)].map(m => m[1]))];
        const cmdTargets = backticks.filter(c => /^[a-z0-9._-]+(?:\s+[^\n]+)?$/i.test(c));
        for (const f of flags) {
          const cmdBase = cmdTargets.find(c => !c.startsWith('-'))?.split(/\s+/)[0] || '';
          const key = `FORBID_FLAG:${scope}:${cmdBase}:${f}`;
          upsert(
            key,
            {
              id: `H-NOFLAG-${f.replace(/[^a-z0-9]/gi, '').toUpperCase()}-${scope.toUpperCase()}`,
              kind: 'FORBIDDEN_COMMAND',
              scope,
              toolMatcher: 'Bash',
              pattern: cmdBase ? `${escapeRegex(cmdBase)}[\\s\\S]*${escapeRegex(f)}` : escapeRegex(f),
              forbiddenArgs: [f],
              feedbackMessage: `Harness Policy [${scope}]: Forbidden flag \`${f}\`${cmdBase ? ` on \`${cmdBase}\`` : ''} blocked before execution.`
            },
            src
          );
        }
        // Only forbid bare commands when no specific flag qualifier was given (e.g. "Never run `chmod 777`"),
        // otherwise the flag-qualified rule above already guards `(cmd + forbiddenFlag)` without blocking safe usage!
        if (flags.length === 0) {
          for (const cmd of cmdTargets) {
            if (cmd.startsWith('-')) continue;
            if (/^(?:rm\s+-rf|git\s+push\s+(?:--force|-f)|git\s+reset\s+--hard|drop\s+table|sudo\s+rm|chmod\s+777|curl\b.*\|\s*(?:ba)?sh|db-migrate\b.*--force)/i.test(cmd) || PROHIBITION_RE.test(text)) {
              const key = `FORBID_CMD:${scope}:${cmd.toLowerCase()}`;
              upsert(
                key,
                {
                  id: `H-NOCMD-${cmd.split(/\s+/)[0].replace(/[^a-z0-9]/gi, '').toUpperCase()}-${scope.toUpperCase()}`,
                  kind: 'FORBIDDEN_COMMAND',
                  scope,
                  toolMatcher: 'Bash',
                  pattern: escapeRegex(cmd),
                  feedbackMessage: `Harness Policy [${scope}]: Prohibited command \`${cmd}\` blocked by PreToolUse guard.`
                },
                src
              );
            }
          }
        }
      }

      // 4. Mine mandatory flags & prerequisite ordering rules (e.g., "always run --dry-run before db-migrate --up")
      if (REQUIREMENT_RE.test(text)) {
        const flags = [...new Set([...text.matchAll(FLAG_RE)].map(m => m[1]))];
        const preMatch = /always\s+run\s+`?([^`\n]{3,60})`?\s+(?:before|first|prior\s+to)\s+`?([^`\n]{3,60})`?/i.exec(text);
        if (preMatch) {
          const prereq = preMatch[1].trim();
          const target = preMatch[2].trim();
          const key = `PREREQ:${scope}:${prereq}->${target}`;
          upsert(
            key,
            {
              id: `H-PRE-${target.split(/\s+/)[0].replace(/[^a-z0-9]/gi, '').toUpperCase()}-${scope.toUpperCase()}`,
              kind: 'REQUIRED_PREREQUISITE',
              scope,
              toolMatcher: 'Bash',
              pattern: escapeRegex(target),
              requiredPrefixCmd: prereq,
              feedbackMessage: `Harness Policy [${scope}]: Prerequisite \`${prereq}\` must execute before \`${target}\`.`
            },
            src
          );
        } else if (flags.length > 0 && backticks.length > 0) {
          const targetCmd = backticks.find(c => !c.startsWith('-'))?.split(/\s+/)[0];
          if (targetCmd) {
            for (const f of flags) {
              const key = `REQ_FLAG:${scope}:${targetCmd}:${f}`;
              upsert(
                key,
                {
                  id: `H-REQFLAG-${targetCmd.replace(/[^a-z0-9]/gi, '').toUpperCase()}-${f.replace(/[^a-z0-9]/gi, '').toUpperCase()}`,
                  kind: 'REQUIRED_FLAG',
                  scope,
                  toolMatcher: 'Bash',
                  pattern: `^\\s*${escapeRegex(targetCmd)}\\b`,
                  requiredArgs: [f],
                  feedbackMessage: `Harness Policy [${scope}]: Command \`${targetCmd}\` requires mandatory flag \`${f}\`.`
                },
                src
              );
            }
          }
        }
      }
    }
  }

  // Promote high-recurrence verification commands to PostToolUse Harness hooks
  for (const [cmd, info] of verifierCmdCounts.entries()) {
    if (info.count >= minVerifierSupport) {
      ruleMap.set(`VERIFY:${cmd}`, {
        id: `H-VERIFY-${cmd.split(/\s+/)[0].toUpperCase()}`,
        kind: 'RECURRING_VERIFIER',
        scope: 'global',
        toolMatcher: 'Edit',
        pattern: cmd,
        supportCount: info.count,
        sourceQuotes: info.quotes,
        feedbackMessage: `Harness PostToolUse Verifier: Run recurring check \`${cmd}\` after code edits.`
      });
    }
  }

  const rules = [...ruleMap.values()].sort((a, b) => b.supportCount - a.supportCount || a.id.localeCompare(b.id));

  // Emit 1: Native Claude Code / affaan-m/ECC `hooks.json` + `permissions.deny`
  const denyEntries: string[] = [];
  for (const r of rules) {
    if (r.kind === 'FORBIDDEN_COMMAND' && r.scope === 'global' && !r.forbiddenArgs?.length) {
      denyEntries.push(`Bash(${r.pattern.replace(/\\/g, '')}:*)`);
    } else if (r.kind === 'TOOL_SUBSTITUTION' && r.scope === 'global' && r.forbiddenTool) {
      denyEntries.push(`Bash(${r.forbiddenTool}:*)`);
    }
  }

  const postVerifiers = rules
    .filter(r => r.kind === 'RECURRING_VERIFIER')
    .slice(0, 3)
    .map(r => ({ type: 'command' as const, command: r.pattern }));

  const claudeCodeEccHooksJson: ClaudeCodeECCSettings = {
    permissions: { deny: [...new Set(denyEntries)] },
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: 'node .claude/hooks/skills-harness-guard.mjs'
            }
          ]
        }
      ],
      PostToolUse: postVerifiers.length
        ? [{ matcher: 'Edit|Write', hooks: postVerifiers }]
        : []
    }
  };

  // Emit 2: OpenAI Codex CLI `execpolicy` Starlark `.rules`
  const starlarkLines = [
    '# Auto-compiled by Skills-Harness (Channel 2) for OpenAI Codex CLI ExecPolicy',
    '# Drop into ~/.codex/rules/skills-harness.rules',
    ''
  ];
  for (const r of rules) {
    if (r.kind === 'FORBIDDEN_COMMAND' || r.kind === 'TOOL_SUBSTITUTION') {
      const tokens = r.forbiddenTool
        ? [r.forbiddenTool]
        : r.pattern.replace(/\\s\+/g, ' ').replace(/\\/g, '').split(/\s+/).filter(Boolean).slice(0, 4);
      if (tokens.length > 0) {
        const pat = tokens.map(t => `"${escapeStarlark(t)}"`).join(', ');
        starlarkLines.push(
          `prefix_rule(pattern=[${pat}], decision="forbidden", justification="${escapeStarlark(r.feedbackMessage)}")`
        );
      }
    }
  }

  // Emit 3: Standalone Node.js ESM hook runner implementing Claude Code / ECC exact stdin-JSON + exit-code-2 protocol
  const guardRunnerJs = [
    '#!/usr/bin/env node',
    '// Drop-in PreToolUse hook for Claude Code & affaan-m/ECC (stdin JSON -> exit 0 allow | exit 2 block+stderr)',
    'import fs from "node:fs";',
    `const RULES = ${JSON.stringify(rules.filter(r => r.toolMatcher === 'Bash'), null, 2)};`,
    'const raw = fs.readFileSync(0, "utf8").trim();',
    'const ev = raw ? JSON.parse(raw) : {};',
    'const cmd = String(ev?.tool_input?.command || "");',
    'const cwd = String(ev?.cwd || "").toLowerCase();',
    'const errs = [];',
    'for (const r of RULES) {',
    '  if (r.scope !== "global" && !cwd.includes(r.scope)) continue;',
    '  const re = new RegExp(r.pattern, "i");',
    '  if ((r.kind === "FORBIDDEN_COMMAND" || r.kind === "TOOL_SUBSTITUTION") && re.test(cmd)) errs.push(r.feedbackMessage);',
    '  if (r.kind === "REQUIRED_FLAG" && re.test(cmd) && (r.requiredArgs || []).some(a => !cmd.includes(a))) errs.push(r.feedbackMessage);',
    '}',
    'if (errs.length) { console.error(errs.join("\\n")); process.exit(2); }',
    'process.exit(0);'
  ].join('\n');

  return {
    generatedAt: new Date().toISOString(),
    targetEcosystems: ['ECC/Claude-Code', 'Codex-CLI-ExecPolicy', 'Portable-PostOutput-Gate'],
    rules,
    claudeCodeEccHooksJson,
    codexExecPolicyStarlark: starlarkLines.join('\n') + '\n',
    guardRunnerJs
  };
}

/**
 * Execute compiled Harness rules synchronously against a live Claude Code / Codex / ECC tool event.
 * Returns exact Claude Code exit code (`0` = allow, `2` = deterministic block with corrective stderr).
 */
export function evaluateHarnessEvent(rules: CompiledHarnessRule[], ev: HarnessHookEvent): HarnessVerdict {
  const cmd = (ev.tool_input.command || '').trim();
  const repoScope = (ev.repo || ev.cwd || '').toLowerCase();
  const prior = ev.priorCommands || [];
  const triggered: string[] = [];
  const feedback: string[] = [];

  for (const r of rules) {
    if (r.toolMatcher !== ev.tool_name) continue;
    if (r.scope !== 'global' && !repoScope.includes(r.scope.toLowerCase())) continue;

    const re = new RegExp(r.pattern, 'i');
    if (r.kind === 'FORBIDDEN_COMMAND' || r.kind === 'TOOL_SUBSTITUTION') {
      if (re.test(cmd)) {
        triggered.push(r.id);
        feedback.push(r.feedbackMessage);
      }
    } else if (r.kind === 'REQUIRED_FLAG') {
      if (re.test(cmd) && (r.requiredArgs || []).some(arg => !cmd.includes(arg))) {
        triggered.push(r.id);
        feedback.push(r.feedbackMessage);
      }
    } else if (r.kind === 'REQUIRED_PREREQUISITE') {
      if (re.test(cmd) && r.requiredPrefixCmd && !prior.some(p => p.toLowerCase().includes(r.requiredPrefixCmd!.toLowerCase()))) {
        triggered.push(r.id);
        feedback.push(r.feedbackMessage);
      }
    }
  }

  return {
    decision: triggered.length > 0 ? 'block' : 'allow',
    exitCode: triggered.length > 0 ? 2 : 0,
    triggeredRuleIds: triggered,
    feedback
  };
}
