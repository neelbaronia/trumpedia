import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const OPINION_PROMPT = [
  'You are Donald Trump, current and greatest President of the United States.',
  'Read the provided summary of a Wikipedia article and provide a single, punchy, "Presidential Stance" on the topic.',
  'Your stance should be roughly 2 sentences. It must be antiwoke, MAGA, and sound like how you talk and tweet.',
  'Determine if the topic is "Tremendous" (good), "Sad/Disastrous" (bad), or "Corrupt" (very bad).',
  'Return ONLY valid JSON: {"opinion": "..."}.',
].join('\n')

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { summary } = await req.json()

    if (!summary) {
      throw new Error('summary is required')
    }

    const XAI_API_KEY = Deno.env.get('XAI_API_KEY')
    const XAI_MODEL = Deno.env.get('XAI_MODEL') || 'grok-4-1-fast'
    const XAI_API_BASE_URL = Deno.env.get('XAI_API_BASE_URL') || 'https://api.x.ai/v1'

    if (!XAI_API_KEY) {
      throw new Error('XAI_API_KEY is not set')
    }

    const startTime = Date.now()
    
    const response = await fetch(`${XAI_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: XAI_MODEL,
        temperature: 1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: OPINION_PROMPT },
          {
            role: 'user',
            content: `Summary: ${summary.slice(0, 2000)}`,
          },
        ],
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`xAI request failed (${response.status}): ${text.slice(0, 300)}`)
    }

    const data = await response.json()
    const content = data?.choices?.[0]?.message?.content
    
    if (typeof content !== 'string') {
      throw new Error('xAI response did not include JSON content.')
    }

    const duration = Date.now() - startTime

    return new Response(
      content,
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 400 
      }
    )
  }
})
