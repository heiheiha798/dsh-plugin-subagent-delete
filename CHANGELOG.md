# Changelog

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
