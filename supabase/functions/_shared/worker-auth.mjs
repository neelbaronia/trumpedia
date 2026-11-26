// @ts-self-types="./worker-auth.d.mts"
// A worker signature can only wake already admitted work, never create jobs or access storage.
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token)
const message = timestamp => new TextEncoder().encode(`${timestamp}.work`)
const signingKey = token => crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')

export async function signWorkRequest({ token, now = Date.now() } = {}) {
  if (!validToken(token)) throw new Error('A 32-byte worker token is required.')
  const timestamp = String(Math.floor(now / 1000))
  const signature = hex(await crypto.subtle.sign('HMAC', await signingKey(token), message(timestamp)))
  return { 'x-trumpedia-worker-timestamp': timestamp, 'x-trumpedia-worker-signature': signature }
}

export async function verifyWorkRequest({ token, timestamp, signature, now = Date.now() } = {}) {
  if (!validToken(token) || typeof timestamp !== 'string' || !/^\d{10,12}$/.test(timestamp) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/i.test(signature)) return false
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300) return false
  const bytes = Uint8Array.from(signature.match(/../g), pair => parseInt(pair, 16))
  try { return await crypto.subtle.verify('HMAC', await signingKey(token), bytes, message(timestamp)) } catch { return false }
}
