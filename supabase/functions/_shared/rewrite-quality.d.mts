export type RewriteQualityReason = 'invalid_text' | 'analysis_limit' | 'protected_atoms_changed' | 'legacy_markers_changed' | 'prose_dropped' | 'numeric_facts_changed' | 'unchanged_prose' | 'source_wrapped' | 'excessive_copying'
export interface RewriteQualityMetrics {
  sourceWords: number; outputWords: number; orderedSourceWordsRetained: number
  wordRetention: number; newWordFraction: number; longestCopyRun: number; longestCopiedPhrase: string; longestCopyFraction: number
  sourceAtoms: number; outputAtoms: number
  sourceNumbers: string[]; outputNumbers: string[]; missingNumbers: string[]; addedNumbers: string[]
}
export interface RewriteQualityAssessment { ok: boolean; reason: RewriteQualityReason | null; metrics: RewriteQualityMetrics }
export const REWRITE_QUALITY_LIMITS: Readonly<{ characters: number; words: number; longWords: number; shortWords: number; maxLongRetention: number; minLongCopyRun: number; maxLongCopyFraction: number }>
/** Conservative lexical/numeric checks only. Does not prove fact coverage, negation, claim associations, proper nouns, or POV. */
export function assessRewrite(source: unknown, output: unknown): RewriteQualityAssessment
