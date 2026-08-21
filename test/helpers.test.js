import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionIdVariants } from '../src/index.js'

test('sessionIdVariants expands raw uuid and session- prefixed form', () => {
  const id = '0fcfbdd6-5d21-46a4-bd95-2ca6edac1261'
  assert.deepEqual(new Set(sessionIdVariants(id)), new Set([
    id,
    `session-${id}`,
  ]))
  assert.deepEqual(new Set(sessionIdVariants(`session-${id}`)), new Set([
    `session-${id}`,
    id,
  ]))
})
