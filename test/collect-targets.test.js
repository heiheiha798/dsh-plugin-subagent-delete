import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { collectTargets, resolveDescendants } from '../src/index.js'

const parent = 'session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/test-subagents.json', import.meta.url), 'utf8'))
const ids = fixture.subagentIds

function entriesFor(rows) {
  return rows
}

function visibleFrom(rows, rootId) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return rows.filter((row) => {
    let cursor = row.parentId
    for (let guard = 0; guard < 128; guard++) {
      if (cursor === rootId) return true
      const next = byId.get(cursor)?.parentId
      if (next === undefined) return false
      cursor = next
    }
    return false
  })
}

function mockCtx(rows, rootId = parent) {
  return {
    get(name) {
      if (name === 'subagents') {
        return { listDescendants: async (_root, _signal) => visibleFrom(rows, rootId) }
      }
      if (name === 'agents') {
        return { get: () => undefined }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () => rows
            .filter((r) => r.parentId === rootId)
            .map((r) => ({ id: r.id, parentSession: rootId, origin: 'subagent' })),
        }
      }
      return undefined
    },
  }
}

test('resolveDescendants returns the ten test subagents', async () => {
  const rows = entriesFor(ids.map((id, i) => ({
    kind: 'child',
    id,
    parentId: parent,
    depth: 1,
    activity: 'inactive',
    mode: 'one-shot',
    label: `test subagent ${i + 1}`,
    hasChildren: false,
  })))
  const out = await resolveDescendants(mockCtx(rows), parent)
  assert.equal(out.length, 10)
})

test('collectTargets deletes exactly the selected subagent', async () => {
  const rows = entriesFor(ids.map((id, i) => ({
    kind: 'child',
    id,
    parentId: parent,
    depth: 1,
    activity: 'inactive',
    mode: 'one-shot',
    label: `test subagent ${i + 1}`,
    hasChildren: false,
  })))
  const targets = await collectTargets(mockCtx(rows), parent, ids[0], false)
  assert.deepEqual(targets, [ids[0]])
})

test('collectTargets requires recursive for a subagent with descendants', async () => {
  const rows = [
    {
      kind: 'child', id: ids[0], parentId: parent, depth: 1,
      activity: 'inactive', mode: 'continuable', label: 'root child', hasChildren: true,
    },
    {
      kind: 'child', id: ids[1], parentId: ids[0], depth: 2,
      activity: 'inactive', mode: 'one-shot', label: 'grandchild', hasChildren: false,
    },
  ]
  await assert.rejects(
    () => collectTargets(mockCtx(rows), parent, ids[0], false),
    (error) => error.code === 'has-descendants',
  )
})

test('collectTargets deletes subtree child-first with recursive: true', async () => {
  const rows = [
    {
      kind: 'child', id: ids[0], parentId: parent, depth: 1,
      activity: 'inactive', mode: 'continuable', label: 'root child', hasChildren: true,
    },
    {
      kind: 'child', id: ids[1], parentId: ids[0], depth: 2,
      activity: 'inactive', mode: 'one-shot', label: 'grandchild', hasChildren: false,
    },
    {
      kind: 'child', id: ids[2], parentId: ids[0], depth: 2,
      activity: 'inactive', mode: 'one-shot', label: 'grandchild 2', hasChildren: false,
    },
  ]
  const targets = await collectTargets(mockCtx(rows), parent, ids[0], true)
  assert.deepEqual(targets, [ids[1], ids[2], ids[0]])
})

test('collectTargets rejects a subagent that is not a descendant', async () => {
  const rows = entriesFor([{
    kind: 'child', id: ids[0], parentId: 'session-00000000-0000-4000-8000-000000000000',
    depth: 1, activity: 'inactive', mode: 'one-shot', label: 'foreign', hasChildren: false,
  }])
  await assert.rejects(
    () => collectTargets(mockCtx(rows), parent, ids[0], true),
    (error) => error.code === 'not-your-subagent',
  )
})

test('resolveDescendants walks lineage from dsh >= 0.1.5-rc wrapped persistence snapshots', async () => {
  // No ctx.subagents seam: the persistence fallback must carry the walk alone.
  // SessionPersistenceSnapshot rows wrap the SessionHeader in `.header`.
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [
            { header: { id: parent, parentSession: undefined }, revision: 'r0' },
            { header: { id: ids[0], parentSession: parent, origin: 'subagent' }, revision: 'r1' },
            { header: { id: ids[1], parentSession: ids[0], origin: 'subagent' }, revision: 'r2' },
            { header: { id: 'session-ffffffff-0000-4000-8000-000000000000', parentSession: undefined }, revision: 'r3' },
          ],
        }
      }
      return undefined
    },
  }
  const out = await resolveDescendants(ctx, parent)
  assert.equal(out.length, 2)
  assert.ok(out.some((entry) => entry.id === ids[0] && entry.parentId === parent))
  assert.ok(out.some((entry) => entry.id === ids[1] && entry.parentId === ids[0]))
})
