import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../src/index.js'

const parent = 'session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/test-subagents.json', import.meta.url), 'utf8'))
const ids = fixture.subagentIds

function makeCtx(home) {
  const registered = new Map()
  const projRows = new Map(ids.map((id) => [id, { identity: {}, rows: {} }]))
  const workspaceRows = new Map()
  const globalState = { archivedSessionIds: [], initialized: true, workspaceIds: [] }

  const toolRuntime = { register(def) { registered.set(def.name, def) } }
  const ctx = {
    tools: toolRuntime,
    effect() {},
    inject(names, cb) { cb({ ...ctx, webServer: undefined }) },
    get(name) {
      if (name === 'tools') return toolRuntime
      if (name === 'subagents') {
        return {
          listDescendants: async (rootId) => {
            if (rootId !== parent) return []
            return ids.map((id, i) => ({
              kind: 'child',
              id,
              parentId: parent,
              depth: 1,
              activity: 'inactive',
              mode: 'one-shot',
              label: `test subagent ${i + 1}`,
              hasChildren: false,
            }))
          },
        }
      }
      if (name === 'sessions') return {
        store: { get: () => undefined },
        get: () => undefined,
        flush: async () => false,
      }
      if (name === 'agents') return { get: () => undefined }
      if (name === 'sessionPersistence') return { list: async () => [] }
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
                    put: async () => {},
                  }
                },
                global: { get: () => globalState, set: async () => {} },
              }
            }
            return undefined
          },
        }
      }
      return undefined
    },
    _registered: registered,
    _projRows: projRows,
  }
  return ctx
}

test('apply registers delete_subagent/release_subagent/list_subagents and tool execute removes a fixture subagent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-delete-apply-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  t.after(() => { delete process.env.DSH_HOME })

  // One of the ten fixture subagents exists on disk.
  const dir = path.join(home, 'sessions', '--data-home-tianjianyang-dsh_plugins--', ids[0])
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), 'fake')

  const ctx = makeCtx(home)
  const cleanup = await apply(ctx)
  t.after(() => cleanup())

  const defs = ctx._registered
  for (const name of ['delete_subagent', 'release_subagent', 'list_subagents']) {
    assert.ok(defs.has(name), `missing tool ${name}`)
  }

  const exec = {
    agent: { id: parent },
    signal: new AbortController().signal,
  }
  const list = await defs.get('list_subagents').execute({}, exec)
  assert.equal(list.length, 10)

  const result = await defs.get('delete_subagent').execute({ subagent_id: ids[0], recursive: false }, exec)
  assert.deepEqual(result.deleted, [ids[0]])
  assert.equal(result.removed_from_ui_list, true)
  assert.equal(fs.existsSync(dir), false)
  assert.equal(ctx._projRows.has(ids[0]), false)
})

test('delete_subagent tool refuses a foreign subagent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-delete-apply2-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  t.after(() => { delete process.env.DSH_HOME })

  const ctx = makeCtx(home)
  const cleanup = await apply(ctx)
  t.after(() => cleanup())
  const exec = { agent: { id: 'session-00000000-0000-4000-8000-000000000000' }, signal: new AbortController().signal }
  const def = ctx._registered.get('delete_subagent')
  await assert.rejects(
    () => def.execute({ subagent_id: ids[0], recursive: false }, exec),
    (error) => error.code === 'not-your-subagent',
  )
})
