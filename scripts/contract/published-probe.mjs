// Contract probe for the plugin's host half.
//
// Runs against whatever `@deepseek-ai/dsh-*` packages are installed in the
// probe directory (see scripts/verify-published-dsh.mjs) and drives the plugin
// through the REAL ToolRuntime: registration, schema compilation, and tool
// execution. The Host services the plugin reads (subagents, sessions, agents,
// storageDomain) are provided as fakes so the probe stays hermetic.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from './plugin/index.js'

const parent = 'session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
const child = '0fcfbdd6-5d21-46a4-bd95-2ca6edac1261'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-contract-'))
process.env.DSH_HOME = home
const childDir = path.join(home, 'sessions', '--data-home-probe--', child)
fs.mkdirSync(childDir, { recursive: true })
fs.writeFileSync(path.join(childDir, 'session.v4.jsonl'), 'x')

const projRows = new Map([[child, { identity: {}, rows: {} }]])
const drainCalls = []
const markerCalls = []
const parentAgent = { id: parent, status: 'running', cancel() {}, whenIdle: async () => {} }

const ctx = new Context()
await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)
const routes = []
ctx.provide('webServer', { register(route) { routes.push(route); return () => {} } })
ctx.provide('agents', { get: (id) => (id === parent ? parentAgent : undefined) })
ctx.provide('subagents', {
  async listDescendants(rootId) {
    if (rootId !== parent) return []
    return [{
      kind: 'child', id: child, parentId: parent, depth: 1,
      activity: 'inactive', mode: 'one-shot', label: 'probe child', hasChildren: false,
    }]
  },
  async drainChildren(agent, ids) { drainCalls.push([agent, ids]) },
})
ctx.provide('sessions', {
  store: { get: () => undefined, delete: () => false },
  get: () => undefined,
  flush: async () => false,
  prepare(id, options) {
    markerCalls.push(['prepare', id, options])
    return { id, header: { id, ...(options?.meta ?? {}) } }
  },
  enter(session) {
    markerCalls.push(['enter', session.id])
    return () => markerCalls.push(['detach', session.id])
  },
  announce(session) { markerCalls.push(['announce', session.id]) },
})
ctx.provide('storageDomain', {
  get(name) {
    if (name === 'session_projcache') {
      return {
        table: () => ({
          get: (key) => projRows.get(key),
          delete: async (key) => { projRows.delete(key) },
          entries: () => projRows.entries(),
        }),
      }
    }
    if (name === 'workspace') {
      return {
        table: () => ({ entries: () => new Map().entries(), put: async () => {} }),
        global: { get: () => ({ archivedSessionIds: [] }), set: async () => {} },
      }
    }
    return undefined
  },
})

await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })

const schemas = ctx.tools.schemas()
assert.deepEqual(
  schemas.map((schema) => schema.name).sort(),
  ['delete_subagent', 'list_subagents', 'release_subagent'],
)
const listSchema = schemas.find((schema) => schema.name === 'list_subagents')
assert.deepEqual(listSchema.parameters.properties.mode.enum, ['one-shot', 'continuable', 'external', 'unknown'])

assert.deepEqual(routes.map((route) => route.path), [
  '/dsh-plugin-subagent-delete/list',
  '/dsh-plugin-subagent-delete/delete',
  '/dsh-plugin-subagent-delete/release',
])
let httpStatus
let httpBody
await routes[0].handler(
  { method: 'GET', url: `/dsh-plugin-subagent-delete/list?parentSessionId=${parent}` },
  { writeHead(code) { httpStatus = code }, end(body) { httpBody = body } },
)
assert.equal(httpStatus, 200)
assert.equal(JSON.parse(httpBody).subagents.length, 1)

const signal = new AbortController().signal
const listed = await ctx.tools.execute({ callId: 'probe-list', name: 'list_subagents', arguments: {}, signal, agent: parentAgent })
assert.equal(listed.isError, false)
const listPayload = JSON.parse(listed.content[0].text)
assert.equal(listPayload[0].id, child)
assert.equal(listPayload[0].present, true)

const deleted = await ctx.tools.execute({
  callId: 'probe-delete', name: 'delete_subagent', arguments: { subagent_id: child }, signal, agent: parentAgent,
})
assert.equal(deleted.isError, false)
assert.deepEqual(JSON.parse(deleted.content[0].text).deleted, [child])
assert.equal(fs.existsSync(childDir), false, 'durable session directory removed')
assert.equal(projRows.has(child), false, 'projection cache row removed')
assert.deepEqual(drainCalls[0], [parentAgent, [child]], 'release used the exact live parent')
assert.deepEqual(markerCalls.slice(0, 3).map((call) => call[0]), ['prepare', 'enter', 'announce'])
assert.equal(markerCalls.at(-1)[0], 'detach')

const released = await ctx.tools.execute({
  callId: 'probe-release', name: 'release_subagent', arguments: { subagent_id: child }, signal, agent: parentAgent,
})
assert.equal(released.isError, false)
assert.equal(JSON.parse(released.content[0].text).released[0], child)

const foreign = await ctx.tools.execute({
  callId: 'probe-foreign', name: 'delete_subagent', arguments: { subagent_id: child }, signal,
  agent: { id: 'session-00000000-0000-4000-8000-000000000000' },
})
assert.equal(foreign.isError, true)
assert.match(foreign.error.message, /is not a descendant/)

console.log('contract probe OK: tools register, schemas compile, delete/release/list execute')
fs.rmSync(home, { recursive: true, force: true })
await ctx.fiber.dispose()
