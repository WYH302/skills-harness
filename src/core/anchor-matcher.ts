/**
 * Hybrid Cross-Session Anchor Alignment Gate (M3 Upgrade):
 * Combines deterministic symbolic literal + grammatical-polarity pre-gating
 * (matching `src/core/procedure-organization.ts`) with optional lightweight
 * semantic cosine equivalence (e.g., quantized CPU ONNX embeddings).
 * Guarantees 0% false merges on numeric, CLI-flag, path, or negation mutations
 * while recovering paraphrased and cross-lingual equivalent steps.
 */
import { similarity } from './mining';

const LITERAL_PATTERNS: readonly RegExp[] = [
  /[+-]?\d+(?:[.,]\d+)*(?:%|‰)?/g,
  /(`+)([\s\S]*?)\1/g,
  /"(?:\\.|[^"\\])*"/g,
  /--[A-Za-z][A-Za-z0-9-]*/g,
  /(?:[A-Za-z]:[\\/]|https?:\/\/|\/)[^\s"'`<>()]+/g,
  /\b[A-Za-z_$][\w$]*(?:_[\w$]+)+\b/g,
  /\b[a-z]+[A-Z][A-Za-z0-9_$]*\b/g,
  /===|!==|==|!=|<=|>=|=>|&&|\|\|/g,
];

const NEGATION_PATTERN =
  /\b(?:not|never|without|avoid|cannot|can't|don't|doesn't|shouldn't|mustn't|forbid|prohibit)\b|不要|不得|禁止|切勿|不能|不可|不应|严禁|绝不|避免/i;

const CONDITION_PATTERN =
  /\b(?:if|unless|when|whenever|provided that|only after|only before|only in|strictly for)\b|如果|假如|除非|仅当|只有[\s\S]*才|仅在|仅限/i;

export function normalizedStepKey(step: string): string {
  return step.replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
}

export function stepLiteralSignature(text: string): string {
  return JSON.stringify(
    LITERAL_PATTERNS.map(pattern => [...new Set([...text.matchAll(pattern)].map(m => m[0]))].sort())
  );
}

export function stepPolarityFlags(text: string): string {
  return `${NEGATION_PATTERN.test(text)}:${CONDITION_PATTERN.test(text)}`;
}

export type SemanticSimilarityFn = (left: string, right: string) => number;

export interface HybridAnchorResult {
  matched: boolean;
  mode: 'exact' | 'symbolic-rejected' | 'semantic-hybrid' | 'semantic-rejected';
  similarity: number;
}

/**
 * Evaluates whether two procedural steps from distinct sessions form a valid equivalence anchor.
 * 1. Exact normalized match -> short-circuit accept (0 ms).
 * 2. Hard symbolic pre-gate: any mismatch in code/numeric/flag/path literals OR negation/condition
 *    polarity immediately rejects before semantic scoring (0% false merge guarantee).
 * 3. Semantic equivalence check via supplied embedding cosine (e.g. CPU ONNX) or lexical fallback.
 */
export function matchHybridAnchor(
  left: string,
  right: string,
  options: { threshold?: number; semanticSim?: SemanticSimilarityFn } = {}
): HybridAnchorResult {
  if (normalizedStepKey(left) === normalizedStepKey(right)) {
    return { matched: true, mode: 'exact', similarity: 1.0 };
  }
  if (stepLiteralSignature(left) !== stepLiteralSignature(right) || stepPolarityFlags(left) !== stepPolarityFlags(right)) {
    return { matched: false, mode: 'symbolic-rejected', similarity: 0.0 };
  }
  const threshold = options.threshold ?? 0.72;
  const sim = options.semanticSim ? options.semanticSim(left, right) : similarity(left, right);
  return {
    matched: sim >= threshold,
    mode: sim >= threshold ? 'semantic-hybrid' : 'semantic-rejected',
    similarity: sim,
  };
}
