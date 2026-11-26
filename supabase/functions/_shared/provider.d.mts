export interface Block { id: string; text: string }
export interface Usage {
  prompt_tokens?: number; completion_tokens?: number; total_tokens?: number;
  reasoning_tokens?: number; cost_in_usd_ticks?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}
export interface GenerationMetadata { model: string; duration: number; usage: Usage }
export interface RewriteInput { blocks: Block[]; opinion?: string | null; includeOpinion?: boolean; summary?: string; signal?: AbortSignal }
export interface RewriteResult extends GenerationMetadata { blocks: Block[]; opinion?: string }
export interface OpinionResult extends GenerationMetadata { opinion: string }
export interface Provider {
  readonly model: string; readonly baseUrl: string; readonly configured: boolean; readonly promptVersion: string;
  rewrite(input: RewriteInput): Promise<RewriteResult>;
  opinion(input: { summary: string; signal?: AbortSignal }): Promise<OpinionResult>;
}
export interface ProviderMetric extends GenerationMetadata { operation: string; status: number }
export interface ProviderConfig {
  apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch;
  timeoutMs?: number; maxConcurrent?: number; reasoningEffort?: string;
  onMetric?: (metric: ProviderMetric) => void;
}
export const DEFAULT_MODEL: string;
export const PROVIDER_PROMPT_VERSION: string;
export const PROVIDER_LIMITS: Readonly<Record<string, number>>;
export class ProviderError extends Error {
  status: number; code: string; retryable: boolean; retryAfter: number | null; retryAfterMs: number | null;
  model?: string; duration?: number; usage?: Usage;
  constructor(message: string, options?: { status?: number; code?: string; retryable?: boolean; retryAfter?: number | null });
}
export function createProvider(config?: ProviderConfig): Provider;
export function validateBlocks(blocks: unknown): Block[];
export function parseRetryAfter(value: string | null, now?: number): number | null;
export function normalizeRewritePayload(payload: unknown): RewriteInput & { legacy: boolean };
export function rewritePayload(provider: Provider, payload: unknown, signal?: AbortSignal): Promise<RewriteResult & { provider: string; segments?: string[] }>;
export function safeProviderError(error: unknown): { status: number; body: { error: string; code: string; retryable: boolean; retryAfter: number | null }; headers: Record<string, string> };
export function readRequestJson(req: Request): Promise<unknown>;
