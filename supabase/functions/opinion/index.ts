import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createProvider } from '../_shared/provider.mjs'
import { createLegacyHandler, createSupabaseProviderBudget } from '../_shared/legacy-http.mjs'

const provider = createProvider({
  apiKey: Deno.env.get('XAI_API_KEY'),
  model: Deno.env.get('XAI_MODEL') || undefined,
  baseUrl: Deno.env.get('XAI_API_BASE_URL') || undefined,
  reasoningEffort: Deno.env.get('XAI_REASONING_EFFORT') || undefined,
  onMetric: metric => console.log(JSON.stringify({ event: 'provider_attempt', ...metric })),
})

const budget = createSupabaseProviderBudget({
  url: Deno.env.get('SUPABASE_URL'),
  serviceRoleKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
})

serve(createLegacyHandler({ provider, budget, operation: 'opinion' }))
