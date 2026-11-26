/**
 * Channel 1 — Local-First Privacy Vault & Information-Flow Quarantine (`privacy-vault.ts`).
 *
 * Extracts 10 classes of bilingual (English + Chinese) Personal Identifiable Information (PII)
 * and engineering credentials/secrets from raw multi-platform AI chat logs, quarantines them
 * inside a local user-only vault (with AES-256-GCM encryption support and full source audit),
 * and emits deterministically masked transcripts using typed placeholders `[VAULT:TYPE_NN]`
 * so downstream LLMs, compiled Skills, and Harness hooks NEVER observe raw private data while
 * preserving benign engineering tokens (SemVer, git SHAs, UUIDs, localhost/RFC1918 docs, ports).
 */
import crypto from 'node:crypto';
import type { Conversation, Message } from '../shared/types';

export type PrivacyCategory =
  | 'API_KEY'
  | 'PRIVATE_KEY'
  | 'DB_URI'
  | 'JWT_BEARER'
  | 'EMAIL'
  | 'PHONE_CN_INTL'
  | 'ID_CARD_SSN'
  | 'BANK_CARD'
  | 'HOME_ADDRESS'
  | 'PERSONAL_SECRET';

export interface VaultEntry {
  placeholder: string;
  category: PrivacyCategory;
  severity: 'critical' | 'high' | 'medium';
  sha256: string;
  redactedPreview: string;
  rawValue: string;
  occurrences: number;
  sources: Array<{ conversationId: string; messageId: string; platform: string }>;
}

export interface PrivacyAuditReport {
  totalFindings: number;
  uniqueEntities: number;
  byCategory: Record<PrivacyCategory, number>;
  conversationsTouched: number;
  entries: Omit<VaultEntry, 'rawValue'>[];
}

export interface QuarantineResult {
  sanitizedConversations: Conversation[];
  vaultEntries: VaultEntry[];
  audit: PrivacyAuditReport;
}

const ALL_CATEGORIES: PrivacyCategory[] = [
  'API_KEY',
  'PRIVATE_KEY',
  'DB_URI',
  'JWT_BEARER',
  'EMAIL',
  'PHONE_CN_INTL',
  'ID_CARD_SSN',
  'BANK_CARD',
  'HOME_ADDRESS',
  'PERSONAL_SECRET'
];

// Benign lookalike guards (prevent false positives on standard engineering strings)
const EXAMPLE_EMAIL_DOMAIN = /@(?:example\.(?:com|org|net)|localhost|test\.local|placeholder\.dev|invalid)$/i;
const DOC_PLACEHOLDER_TOKEN = /^(?:sk-xxx+|sk-your|ghp_xxx+|AKIAIOSFODNN7EXAMPLE|your[_-]api[_-]key|dummy|sample|test[_-]?token)/i;
const SEMVER_OR_DATE_PREFIX = /(?:^|[\s:=v])(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+]|$)/;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function cnIdChecksumValid(id18: string): boolean {
  if (!/^[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(id18)) {
    return false;
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (id18.charCodeAt(i) - 48) * weights[i];
  return codes[sum % 11] === id18[17].toUpperCase();
}

function previewMask(raw: string, cat: PrivacyCategory): string {
  if (cat === 'PRIVATE_KEY') return '-----BEGIN PRIVATE KEY----- [REDACTED]';
  if (raw.length <= 8) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 4)}***${raw.slice(-3)}`;
}

interface PatternSpec {
  category: PrivacyCategory;
  severity: 'critical' | 'high' | 'medium';
  regex: RegExp;
  validate?: (match: string, fullText: string, index: number) => boolean;
}

const PATTERN_SPECS: PatternSpec[] = [
  // 1. PEM Private Keys
  {
    category: 'PRIVATE_KEY',
    severity: 'critical',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{20,4000}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g
  },
  // 2. Database & Credential URIs (with embedded user:password@host)
  {
    category: 'DB_URI',
    severity: 'critical',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|mssql):\/\/[^\s'"`<>:@]{1,64}:[^\s'"`<>@]{3,128}@[^\s'"`<>]{3,160}/gi,
    validate: m => !/:(?:password|pass|changeme|example|xxx+)@/i.test(m)
  },
  // 3. JWT & Explicit Bearer Tokens
  {
    category: 'JWT_BEARER',
    severity: 'critical',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g
  },
  // 4. API Keys & Cloud Tokens (OpenAI, Anthropic, GitHub, AWS, Slack, Stripe, HuggingFace, DeepSeek, generic labeled secrets)
  {
    category: 'API_KEY',
    severity: 'critical',
    regex: /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{16,}|hf_[A-Za-z0-9]{24,}|AIza[0-9A-Za-z_-]{35}|rk_live_[A-Za-z0-9]{20,}|pk_live_[A-Za-z0-9]{20,})\b/g,
    validate: m => !DOC_PLACEHOLDER_TOKEN.test(m)
  },
  {
    category: 'API_KEY',
    severity: 'critical',
    regex: /(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|auth[_-]?token|密码|密钥)\s*[:=]\s*['"]?([A-Za-z0-9_\-./+=]{14,120})['"]?/gi,
    validate: (m, full, idx) => {
      const val = m.replace(/^[^:=]+[:=]\s*['"]?/, '').replace(/['"]$/, '');
      if (DOC_PLACEHOLDER_TOKEN.test(val) || /^\$\{?[A-Z0-9_]+\}?$/.test(val) || /^process\.env\./.test(val)) return false;
      if (/^[a-f0-9]{40}$/i.test(val) && /commit|sha|git/i.test(full.slice(Math.max(0, idx - 30), idx))) return false;
      return /[A-Za-z]/.test(val) && /\d/.test(val);
    }
  },
  // 5. Email Addresses (excluding standard docs/example domains)
  {
    category: 'EMAIL',
    severity: 'high',
    regex: /\b[A-Za-z0-9._%+-]{2,64}@[A-Za-z0-9.-]{2,120}\.[A-Za-z]{2,12}\b/g,
    validate: m => !EXAMPLE_EMAIL_DOMAIN.test(m) && !/noreply|no-reply|dependabot|bot@|users\.noreply\.github\.com/i.test(m)
  },
  // 6. Chinese 18-digit Resident ID & US SSN (with checksum / context validation to avoid false positives on hashes/timestamps)
  {
    category: 'ID_CARD_SSN',
    severity: 'critical',
    regex: /(?<![A-Za-z0-9_])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![A-Za-z0-9_])/g,
    validate: m => cnIdChecksumValid(m)
  },
  {
    category: 'ID_CARD_SSN',
    severity: 'critical',
    regex: /(?:ssn|social\s+security(?:\s+number)?|社保号|身份证号?)\s*[:：=]?\s*(\d{3}-\d{2}-\d{4}|[1-9]\d{16}[\dXx])/gi
  },
  // 7. Phone Numbers (China Mainland 11-digit mobile & international +CC format with context/boundary guards)
  {
    category: 'PHONE_CN_INTL',
    severity: 'high',
    regex: /(?<![\dA-Za-z._-])(?:\+86[-\s]?)?1[3-9]\d{9}(?![\dA-Za-z._-])/g,
    validate: (m, full, idx) => {
      const ctx = full.slice(Math.max(0, idx - 24), Math.min(full.length, idx + m.length + 24));
      if (/(?:timestamp|epoch|unix|ms|created_at|updated_at|port|pid|inode|0x)/i.test(ctx)) return false;
      return true;
    }
  },
  {
    category: 'PHONE_CN_INTL',
    severity: 'high',
    regex: /(?:phone|mobile|tel|call\s+me|联系(?:方式|电话)|手机(?:号)?)\s*[:：=]?\s*(\+?\d{1,3}[-\s]?\(?\d{2,4}\)?[-\s]?\d{3,4}[-\s]?\d{4})/gi
  },
  // 8. Bank / Credit Cards (16-19 digits passing Luhn + financial/card context)
  {
    category: 'BANK_CARD',
    severity: 'critical',
    regex: /(?:card|visa|mastercard|unionpay|银行卡|卡号|信用卡|借记卡)\s*[:：=]?\s*((?:\d{4}[-\s]?){3}\d{4,7})/gi,
    validate: m => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 16 && digits.length <= 19 && luhnValid(digits);
    }
  },
  // 9. Home / Street Personal Addresses (explicit bilingual personal address markers)
  {
    category: 'HOME_ADDRESS',
    severity: 'high',
    regex: /(?:(?:家庭|居住|收货|详细)地址|住址|住在|寄到)\s*[:：]?\s*([^\n，。;；]{8,80}(?:路|街|道|巷|弄|小区|花园|大厦|栋|单元|号|室)[^\n，。;；]{0,30})/g
  },
  {
    category: 'HOME_ADDRESS',
    severity: 'high',
    regex: /(?:home\s+address|my\s+address|live\s+at|ship\s+to)\s*[:=]?\s*(\d{1,6}\s+[A-Za-z0-9.\s]{3,40}\s(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Apt\.?\s*\d+)[A-Za-z0-9,\s-]{0,40})/gi
  },
  // 10. Personal Sensitive Notes (explicit health/medical/salary/family confidential statements)
  {
    category: 'PERSONAL_SECRET',
    severity: 'medium',
    regex: /(?:(?:我的|本人)(?:体检|病历|诊断|年薪|月薪|存款|负债|离婚|家庭隐私)|(?:my\s+(?:medical\s+diagnosis|salary\s+is|net\s+worth|bank\s+balance|tax\s+return|personal\s+secret)))[^\n。!！?？]{4,140}/gi
  }
];

/**
 * Stateful deterministic local Privacy Vault.
 * Maps identical sensitive values to stable typed placeholders `[VAULT:CATEGORY_01]`
 * across all conversations so downstream workflow structure remains intact while
 * zero raw private data ever enters CTSS, Anchor-DAG, SKILL.md, Harness rules, or LLM prompts.
 */
export class PrivacyVault {
  private readonly valueToPlaceholder = new Map<string, string>();
  private readonly entries = new Map<string, VaultEntry>();
  private readonly counters = new Map<PrivacyCategory, number>();
  private readonly touchedConversations = new Set<string>();

  private register(
    rawValue: string,
    category: PrivacyCategory,
    severity: 'critical' | 'high' | 'medium',
    meta: { conversationId: string; messageId: string; platform: string }
  ): string {
    const clean = rawValue.trim();
    const key = `${category}:${clean}`;
    let placeholder = this.valueToPlaceholder.get(key);
    if (!placeholder) {
      const next = (this.counters.get(category) ?? 0) + 1;
      this.counters.set(category, next);
      placeholder = `[VAULT:${category}_${String(next).padStart(2, '0')}]`;
      this.valueToPlaceholder.set(key, placeholder);
      this.entries.set(placeholder, {
        placeholder,
        category,
        severity,
        sha256: crypto.createHash('sha256').update(clean).digest('hex'),
        redactedPreview: previewMask(clean, category),
        rawValue: clean,
        occurrences: 0,
        sources: []
      });
    }
    const entry = this.entries.get(placeholder)!;
    entry.occurrences += 1;
    if (!entry.sources.some(s => s.conversationId === meta.conversationId && s.messageId === meta.messageId)) {
      entry.sources.push(meta);
    }
    this.touchedConversations.add(meta.conversationId);
    return placeholder;
  }

  /**
   * Quarantine all sensitive entities in a single text string and return its AI-safe masked form.
   */
  sanitizeText(
    text: string,
    meta: { conversationId: string; messageId: string; platform: string } = {
      conversationId: 'adhoc',
      messageId: 'm0',
      platform: 'local'
    }
  ): string {
    if (!text) return text;
    let out = text;

    for (const spec of PATTERN_SPECS) {
      spec.regex.lastIndex = 0;
      out = out.replace(spec.regex, (fullMatch, captured, offset) => {
        if (fullMatch.includes('[VAULT:')) return fullMatch;
        if (spec.category === 'PHONE_CN_INTL' && SEMVER_OR_DATE_PREFIX.test(fullMatch)) return fullMatch;
        if (spec.validate && !spec.validate(fullMatch, out, typeof offset === 'number' ? offset : 0)) {
          return fullMatch;
        }
        // If the pattern has a capture group (labeled secret / address / phone), preserve the label prefix
        // and replace only the sensitive payload so instructional syntax stays intact for downstream skills!
        if (typeof captured === 'string' && captured.length >= 4) {
          const placeholder = this.register(captured, spec.category, spec.severity, meta);
          return fullMatch.replace(captured, placeholder);
        }
        return this.register(fullMatch, spec.category, spec.severity, meta);
      });
    }
    return out;
  }

  /**
   * Quarantine an entire multi-platform conversation archive before Stage-1 CTSS or any LLM call.
   */
  quarantineArchive(conversations: Conversation[]): QuarantineResult {
    const sanitizedConversations: Conversation[] = conversations.map(conv => {
      const convId = conv.id || conv.externalId || 'unknown';
      const platform = conv.source || 'local';
      return {
        ...conv,
        title: this.sanitizeText(conv.title, {
          conversationId: convId,
          messageId: 'title',
          platform
        }),
        messages: conv.messages.map((m: Message) => ({
          ...m,
          text: this.sanitizeText(m.text, {
            conversationId: convId,
            messageId: m.id,
            platform
          })
        }))
      };
    });

    return {
      sanitizedConversations,
      vaultEntries: this.listEntries(),
      audit: this.auditReport()
    };
  }

  listEntries(): VaultEntry[] {
    return [...this.entries.values()];
  }

  auditReport(): PrivacyAuditReport {
    const byCategory = Object.fromEntries(ALL_CATEGORIES.map(c => [c, 0])) as Record<PrivacyCategory, number>;
    let totalFindings = 0;
    const redactedEntries: Omit<VaultEntry, 'rawValue'>[] = [];
    for (const e of this.entries.values()) {
      byCategory[e.category] += e.occurrences;
      totalFindings += e.occurrences;
      const { rawValue: _secret, ...safe } = e;
      redactedEntries.push(safe);
    }
    return {
      totalFindings,
      uniqueEntities: this.entries.size,
      byCategory,
      conversationsTouched: this.touchedConversations.size,
      entries: redactedEntries
    };
  }

  /**
   * Encrypt the local Privacy Vault using AES-256-GCM (PBKDF2 key derivation) so sensitive user
   * artifacts are stored strictly encrypted at rest on the user's machine and never plaintext-exposed.
   */
  exportEncryptedVault(passphrase: string): {
    algorithm: 'aes-256-gcm';
    saltHex: string;
    ivHex: string;
    authTagHex: string;
    ciphertextBase64: string;
  } {
    const salt = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const payload = JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      entries: this.listEntries()
    });
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    return {
      algorithm: 'aes-256-gcm',
      saltHex: salt.toString('hex'),
      ivHex: iv.toString('hex'),
      authTagHex: cipher.getAuthTag().toString('hex'),
      ciphertextBase64: encrypted.toString('base64')
    };
  }

  static decryptVault(
    bundle: { saltHex: string; ivHex: string; authTagHex: string; ciphertextBase64: string },
    passphrase: string
  ): { version: number; createdAt: string; entries: VaultEntry[] } {
    const key = crypto.pbkdf2Sync(passphrase, Buffer.from(bundle.saltHex, 'hex'), 100_000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(bundle.authTagHex, 'hex'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(bundle.ciphertextBase64, 'base64')),
      decipher.final()
    ]);
    return JSON.parse(dec.toString('utf8'));
  }

  /**
   * Verify zero leakage of any quarantined raw secret inside a compiled downstream artifact
   * (SKILL.md, Harness rules, or outgoing LLM prompt).
   */
  verifyZeroLeakage(downstreamText: string): { clean: boolean; leakedPlaceholders: string[] } {
    const leaked: string[] = [];
    for (const e of this.entries.values()) {
      if (e.rawValue.length >= 6 && downstreamText.includes(e.rawValue)) {
        leaked.push(e.placeholder);
      }
    }
    return { clean: leaked.length === 0, leakedPlaceholders: leaked };
  }
}
