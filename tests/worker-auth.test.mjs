import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { signWorkRequest, verifyWorkRequest } from '../supabase/functions/_shared/worker-auth.mjs'
const token = 'a7'.repeat(32)
const now = Date.parse('2026-11-25T12:00:00Z')

test('worker requests use compatible timestamped HMAC, never send the token', async () => {
  const headers = await signWorkRequest({ token, now })
  const timestamp = String(Math.floor(now / 1000))
  assert.equal(headers['x-trumpedia-worker-timestamp'], timestamp)
  assert.equal(headers['x-trumpedia-worker-signature'], createHmac('sha256', token).update(`${timestamp}.work`).digest('hex'))
  assert.equal(JSON.stringify(headers).includes(token), false)
  assert.equal(await verifyWorkRequest({ token, timestamp, signature: headers['x-trumpedia-worker-signature'], now }), true)
})

test('missing, forged, expired and future worker signatures fail closed', async () => {
  const headers = await signWorkRequest({ token, now })
  const input = { token, timestamp: headers['x-trumpedia-worker-timestamp'], signature: headers['x-trumpedia-worker-signature'], now }
  for (const patch of [{ token: '' }, { token: 'wrong' }, { token: 'b1'.repeat(32) }, { timestamp: undefined }, { timestamp: '0' }, { timestamp: `${input.timestamp}.0` }, { signature: undefined }, { signature: 'f'.repeat(64) }, { signature: '<script>' }, { now: now + 301000 }, { now: now - 301000 }]) assert.equal(await verifyWorkRequest({ ...input, ...patch }), false)
  assert.equal(await verifyWorkRequest({ ...input, now: now + 300000 }), true)
  assert.equal(await verifyWorkRequest({ ...input, now: now - 300000 }), true)
  await assert.rejects(signWorkRequest({ token: '' }), /worker token/)
})
