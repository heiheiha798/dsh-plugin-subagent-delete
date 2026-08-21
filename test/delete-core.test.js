import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { deleteSessionCore } from '../src/index.js'

function makeDiskSession(home, id) {
  const dir = path.join(home, 'sessions', '--data-home-tianjianyang-dsh_plugins--', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'fake-zstd')
  return dir
}

test('deleteSessionCore removes disk log, projection row and workspace accounting', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-delete-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  t.after(() => { delete process.env.DSH_HOME })

  const id = '0fcfbdd6-5d21-46a4-bd95-2ca6edac1261'
  const dir = makeDiskSession(home, id)

  const projRows = new Map([[id, { identity: {}, rows: {} }]])
  const workspaceRows = new Map([[
    'w1',
    { sessionIds: [id, 'session-3037a0d2-40db-4cde-aca1-af3aa6a6bc75'], title: 'ws' },
  ]])
  const globalState = { archivedSessionIds: [`session-${id}`], initialized: true, workspaceIds: ['w1'] }

  const liveStore = new Map()
  const sessions = {
    store: {
      get(key) { return liveStore.get(key) },
      delete(key) { liveStore.delete(key) },
    },
    attachments: {
      delete() {},
    },
    get(key) { return liveStore.get(key)?.session },
    flush: async () => true,
  }
  const agents = { get: () => undefined }

  const ctx = {
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'agents') return agents
      if (name === 'storageDomain') {
        return {
          get(domainName) {
            if (domainName === 'session_projcache') {
              return {
                table() {
                  return {
                    get: (key) => projRows.get(key),
                    delete: async (key) => { projRows.delete(key) },
                    entries() { return projRows.entries() },
                  }
                },
              }
            }
            if (domainName === 'workspace') {
              return {
                table() {
                  return {
                    entries() { return workspaceRows.entries() },
                    put: async (wid, rec) => { workspaceRows.set(wid, rec) },
                  }
                },
                global: {
                  get: () => globalState,
                  set: async (next) => { Object.assign(globalState, next) },
                },
              }
            }
            return undefined
          },
        }
      }
      return undefined
    },
  }

  const result = await deleteSessionCore(ctx, id)

  assert.equal(result.deleted, true)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(projRows.has(id), false)
  assert.deepEqual(workspaceRows.get('w1').sessionIds, [
    'session-3037a0d2-40db-4cde-aca1-af3aa6a6bc75',
  ])
  assert.equal(globalState.archivedSessionIds.includes(id), false)
  assert.equal(globalState.archivedSessionIds.includes(`session-${id}`), false)
})

test('deleteSessionCore reports not-found for an unknown id', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-delete-empty-'))
  process.env.DSH_HOME = home
  try {
    const ctx = {
      get(name) {
        if (name === 'sessions') return { store: { get: () => undefined }, get: () => undefined, flush: async () => false }
        if (name === 'agents') return { get: () => undefined }
        if (name === 'storageDomain') return {
          get() {
            return { table: () => ({ get: () => undefined, delete: async () => {}, entries: () => [] }), global: { get: () => ({}), set: async () => {} } }
          },
        }
        return undefined
      },
    }
    await assert.rejects(
      () => deleteSessionCore(ctx, '14c47a82-077f-47eb-be43-8ea127a27dfc'),
      (error) => error.code === 'not-found',
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
    delete process.env.DSH_HOME
  }
})
