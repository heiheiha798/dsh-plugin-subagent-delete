// dsh-plugin-subagent-delete — host plugin.
//
// Provides the missing subagent lifecycle interface:
//   * delete_subagent   permanently remove a subagent session (log dir,
//                       projection cache, workspace accounting, live store
//                       entry) so it disappears from the web UI list;
//   * release_subagent  stop a running subagent / drain a continuable child
//                       WITHOUT deleting its transcript (cold resume still
//                       possible);
//   * list_subagents    list the caller's descendant subagents with
//                       activity/mode/label/depth.
//
// HTTP routes (optional web surface):
//   GET  /dsh-plugin-subagent-delete/list?parentSessionId=...
//   POST /dsh-plugin-subagent-delete/delete   { parentSessionId, subagentId, recursive? }
//   POST /dsh-plugin-subagent-delete/release  { parentSessionId, subagentId, recursive? }
//
// Safety: a tool call may only target a descendant of the calling agent's own
// session. The HTTP route requires the same explicit parentSessionId.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-plugin-subagent-delete'
export const inject = ['tools']

const SESSION_ID_RE = /^(session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDLE_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024

class DeleteError extends Error {
  constructor(message, status = 500, code = 'delete-failed') {
    super(message)
    this.status = status
    this.code = code
  }
}

// --- generic helpers ----------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

/** Session ids appear both as raw uuid and as `session-<uuid>`. */
function sessionIdVariants(sessionId) {
  const variants = new Set([sessionId])
  if (sessionId.startsWith('session-')) variants.add(sessionId.slice('session-'.length))
  else if (SESSION_ID_RE.test(sessionId)) variants.add(`session-${sessionId}`)
  return [...variants]
}

/** Scan ~/.dsh/sessions/<slug>/<id> for every spelling of the id. */
function findSessionDirs(sessionId) {
  const root = sessionsRoot()
  let slugs = []
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const variants = sessionIdVariants(sessionId)
  const found = []
  for (const slug of slugs) {
    for (const variant of variants) {
      const candidate = path.join(root, slug, variant)
      try {
        if (fs.statSync(candidate).isDirectory()) found.push(candidate)
      } catch {
        // keep scanning
      }
    }
  }
  return found
}

function removeSessionDirs(sessionId) {
  const dirs = findSessionDirs(sessionId)
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return dirs.length > 0
}

// --- storage domain cleanup ---------------------------------------------------

async function stripStorageDomains(ctx, sessionId, { workspace = true } = {}) {
  const sd = ctx.get('storageDomain')
  if (!sd) return { projRemoved: false, workspaceRemoved: false }
  const variants = sessionIdVariants(sessionId)
  let projRemoved = false
  let workspaceRemoved = false

  const proj = sd.get('session_projcache')
  if (proj && typeof proj.table === 'function') {
    try {
      const sessions = proj.table('sessions')
      for (const variant of variants) {
        if (sessions.get(variant) !== undefined) {
          await sessions.delete(variant)
          projRemoved = true
        }
      }
    } catch {
      // domain not open or table absent
    }
  }

  if (workspace) {
    const ws = sd.get('workspace')
    if (ws && typeof ws.table === 'function') {
      try {
        const workspaces = ws.table('workspaces')
        for (const [wid, rec] of workspaces.entries()) {
          if (rec && Array.isArray(rec.sessionIds) && variants.some((v) => rec.sessionIds.includes(v))) {
            await workspaces.put(wid, {
              ...rec,
              sessionIds: rec.sessionIds.filter((x) => !variants.includes(x)),
            })
            workspaceRemoved = true
          }
        }
      } catch {
        // ignore
      }
      try {
        const g = ws.global
        if (g && typeof g.get === 'function' && typeof g.set === 'function') {
          const state = g.get()
          if (state && Array.isArray(state.archivedSessionIds) && variants.some((v) => state.archivedSessionIds.includes(v))) {
            await g.set({ ...state, archivedSessionIds: state.archivedSessionIds.filter((x) => !variants.includes(x)) })
            workspaceRemoved = true
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return { projRemoved, workspaceRemoved }
}

// --- live-session teardown ----------------------------------------------------

async function stopAgentIfRunning(ctx, sessionId) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.get !== 'function') return false
  let stopped = false
  for (const variant of sessionIdVariants(sessionId)) {
    const agent = agents.get(variant)
    if (!agent) continue
    if (agent.status === 'running' && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'user' })
        stopped = true
      } catch {
        // already settling
      }
    }
    if (typeof agent.whenIdle === 'function') {
      try {
        await Promise.race([
          agent.whenIdle(),
          new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS)),
        ])
      } catch {
        // proceed anyway; the hard delete removes the log regardless
      }
    }
  }
  return stopped
}

async function flushSessionIfLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.get !== 'function') return false
  let flushed = false
  for (const variant of sessionIdVariants(sessionId)) {
    const session = sessions.get(variant)
    if (!session) continue
    if (typeof sessions.flush === 'function') {
      try {
        await sessions.flush(session)
        flushed = true
      } catch {
        // deletion proceeds
      }
    }
  }
  return flushed
}

/** Remove a live session from ctx.sessions so host list/query stop returning it. */
function detachLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions) return false
  let detached = false
  for (const variant of sessionIdVariants(sessionId)) {
    try {
      const store = sessions.store
      const entry = store && typeof store.get === 'function' ? store.get(variant) : undefined
      if (entry === undefined) continue
      if (typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      } else if (store && typeof store.delete === 'function') {
        store.delete(variant)
        if (sessions.attachments && entry.session && typeof sessions.attachments.delete === 'function') {
          sessions.attachments.delete(entry.session)
        }
        detached = true
      }
    } catch {
      // ignore
    }
  }
  return detached
}

// --- subagent discovery / authorization ---------------------------------------

/**
 * Resolve the full descendant listing for `rootId`.
 * Prefer the official ctx.subagents projection-backed enumeration; fall back
 * to persisted headers when the subagent seam is not mounted.
 */
async function resolveDescendants(ctx, rootId, signal) {
  const subagents = ctx.get('subagents')
  if (subagents && typeof subagents.listDescendants === 'function') {
    return await subagents.listDescendants(rootId, signal)
  }

  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') {
    return []
  }
  const headers = await persistence.list()
  const byId = new Map()
  for (const header of headers) {
    byId.set(header.id, header)
  }
  const out = []
  for (const header of headers) {
    if (header.id === rootId) continue
    // Walk the parent chain; include only subagent-origin descendants.
    let cursor = header
    const chain = [header.id]
    for (let guard = 0; guard < 64; guard++) {
      const parentId = cursor.parentSession
      if (parentId === undefined) break
      chain.push(parentId)
      if (parentId === rootId) {
        out.push({
          kind: 'child',
          id: header.id,
          activity: ctx.get('agents')?.get?.(header.id) ? 'running' : 'inactive',
          mode: 'one-shot',
          label: header.id,
          hasChildren: false,
          parentId: header.parentSession,
          depth: chain.length - 1,
        })
        break
      }
      const parent = byId.get(parentId)
      if (!parent) break
      cursor = parent
    }
  }
  return out
}

function entryById(entries, id) {
  return entries.find((entry) => entry.id === id) ?? null
}

/** Collect target + its whole descendant subtree. */
function collectSubtree(entries, targetId) {
  const target = entries.find((entry) => entry.id === targetId)
  if (!target) return null
  const parentOf = new Map()
  for (const entry of entries) {
    if (entry.parentId !== undefined) parentOf.set(entry.id, entry.parentId)
  }
  const subtree = []
  for (const entry of entries) {
    let cursor = entry.id
    let onPath = false
    for (let guard = 0; guard < 128; guard++) {
      if (cursor === targetId) {
        onPath = true
        break
      }
      const next = parentOf.get(cursor)
      if (next === undefined) break
      cursor = next
    }
    if (onPath) subtree.push(entry)
  }
  if (!subtree.some((entry) => entry.id === targetId)) subtree.unshift(target)
  return subtree
}

function deletionOrder(subtree) {
  return [...subtree]
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || String(a.id).localeCompare(String(b.id)))
    .map((entry) => entry.id)
}

// --- one-session delete -------------------------------------------------------

/**
 * Use the official continuable-drain seam when the parent agent is known:
 * the selected resident Activation is released child-side (its AgentHandle is
 * disposed) while the durable transcript stays resumable.
 */
async function drainContinuableChild(ctx, sessionId, parentAgent) {
  const subagents = ctx.get('subagents')
  if (!subagents || !parentAgent || typeof subagents.drainContinuableChildren !== 'function') {
    return false
  }
  try {
    await Promise.race([
      subagents.drainContinuableChildren(parentAgent, [sessionId]),
      new Promise((resolve) => setTimeout(resolve, IDLE_TIMEOUT_MS)),
    ])
    return true
  } catch {
    // Non-resident/one-shot targets are accepted no-ops; a stale parent falls
    // through to the generic agent cancel below.
    return false
  }
}

async function releaseSession(ctx, sessionId, parentAgent) {
  const drained = await drainContinuableChild(ctx, sessionId, parentAgent)
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  // For a live continuable child, the official drain releases its Activation
  // while the durable session stays available for cold resume / send_message.
  return { released: true, drained, stopped, sessionId }
}


/**
 * Publish a transient marker session through the OFFICIAL session lifecycle
 * seam (`prepare -> enter -> announce -> detach`). This is the same mechanism
 * a new subagent uses to light up the web UI, mirrored so a permanent delete
 * also updates it: the marker carries parentSession, so the client runtime
 * emits `host/session-added` + `host/session-removed` frames for a child of
 * that parent. The companion client plugin (lib/client.js) sees the removed
 * child marker and refreshes the parent subagent catalog + session list.
 *
 * Session.create seeds permission/sandbox events; we flush them so the
 * `_no-cwd` artifact is materialized before detach and can be swept below.
 */
async function sweepMarkerDirs(markerId) {
  for (let pass = 0; pass < 25; pass++) {
    removeSessionDirs(markerId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (findSessionDirs(markerId).length === 0) return true
  }
  removeSessionDirs(markerId)
  return findSessionDirs(markerId).length === 0
}

async function emitRemovalMarker(ctx, parentSessionId) {
  const sessions = ctx.get('sessions')
  if (!sessions || typeof sessions.prepare !== 'function') return false
  const markerId = `session-${randomUUID()}`
  try {
    const marker = sessions.prepare(markerId, { meta: { parentSession: parentSessionId } })
    const detach = sessions.enter(marker)
    try {
      sessions.announce(marker)
      // Session.create seeds permission/sandbox events; force the persistence
      // backend to materialize them BEFORE detaching so the marker artifact is
      // already on disk when we sweep it below.
      if (typeof sessions.flush === 'function') await sessions.flush(marker)
      // Keep the marker announced across at least one client notifier flush.
      // Announcing and detaching in the same microtask lets the client batch
      // session-added and session-removed into one snapshot, so the companion
      // client plugin never observes the removal and cannot refresh the
      // subagent catalog. 250ms is long enough for the SSE frame + microtask
      // flush, short enough to be an invisible blink in the sidebar.
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      detach()
    }

    // The marker's disposal retirement may append one final flush; sweep until
    // the `_no-cwd` artifact is gone so the refresh glue leaves no trace.
    await sweepMarkerDirs(markerId)
    return true
  } catch {
    // The marker is best-effort UI refresh glue; deletion has already happened.
    try {
      await sweepMarkerDirs(markerId)
    } catch {
      // ignore
    }
    return false
  }
}

async function deleteSessionCore(ctx, sessionId, parentSessionId) {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new DeleteError(`invalid session id: ${sessionId}`, 400, 'invalid-session-id')
  }

  const variants = sessionIdVariants(sessionId)
  const agents = ctx.get('agents')
  const live = variants.some((v) => agents && typeof agents.get === 'function' && agents.get(v) !== undefined)
  const stopped = await stopAgentIfRunning(ctx, sessionId)
  await flushSessionIfLive(ctx, sessionId)
  const detached = detachLiveSession(ctx, sessionId)

  // Remove every on-disk artifact first. If the filesystem refuses we fail
  // before touching workspace accounting, so no half-deleted session falls
  // out of its group.
  const firstDirRemoved = removeSessionDirs(sessionId)
  const projStorage = await stripStorageDomains(ctx, sessionId, { workspace: false })
  await new Promise((resolve) => setImmediate(resolve))
  const secondDirRemoved = removeSessionDirs(sessionId)
  const remainingDirs = findSessionDirs(sessionId)
  if (remainingDirs.length > 0) {
    throw new DeleteError(`session files could not be fully removed: ${remainingDirs.join(', ')}`, 500, 'files-not-removed')
  }

  const workspaceStorage = await stripStorageDomains(ctx, sessionId, { workspace: true })
  const dirRemoved = firstDirRemoved || secondDirRemoved
  const projRemoved = projStorage.projRemoved || workspaceStorage.projRemoved
  const workspaceRemoved = workspaceStorage.workspaceRemoved
  if (!dirRemoved && !projRemoved && !workspaceRemoved && !live && !detached) {
    throw new DeleteError(`subagent session not found: ${sessionId}`, 404, 'not-found')
  }

  // Symmetric to subagent creation: publish a disposal marker so every open
  // web client refreshes the parent subagent catalog immediately.
  const refreshPulse = parentSessionId !== undefined ? await emitRemovalMarker(ctx, parentSessionId) : false

  return {
    sessionId,
    deleted: true,
    stopped,
    detached,
    dirRemoved,
    projRemoved,
    workspaceRemoved,
    refreshPulse,
  }
}

// --- tool-facing operations ----------------------------------------------------

async function collectTargets(ctx, callerSessionId, subagentId, recursive, signal) {
  if (!SESSION_ID_RE.test(String(subagentId))) {
    throw new DeleteError(`invalid subagent id: ${subagentId}`, 400, 'invalid-session-id')
  }
  const entries = await resolveDescendants(ctx, callerSessionId, signal)
  const subtree = collectSubtree(entries, String(subagentId))
  if (!subtree || subtree.length === 0) {
    const header = await findHeader(ctx, String(subagentId))
    if (!header || header.parentSession !== callerSessionId) {
      throw new DeleteError(
        `subagent ${subagentId} is not a descendant of session ${callerSessionId}`,
        403,
        'not-your-subagent',
      )
    }
    subtree.push({
      kind: 'child',
      id: String(subagentId),
      parentId: callerSessionId,
      depth: 1,
      mode: 'one-shot',
      activity: 'inactive',
      hasChildren: false,
      label: String(subagentId),
    })
  }
  const children = subtree.filter((entry) => entry.id !== String(subagentId))
  if (children.length > 0 && recursive !== true) {
    throw new DeleteError(
      `subagent ${subagentId} has ${children.length} descendant(s); pass recursive: true to delete the subtree`,
      409,
      'has-descendants',
    )
  }
  return deletionOrder(subtree)
}

async function findHeader(ctx, sessionId) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') return undefined
  const headers = await persistence.list()
  return headers.find((h) => h.id === sessionId) ?? null
}

// --- HTTP ---------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

async function httpList(ctx, query) {
  const parentSessionId = String(query.get('parentSessionId') ?? '').trim()
  if (!SESSION_ID_RE.test(parentSessionId)) {
    throw new DeleteError('parentSessionId is required', 400, 'invalid-parent-session-id')
  }
  const entries = await resolveDescendants(ctx, parentSessionId, undefined)
  const activity = query.get('activity')
  const mode = query.get('mode')
  return entries.filter((entry) => {
    if (activity && entry.activity !== activity) return false
    if (mode && entry.mode !== mode) return false
    return true
  })
}

// --- plugin --------------------------------------------------------------------

function apply(ctx) {
  const callerSessionIdOf = (exec) => {
    const id = exec?.agent?.id
    if (typeof id !== 'string' || id.length === 0) {
      throw new DeleteError('delete_subagent can only run inside an agent session', 400, 'no-caller-agent')
    }
    return id
  }

  const registerHttp = (host, targetCtx) => {
    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/dsh-plugin-subagent-delete/list',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const entries = await httpList(targetCtx, url.searchParams)
          sendJson(res, 200, { ok: true, subagents: entries })
        } catch (error) {
          sendJson(res, error instanceof DeleteError ? error.status : 500, { ok: false, error: error.message })
        }
      },
    }))

    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/dsh-plugin-subagent-delete/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          return sendJson(res, 400, { ok: false, error: 'bad-json-body' })
        }
        const parentSessionId = String(args.parentSessionId ?? '').trim()
        const subagentId = String(args.subagentId ?? '').trim()
        if (!SESSION_ID_RE.test(parentSessionId) || !SESSION_ID_RE.test(subagentId)) {
          return sendJson(res, 400, { ok: false, error: 'parentSessionId and subagentId are required' })
        }
        try {
          const targets = await collectTargets(targetCtx, parentSessionId, subagentId, args.recursive === true, undefined)
          const results = []
          for (const id of targets) results.push(await deleteSessionCore(targetCtx, id, parentSessionId))
          sendJson(res, 200, { ok: true, deleted: targets, results })
        } catch (error) {
          sendJson(res, error instanceof DeleteError ? error.status : 500, { ok: false, error: error.message })
        }
      },
    }))

    targetCtx.effect(() => host.register({
      kind: 'exact',
      path: '/dsh-plugin-subagent-delete/release',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
        let args = {}
        try {
          const body = await readBody(req)
          if (body) args = JSON.parse(body)
        } catch {
          return sendJson(res, 400, { ok: false, error: 'bad-json-body' })
        }
        const parentSessionId = String(args.parentSessionId ?? '').trim()
        const subagentId = String(args.subagentId ?? '').trim()
        if (!SESSION_ID_RE.test(parentSessionId) || !SESSION_ID_RE.test(subagentId)) {
          return sendJson(res, 400, { ok: false, error: 'parentSessionId and subagentId are required' })
        }
        try {
          const targets = await collectTargets(targetCtx, parentSessionId, subagentId, args.recursive === true, undefined)
          const parentAgent = targetCtx.get('agents')?.get?.(parentSessionId)
          const results = []
          for (const id of targets) results.push(await releaseSession(targetCtx, id, parentAgent))
          sendJson(res, 200, { ok: true, released: targets, results })
        } catch (error) {
          sendJson(res, error instanceof DeleteError ? error.status : 500, { ok: false, error: error.message })
        }
      },
    }))
  }

  ctx.tools.register(defineTool({
    name: 'delete_subagent',
    description:
      'Permanently delete one subagent session that belongs to the current session tree. '
      + 'Stops it if it is running, removes its durable log, projection cache and workspace accounting, '
      + 'and takes it out of the web UI subagent list. Set recursive: true when the subagent has descendants. '
      + 'Prefer this over deleting session files manually.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'Durable subagent session id (uuid or session-<uuid>). Get it from list_subagents.',
      },
      recursive: {
        type: 'boolean',
        description: 'Also delete every descendant of the subagent (child-first).',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const callerSessionId = callerSessionIdOf(exec)
      const targets = await collectTargets(ctx, callerSessionId, args.subagent_id, args.recursive === true, exec.signal)
      const results = []
      for (const id of targets) {
        results.push(await deleteSessionCore(ctx, id, callerSessionId))
      }
      return {
        parent_session_id: callerSessionId,
        deleted: targets,
        removed_from_ui_list: true,
        results,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'release_subagent',
    description:
      'Release (stop without deleting) one subagent session in the current session tree. '
      + 'A running continuable subagent is interrupted and its live Activation released; its transcript is kept and it can still be resumed with send_message. '
      + 'Set recursive: true to release its descendants as well.',
    parameters: {
      subagent_id: {
        type: 'string',
        required: true,
        description: 'Durable subagent session id (uuid or session-<uuid>).',
      },
      recursive: {
        type: 'boolean',
        description: 'Also release every descendant of the subagent.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    isConcurrencySafe() {
      return false
    },
    async execute(args, exec) {
      const callerSessionId = callerSessionIdOf(exec)
      const targets = await collectTargets(ctx, callerSessionId, args.subagent_id, args.recursive === true, exec.signal)
      const results = []
      for (const id of targets) {
        results.push(await releaseSession(ctx, id, exec.agent))
      }
      return {
        parent_session_id: callerSessionId,
        released: targets,
        results,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_subagents',
    description:
      'List the subagent sessions descending from the current session, including finished one-shot subagents. '
      + 'Use this to obtain the exact subagent_id to pass to delete_subagent or release_subagent.',
    parameters: {
      activity: {
        type: 'string',
        enum: ['running', 'inactive'],
        description: 'Only show subagents with this activity.',
      },
      mode: {
        type: 'string',
        enum: ['one-shot', 'continuable'],
        description: 'Only show subagents of this mode.',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    isConcurrencySafe() {
      return true
    },
    async execute(args, exec) {
      const callerSessionId = callerSessionIdOf(exec)
      const entries = await resolveDescendants(ctx, callerSessionId, exec.signal)
      return entries.filter((entry) => {
        if (args.activity !== undefined && entry.activity !== args.activity) return false
        if (args.mode !== undefined && entry.mode !== args.mode) return false
        return true
      })
    },
  }))

  const ws = ctx.get('webServer')
  if (ws !== undefined) {
    registerHttp(ws, ctx)
  } else {
    ctx.inject(['webServer'], (sub) => {
      registerHttp(sub.webServer, sub)
    })
  }

  return async () => {
    // Tool registrations are fiber-scoped; nothing extra to tear down.
  }
}

export { apply, DeleteError, deleteSessionCore, collectTargets, resolveDescendants, sessionIdVariants }
