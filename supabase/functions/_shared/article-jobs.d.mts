import type { Provider, RewriteInput, RewriteResult, OpinionResult, ReviewInput, ReviewResult } from './provider.mjs'
export const ARTICLE_LIMITS: Readonly<{ workers: number; batches: number; sourceBytes: number; blocks: number; runMs: number; jobMs: number; leaseMs: number; attempts: number }>
export class ArticleServiceError extends Error { constructor(message: string,status?: number,code?: string,retryable?: boolean,retryAfter?: number|null); status: number; code: string; retryable: boolean; retryAfter: number|null }
export function safeJobError(error: unknown): Record<string, unknown>
export interface ArticleProvider { model?: string; reviewModel?: string; rewrite(input: RewriteInput): Promise<RewriteResult>; opinion(input: {summary:string;revisionNotes?:string[];previousDraft?:string;signal?:AbortSignal}): Promise<OpinionResult>; review(input: ReviewInput): Promise<ReviewResult> }
export interface ArticleService { handle(payload: Record<string, unknown>,context?: {requestKey?:string}): Promise<Record<string, unknown>>; dispatch(): Promise<unknown>; nextWakeDelay(): Promise<number|null>; wake(): void; close(): void; version: string }
export function createArticleService(config: {store: unknown;provider: ArticleProvider|Provider;parseDocument: (html:string)=>unknown;fetchImpl?: typeof fetch;model?: string;reviewModel?:string;clock?:()=>number;runBudgetMs?:number;resolveIdentity?:boolean}): ArticleService
export function createMemoryStore(config?: Record<string, unknown>): unknown
export function createSupabaseStore(config: {url:string;serviceKey:string;fetchImpl?:typeof fetch}): unknown
