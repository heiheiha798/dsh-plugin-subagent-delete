# Changelog

## 0.2.3 — 2026-10-22

### Fixed

- `delete_subagent` on a Team session now also dismisses the target from the
  caller's durable Team roster (`ctx.agentTeams.dismissTeammate`, Lead only).
  A teammate is a durable `team/member` fact in the Lead's Session log and the
  Team UI renders exactly the non-dismissed roster, so deleting only the child
  Session left the teammate listed as active and the delete looked like a
  no-op. Each deleted row now reports `dismissed`; it stays `false` when the
  target is not a roster member, the caller is not the Lead, or the
  composition mounts no Team service.

### Changed

- `list_subagents` omits catalog children whose durable session was already
  permanently deleted, so a finished cleanup reads back as an empty list
  instead of rows that all report `present: false`. Pass
  `include_absent: true` to see them. The HTTP list route keeps returning
  every catalog row with its `present` flag.

## 0.2.2 — 2026-10-11

Compatibility with dsh `0.2.1-alpha.2` (managed subagent activations).

### Added

- `npm run verify:dsh [version]` — a repeatable contract probe that installs
  the requested published `@deepseek-ai/dsh-*` release into a temp directory and
  drives `src/index.js` through that release's real `ToolRuntime`: tool
  registration, schema compilation, and `list_subagents` / `delete_subagent` /
  `release_subagent` execution, including the exact-parent release call and the
  ownership refusal. Verified green against `0.2.1-alpha.2`.

### Changed

- Release/teardown now uses the current `ctx.subagents.drainChildren(parent,
  childIds)` seam, resolving each target's own live direct parent instead of
  assuming the caller is the direct parent. The pre-0.2.1
  `drainContinuableChildren` spelling is still used when the composition
  exposes only that one.
- Descendant discovery falls back to the persisted-header lineage walk when
  `ctx.subagents.listDescendants()` rejects with
  `SUBAGENT_CONTROL_*_UNAVAILABLE` (session query or catalog projection not
  composed); cancellation is forwarded instead of falling back.
- `listDescendants` rows are normalized for the current contract: `diagnostic`
  rows surface as `mode: "unknown"` with `unreadable: corrupt | unsupported |
  unavailable`, `mode` accepts `external | unknown`, and every listing row
  now reports `present` (the durable session artifact still exists).
- `deleteSessionCore` is idempotent: a catalog child whose durable session is
  already gone reports `deleted: false, alreadyAbsent: true` instead of
  failing with `not-found`, so recursive deletes no longer abort mid-subtree.
  `delete_subagent` returns `deleted` and `already_absent` id lists.
- The web client glue refreshes through `sessions.refreshProjections(parentId)`
  (current face) and keeps `sessions.refreshSubagents(parentId)` as the
  pre-0.2.1 fallback; `session/disposed` is delivered to clients as
  `api-session/removed` in current dsh.
- Teardown timeouts no longer leave a 15 s timer behind, so a delete/release
  call cannot keep the host event loop alive after it settles.
- `peerDependencies` widened to `>=0.1.0-rc.8 <0.2.0-0 || >=0.2.0-rc.2
  <0.3.0-0`.

### Known limitation

- The parent Session's `subagent/catalog` facts dsh emits at child creation are
  append-only durable history: a permanently deleted child is dropped from the
  sidebar session list after the refresh, but can remain a historical row in
  the parent's header catalog dropdown. Removing that fact would require
  rewriting the parent's committed session log, which dsh does not support.

## 0.2.1 — 2026-09-12

### Fixed

- Compatibility with dsh 0.1.5-rc: `sessionPersistence.list()` now returns
  `SessionPersistenceSnapshot` rows that wrap the `SessionHeader` in `.header`.
  The lineage-walk fallback (`resolveDescendants`) and `findHeader` normalize
  both the wrapped and the legacy flat shape, so descendant discovery and
  ownership checks keep working against current dsh.
- `dsh.client.inject` no longer names `@deepseek-ai/dsh-client-runtime`
  (removed from dsh on 2026-08-22 when Client ownership moved into the Session
  Controller) nor the baseline-implicit `ui-slots`. It now declares the actual
  providers: `@deepseek-ai/dsh-api-session-controller` (client `sessions`
  service) and `@deepseek-ai/dsh-client-ui-conversation` (conversation slot
  domain).

## 0.2.0 — 2026-08-21

### Added

- Web client bundle (`lib/client.js`) that keeps the web UI subagent list and
  catalog in sync after a permanent delete. Open clients update the subagent
  count automatically, with no manual page reload.
- Official session-lifecycle marker (`prepare → enter → announce → detach`) so
  a delete publishes the same class of `host/session-added` /
  `host/session-removed` frames the client uses for subagent creation.
- `src/index.d.ts` type declarations for the public host entrypoint.
- Chinese README (`README.zh.md`), `CHANGELOG.md`, `SECURITY.md`, CI workflow,
  and awesome-dsh-plugin market submission metadata.

### Fixed

- Web UI no longer keeps showing deleted subagents. The client detector now
  reads the public snapshot field `byId[id].parentId` (not the host-frame field
  `parentSessionId`) and the removal marker stays announced long enough for a
  client notifier flush before detaching.
- Marker `_no-cwd` artifacts are materialized with `sessions.flush(marker)`
  before detach and swept with bounded polling, so refresh glue leaves no
  session-directory residue.

## 0.1.0 — 2026-08-21

### Added

- `delete_subagent` tool: ownership-checked, child-first permanent deletion of
  subagent sessions, including disk logs, projection rows, and workspace
  accounting.
- `release_subagent` tool: stop a turn and drain a resident continuable child
  while keeping its durable transcript.
- `list_subagents` tool: list all descendant subagents, including finished
  one-shot children.
- Host HTTP routes for web-profile integration:
  `/dsh-plugin-subagent-delete/list|delete|release`.
