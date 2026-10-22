import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply } from '../src/index.js'

const parent = 'session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/test-subagents.json', import.meta.url), 'utf8'))
const ids = fixture.subagentIds

function makeCtx(home, options = {}) {
  const registered = new Map()
  // Only the fixture subagent that really exists on disk has a cached projection row.
  const projRows = new Map([[ids[0], { identity: {}, rows: {} }]])
  const workspaceRows = new Map()
  const globalState = { archivedSessionIds: [], initialized: true, workspaceIds: [] }

  const parentAgent = {
    id: parent,
    status: 'running',
    cancel() { drainCalls.push(['cancel', this.id]) },
    whenIdle: async () => {},
  }
  const drainCalls = []
  const markerCalls = []
  const sessions = {
    store: { get: () => undefined, delete: () => false },
    get: () => undefined,
    flush: async () => false,
    prepare(id, opts) {
      markerCalls.push(['prepare', id, opts])
      return { id, header: { id, ...(opts?.meta ?? {}) }, events: [] }
    },
    enter(session) {
      markerCalls.push(['enter', session.id])
      return () => markerCalls.push(['detach', session.id])
    },
    announce(session) {
      markerCalls.push(['announce', session.id])
    },
    _markerCalls: markerCalls,
  }
  const toolRuntime = { register(def) { registered.set(def.name, def) } }
  const teamDismissals = []
  const routes = []
  const webServer = options.withHttp === true
    ? { register(route) { routes.push(route); return () => {} } }
    : undefined
  const ctx = {
    tools: toolRuntime,
    effect(fn) { return fn() },
    // Cordis invokes an inject callback only once the service exists.
    inject(names, cb) { if (webServer !== undefined) cb({ ...ctx, webServer }) },
    get(name) {
      if (name === 'tools') return toolRuntime
      if (name === 'webServer') return webServer
      if (name === 'subagents') {
        const rows = options.rows ?? ids.map((id, i) => ({
          kind: 'child',
          id,
          parentId: parent,
          depth: 1,
          activity: 'inactive',
          mode: 'one-shot',
          label: `test subagent ${i + 1}`,
          hasChildren: false,
        }))
        return {
          listDescendants: async (rootId) => (rootId !== parent ? [] : rows),
          drainChildren: async (agent, childIds) => { drainCalls.push(['drainChildren', agent, childIds]) },
        }
      }
      if (name === 'agentTeams') {
        if (options.agentTeams === null) return undefined
        return options.agentTeams ?? {
          listMembers: () => [{ id: ids[0], name: 'fixture-teammate', role: 'teammate' }],
          dismissTeammate: async (agent, name) => {
            teamDismissals.push([agent, name])
            return { name, role: 'teammate' }
          },
        }
      }
      if (name === 'sessions') return sessions
      if (name === 'agents') {
        return { get: (id) => (id === parent ? parentAgent : undefined) }
      }
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
    _drainCalls: drainCalls,
    _teamDismissals: teamDismissals,
    _parentAgent: parentAgent,
    _routes: routes,
  }
  return ctx
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subagent-delete-apply-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home
  t.after(() => { delete process.env.DSH_HOME })
  return home
}

test('apply registers delete_subagent/release_subagent/list_subagents and tool execute removes a fixture subagent', async (t) => {
  const home = tempHome(t)

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
    agent: ctx._parentAgent,
    signal: new AbortController().signal,
  }
  // Deleted catalog children are hidden unless the caller asks for them.
  const list = await defs.get('list_subagents').execute({}, exec)
  assert.deepEqual(list.map((entry) => entry.id), [ids[0]])
  assert.equal(list[0].present, true)
  const all = await defs.get('list_subagents').execute({ include_absent: true }, exec)
  assert.equal(all.length, 10)
  assert.equal(all.find((entry) => entry.id === ids[1]).present, false)

  const result = await defs.get('delete_subagent').execute({ subagent_id: ids[0], recursive: false }, exec)
  assert.deepEqual(result.deleted, [ids[0]])
  assert.deepEqual(result.already_absent, [])
  assert.equal(fs.existsSync(dir), false)
  assert.equal(ctx._projRows.has(ids[0]), false)
  // A Team member is dismissed from the durable roster so the Team UI drops it.
  assert.equal(result.results[0].dismissed, true)
  assert.deepEqual(ctx._teamDismissals, [[ctx._parentAgent, 'fixture-teammate']])

  // The official lifecycle seam is exercised so web clients receive
  // api-session/added + api-session/removed frames and can refresh.
  assert.equal(result.results[0].refreshPulse, true)
  const markerCalls = ctx.get('sessions')._markerCalls
  assert.deepEqual(markerCalls.slice(0, 3).map((call) => call[0]), ['prepare', 'enter', 'announce'])
  assert.equal(markerCalls[markerCalls.length - 1][0], 'detach')
})

test('delete_subagent reports an already-absent catalog child instead of failing', async (t) => {
  const home = tempHome(t)
  const ctx = makeCtx(home)
  const cleanup = await apply(ctx)
  t.after(() => cleanup())

  const exec = { agent: ctx._parentAgent, signal: new AbortController().signal }
  const result = await ctx._registered.get('delete_subagent').execute({ subagent_id: ids[3], recursive: false }, exec)
  assert.deepEqual(result.deleted, [])
  assert.deepEqual(result.already_absent, [ids[3]])
  // Not a roster member: nothing to dismiss.
  assert.equal(result.results[0].dismissed, false)
  assert.deepEqual(ctx._teamDismissals, [])
  // Nothing was removed, so no refresh marker is published.
  assert.equal(ctx.get('sessions')._markerCalls.length, 0)
})

test('release_subagent drains the resident child through the exact live parent', async (t) => {
  const home = tempHome(t)
  const ctx = makeCtx(home)
  const cleanup = await apply(ctx)
  t.after(() => cleanup())

  const exec = { agent: ctx._parentAgent, signal: new AbortController().signal }
  const result = await ctx._registered.get('release_subagent').execute({ subagent_id: ids[2], recursive: false }, exec)
  assert.deepEqual(result.released, [ids[2]])
  assert.equal(result.results[0].drained, true)
  assert.deepEqual(ctx._drainCalls[0], ['drainChildren', ctx._parentAgent, [ids[2]]])
})

test('list_subagents surfaces an unreadable child catalog branch', async (t) => {
  const home = tempHome(t)
  const ctx = makeCtx(home, {
    rows: [
      { kind: 'child', id: ids[0], parentId: parent, depth: 1, activity: 'running', mode: 'continuable', label: 'live', hasChildren: true },
      { kind: 'diagnostic', id: ids[1], parentId: parent, depth: 1, reason: 'corrupt' },
    ],
  })
  const cleanup = await apply(ctx)
  t.after(() => cleanup())

  const exec = { agent: ctx._parentAgent, signal: new AbortController().signal }
  const listed = await ctx._registered.get('list_subagents').execute({ include_absent: true }, exec)
  assert.equal(listed.length, 2)
  const broken = listed.find((entry) => entry.id === ids[1])
  assert.equal(broken.unreadable, 'corrupt')
  assert.equal(broken.activity, 'inactive')

  // A diagnostic branch is still a deletable target.
  const targets = await ctx._registered.get('list_subagents').execute({ mode: 'unknown', include_absent: true }, exec)
  assert.deepEqual(targets.map((entry) => entry.id), [ids[1]])
})

test('apply registers the three HTTP routes and serves the list route', async (t) => {
  const home = tempHome(t)
  const ctx = makeCtx(home, { withHttp: true })
  const cleanup = await apply(ctx)
  t.after(() => cleanup())

  assert.deepEqual(ctx._routes.map((route) => route.path), [
    '/dsh-plugin-subagent-delete/list',
    '/dsh-plugin-subagent-delete/delete',
    '/dsh-plugin-subagent-delete/release',
  ])
  assert.ok(ctx._routes.every((route) => route.kind === 'exact'))

  let status
  let body
  const res = {
    writeHead(code) { status = code },
    end(payload) { body = payload },
  }
  await ctx._routes[0].handler(
    { method: 'GET', url: `/dsh-plugin-subagent-delete/list?parentSessionId=${parent}` },
    res,
  )
  assert.equal(status, 200)
  const payload = JSON.parse(body)
  assert.equal(payload.ok, true)
  assert.equal(payload.subagents.length, 10)

  status = undefined
  await ctx._routes[0].handler({ method: 'GET', url: '/dsh-plugin-subagent-delete/list' }, res)
  assert.equal(status, 400)

  await ctx._routes[1].handler({ method: 'GET', url: '/dsh-plugin-subagent-delete/delete' }, res)
  assert.equal(status, 405)
})

test('delete_subagent tool refuses a foreign subagent', async (t) => {
  const home = tempHome(t)

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
