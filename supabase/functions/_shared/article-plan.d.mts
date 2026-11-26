export const PIPELINE_VERSION: string
export const MAX_BLOCK_CHARS: number
export const MARKER_PATTERN: RegExp
export type ArticleBlock = { id: string; text: string; sectionId: string }
export type ArticleSection = { id: string; title: string; html: string; complete: boolean }
export type ArticlePlan = {
  version: string
  sections: { id: string; title: string; template: string; blockIds: string[] }[]
  units: { id: string; openHtml: string; closeHtml: string; blockIds: string[]; slots: { marker: string; html: string }[] }[]
  blocks: ArticleBlock[]
  sourceTextChars: number
  summary: string
}
export function parseWikipediaUrl(input: string): { lang: string; title: string; canonicalUrl: string }
export function sanitizeHtml(html: string, lang: string, parseDocument: (html: string) => Document): string
export function prepareArticle(rawHtml: string, lang: string, parseDocument: (html: string) => Document): ArticlePlan
export function escapeHtml(text: string): string
export function validateMarkers(source: string, output: string): boolean
export function makeBatches(blocks: ArticleBlock[], maxChars?: number, maxBlocks?: number): ArticleBlock[][]
export function renderArticle(plan: ArticlePlan, outputs?: Record<string, string>, options?: { finished?: boolean; failedIds?: string[] }): { html: string; sections: ArticleSection[]; rewriteMode: 'llm' | 'llm-partial' | 'heuristic'; completed: number; total: number; failedCount: number }
