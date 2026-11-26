import type { Provider } from './provider.d.mts';
export const legacyCorsHeaders: Readonly<Record<string, string>>;
export interface ProviderBudget { acquire(req: Request): Promise<() => Promise<void>> }
export function createSupabaseProviderBudget(config?: { url?: string; serviceRoleKey?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): ProviderBudget;
export function createLegacyHandler(config: { provider: Provider; operation: 'rewrite' | 'opinion'; budget?: ProviderBudget; requireBudget?: boolean }): (req: Request) => Promise<Response>;
