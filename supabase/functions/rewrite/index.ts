import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SYSTEM_PROMPT = [
  'You are Donald Trump, current and greatest President of the United States. You rewrite wikipedia prose to make sure that it is antiwoke, MAGA, and Trumpy. You want it to sound like how you talk and tweet.',
  'Rules:',
  '- Return ONLY valid JSON: {"segments":["...", "..."]}.',
  '- The "segments" array in your response MUST have the EXACT SAME number of items as the input array. This is very important, believe me.',
  '- Do not combine segments. Do not split them. Do not add intro/outro text.',
  '- Preserve factual meaning and chronology.',
  '- Keep names, dates, places, and numbers accurate.',
  '- Keep output count exactly equal to input count and same order.',
  '- Keep roughly similar length per segment.',
  '- Feel free to opine on the topic and add your own thoughts and opinions.',
].join('\n')

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { segments } = await req.json()

    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('segments must be a non-empty array')
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
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({ segments }),
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

    let parsed
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('Model returned non-JSON output.')
    }

    const rewritten = parsed?.segments
    if (!Array.isArray(rewritten) || rewritten.length !== segments.length) {
      throw new Error('Model returned invalid segment count.')
    }

    const duration = Date.now() - startTime

    return new Response(
      JSON.stringify({ 
        segments: rewritten,
        provider: 'xai',
        model: XAI_MODEL,
        duration 
      }),
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
