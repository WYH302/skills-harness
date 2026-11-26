import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrivacyVault } from '../src/core/privacy-vault';
import { compileOpenSourceHarness, evaluateHarnessEvent, type HarnessConversation } from '../src/core/harness-compiler';

function makeConv(id: string, texts: Array<{ role: 'user' | 'assistant'; text: string }>, scope: 'global' | 'project' = 'global', cwd?: string): HarnessConversation {
  return {
    id,
    externalId: id,
    source: 'codex',
    title: 'Test conversation',
    completeness: 'full',
    warnings: [],
    scope,
    cwd,
    createdAt: '2026-11-20T10:00:00Z',
    updatedAt: '2026-11-20T10:05:00Z',
    messages: texts.map((t, i) => ({
      id: `${id}-m${i}`,
      role: t.role,
      text: t.text,
      timestamp: '2026-11-20T10:00:00Z'
    }))
  };
}

describe('Three-Channel Typed Log Compiler (Privacy Vault + Open-Source Harness)', () => {
  it('Channel 1: PrivacyVault isolates all 10 PII/secret classes, encrypts locally, and preserves benign engineering tokens', () => {
    const vault = new PrivacyVault();
    const convs: HarnessConversation[] = [
      makeConv('c-priv-1', [
        {
          role: 'user',
          text: [
            'Deploy with sk-proj-AbCdEf1234567890GhIjKlMnOpQrStUv and postgres://admin:S3cr3tP4ss!@db.internal:5432/prod.',
            'My email is alice.wang@company-real.cn and phone 13812345678.',
            '身份证号 11010519900307235X，家庭地址：广东省佛山市南海区桂城街道华翠南路88号3栋502室。',
            '我的年薪是42万且体检诊断有轻度脂肪肝，请不要发给外部模型。'
          ].join('\n')
        },
        {
          role: 'assistant',
          text: 'Keep benign git commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b, timestamp 1732512000123, doc email dev@example.com, and sk-your-api-key-here intact.'
        }
      ])
    ];

    const res = vault.quarantineArchive(convs);
    const sanitizedUser = res.sanitizedConversations[0].messages[0].text;
    const sanitizedAsst = res.sanitizedConversations[0].messages[1].text;

    assert.ok(res.audit.uniqueEntities >= 7, `expected >=7 quarantined entities, got ${res.audit.uniqueEntities}`);
    assert.equal(vault.verifyZeroLeakage(sanitizedUser).clean, true);
    assert.ok(sanitizedUser.includes('[VAULT:API_KEY_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:DB_URI_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:EMAIL_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:PHONE_CN_INTL_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:ID_CARD_SSN_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:HOME_ADDRESS_01]'));
    assert.ok(sanitizedUser.includes('[VAULT:PERSONAL_SECRET_01]'));

    // Benign technical tokens must NOT be corrupted!
    assert.ok(sanitizedAsst.includes('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b'));
    assert.ok(sanitizedAsst.includes('1732512000123'));
    assert.ok(sanitizedAsst.includes('dev@example.com'));
    assert.ok(sanitizedAsst.includes('sk-your-api-key-here'));

    // AES-256-GCM encryption round-trip check
    const enc = vault.exportEncryptedVault('local-passphrase-2026');
    assert.equal(enc.algorithm, 'aes-256-gcm');
    assert.ok(!enc.ciphertextBase64.includes('S3cr3tP4ss'));
    const dec = PrivacyVault.decryptVault(enc, 'local-passphrase-2026');
    assert.equal(dec.entries.length, res.vaultEntries.length);
  });

  it('Channel 2: HarnessCompiler emits schema-valid ECC/Claude Code hooks.json + Codex Starlark rules and enforces repo-scoped blocks', () => {
    const convs: HarnessConversation[] = [
      makeConv('c-h1', [
        { role: 'user', text: 'Never pass `--force` on `db-migrate` only inside repo=billing.' },
        { role: 'user', text: 'Always run `db-migrate --dry-run` before `db-migrate --up`.' },
        { role: 'assistant', text: 'Done, verified with `npm test` and `npx tsc --noEmit`.' }
      ]),
      makeConv('c-h2', [
        { role: 'user', text: 'Switch to `pnpm` instead of `npm` for all package installs.' },
        { role: 'assistant', text: 'Verified build with `npx tsc --noEmit`.' }
      ])
    ];

    const bundle = compileOpenSourceHarness(convs, { minVerifierSupport: 2 });

    // Validate affaan-m/ECC & Claude Code hooks.json schema
    assert.ok(bundle.claudeCodeEccHooksJson.hooks.PreToolUse.length >= 1);
    assert.equal(bundle.claudeCodeEccHooksJson.hooks.PreToolUse[0].matcher, 'Bash');
    assert.ok(bundle.claudeCodeEccHooksJson.hooks.PostToolUse.some(h => h.hooks.some(x => x.command.includes('tsc --noEmit'))));
    assert.ok(bundle.claudeCodeEccHooksJson.permissions.deny.includes('Bash(npm:*)'));

    // Validate OpenAI Codex CLI Starlark execpolicy
    assert.ok(bundle.codexExecPolicyStarlark.includes('prefix_rule(pattern=["npm"], decision="forbidden"'));

    // Live event enforcement: repo-scoped block in billing, ALLOW in staging!
    const vBlockBilling = evaluateHarnessEvent(bundle.rules, {
      tool_name: 'Bash',
      tool_input: { command: 'db-migrate --up --force' },
      cwd: '/workspace/billing'
    });
    assert.equal(vBlockBilling.decision, 'block');
    assert.equal(vBlockBilling.exitCode, 2);

    const vAllowStagingWithDryRun = evaluateHarnessEvent(bundle.rules, {
      tool_name: 'Bash',
      tool_input: { command: 'db-migrate --up --force' },
      cwd: '/workspace/staging',
      priorCommands: ['db-migrate --dry-run']
    });
    assert.equal(vAllowStagingWithDryRun.decision, 'allow');
    assert.equal(vAllowStagingWithDryRun.exitCode, 0);

    // Block missing prerequisite in staging when --dry-run was skipped
    const vBlockMissingPrereq = evaluateHarnessEvent(bundle.rules, {
      tool_name: 'Bash',
      tool_input: { command: 'db-migrate --up' },
      cwd: '/workspace/staging',
      priorCommands: []
    });
    assert.equal(vBlockMissingPrereq.decision, 'block');
    assert.equal(vBlockMissingPrereq.exitCode, 2);

    // Block forbidden tool substitution (`npm install`) globally
    const vBlockNpm = evaluateHarnessEvent(bundle.rules, {
      tool_name: 'Bash',
      tool_input: { command: 'npm install lodash' },
      cwd: '/workspace/any'
    });
    assert.equal(vBlockNpm.decision, 'block');
    assert.equal(vBlockNpm.exitCode, 2);
  });
});
