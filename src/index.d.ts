export const name: 'dsh-plugin-subagent-delete'
export const inject: string[]

export type SessionId = string
export type SubagentMode = 'one-shot' | 'continuable'
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
}

export interface DeleteSessionResult {
  sessionId: SessionId
  deleted: true
  stopped: boolean
  detached: boolean
  dirRemoved: boolean
  projRemoved: boolean
  workspaceRemoved: boolean
  /** True when a UI refresh marker was published after the delete. */
  refreshPulse: boolean
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

export function collectTargets(
  ctx: PluginContext,
  callerSessionId: SessionId,
  subagentId: SessionId,
  recursive?: boolean,
  signal?: AbortSignalLike,
): Promise<SubagentEntry[]>

export function deleteSessionCore(
  ctx: PluginContext,
  sessionId: SessionId,
  parentSessionId?: SessionId,
): Promise<DeleteSessionResult>

export function apply(ctx: PluginContext): (() => Promise<void> | void) | void
