export const name: 'dsh-plugin-subagent-delete'
export const inject: string[]

export type SessionId = string
export type SubagentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'
export type SubagentActivity = 'running' | 'inactive'

export interface SubagentEntry {
  kind: 'child'
  id: SessionId
  label: string
  mode: SubagentMode
  activity: SubagentActivity
  hasChildren: boolean
  parentId?: SessionId
  depth: number
  /** Set when dsh reported an unreadable or unsupported branch for this child. */
  unreadable?: 'corrupt' | 'unsupported' | 'unavailable'
  /** True while the durable session artifact is still stored (listing results only). */
  present?: boolean
}

export interface DeleteSessionResult {
  sessionId: SessionId
  /** True when this call removed durable state or a live entry. */
  deleted: boolean
  /** True when nothing was left to remove (already deleted / never stored). */
  alreadyAbsent: boolean
  stopped: boolean
  /** True when the official child-Activation release seam handled the target. */
  drained: boolean
  detached: boolean
  dirRemoved: boolean
  projRemoved: boolean
  workspaceRemoved: boolean
  /** True when a UI refresh marker was published after the delete. */
  refreshPulse: boolean
}

export interface DeleteSessionOptions {
  /** Report an already-absent target instead of failing with not-found. */
  missingOk?: boolean
  /** Exact live direct parent Agent authorizing the child release. */
  parentAgent?: unknown
}

export interface ReleaseSessionResult {
  sessionId: SessionId
  released: true
  drained: boolean
  stopped: boolean
}

export class DeleteError extends Error {
  status: number
  code: string
  constructor(message: string, status?: number, code?: string)
}

export interface PluginContext {
  get<T>(name: string): T
  inject?<T>(name: string[], callback: (ctx: T) => void): void
  [key: string]: unknown
}

export interface AbortSignalLike {
  aborted?: boolean
  addEventListener?(type: string, listener: () => void): void
  removeEventListener?(type: string, listener: () => void): void
}

export function sessionIdVariants(sessionId: SessionId): SessionId[]

export function resolveDescendants(
  ctx: PluginContext,
  rootId: SessionId,
  signal?: AbortSignalLike,
): Promise<SubagentEntry[]>

export function collectTargetEntries(
  ctx: PluginContext,
  callerSessionId: SessionId,
  subagentId: SessionId,
  recursive?: boolean,
  signal?: AbortSignalLike,
): Promise<SubagentEntry[]>

export function collectTargets(
  ctx: PluginContext,
  callerSessionId: SessionId,
  subagentId: SessionId,
  recursive?: boolean,
  signal?: AbortSignalLike,
): Promise<SessionId[]>

export function deleteSessionCore(
  ctx: PluginContext,
  sessionId: SessionId,
  parentSessionId?: SessionId,
  options?: DeleteSessionOptions,
): Promise<DeleteSessionResult>

export function apply(ctx: PluginContext): (() => Promise<void> | void) | void
