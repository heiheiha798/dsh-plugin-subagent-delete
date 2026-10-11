# dsh-plugin-subagent-delete

DeepSeek Harness (DSH) plugin that adds the missing subagent lifecycle interface:

- `delete_subagent` — permanently delete a subagent session and drop it from the session list
- `release_subagent` — stop / release a subagent without deleting its transcript
- `list_subagents` — list the calling session's descendant subagents (including finished one-shot subagents)

Verified against DSH `0.2.1-alpha.2`; compatibility shims keep `0.2.0-rc.2` and
`>=0.1.0-rc.8 <0.2.0-0` working (declared range:
`>=0.1.0-rc.8 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0`).

## Why

DSH's built-in subagent control surface only provides `send_message`, `interrupt_agent`
and `list_agents`. There is no delete/release endpoint, so finished one-shot and stale
continuable subagents keep accumulating in the web UI list. This plugin fills that gap
with an ownership-checked, model-callable tool plus optional HTTP routes.

## Install

```sh
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete
# or pin to the published release
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete#v0.2.2
# or from a local checkout
dsh plugin --profile web add /path/to/dsh-plugin-subagent-delete
```

Restart the profile, then start a new session. The session gains three tools.

## Tools

### `list_subagents`

```jsonc
list_subagents({})                      // all descendants
list_subagents({ activity: "running" }) // running only
list_subagents({ mode: "one-shot" })    // one-shot only
```

Returns the caller's descendant subagent tree: `id`, `label`, `mode`
(`one-shot` | `continuable` | `external` | `unknown`), `activity`
(`running` | `inactive`), `depth`, `parentId`, `hasChildren` and `present`
(whether the durable session artifact is still stored). A child whose catalog
branch could not be read carries `unreadable`
(`corrupt` | `unsupported` | `unavailable`) and still counts as a deletable
target.

### `delete_subagent`

```jsonc
delete_subagent({ subagent_id: "0fcfbdd6-5d21-46a4-bd95-2ca6edac1261" })
delete_subagent({ subagent_id: "<id>", recursive: true })
```

Permanently removes the subagent:

1. verifies the target is a descendant of the calling agent's session
   (descendant discovery uses the official `ctx.subagents.listDescendants`,
   falling back to a persisted-header lineage walk);
2. stops the live agent / releases a resident child Activation through the
   official `ctx.subagents.drainChildren(parent, childIds)` seam, which also
   detaches the child Session from the live store;
3. flushes and (if still live) detaches the session from `ctx.sessions`;
4. removes the on-disk session log directory (both uuid spellings);
5. removes the `session_projcache` row;
6. removes the id from workspace accounting and the archive set.

Without `recursive: true` a target that still has descendants is refused with
`has-descendants`. Deletion is child-first and permanent. A target whose durable
session is already gone reports `already_absent` instead of `not-found`, so a
subtree delete never aborts half-way.

### `release_subagent`

```jsonc
release_subagent({ subagent_id: "<id>" })
release_subagent({ subagent_id: "<id>", recursive: true })
```

Stops the current turn and releases a resident child Activation via
`ctx.subagents.drainChildren(parent, childIds)`, but keeps the durable
transcript. The subagent remains resumable with `send_message`.

## Web UI auto-refresh

A permanent delete removes the durable child, but an open client keeps its
cached session list and projections until something invalidates them. This
plugin works around that gap without patching DSH: after every permanent delete
the host publishes a short-lived marker session through the official
`prepare → enter → announce → detach` lifecycle seam. The bundled web client
component (`lib/client.js`) watches the public `sessions.list` snapshot and,
when the marker child is removed (`api-session/removed`), debounces 350 ms and
calls `sessions.refresh()` plus `sessions.refreshProjections(parentId)` for the
affected parents — the current dsh face (pre-0.2.1 releases used
`sessions.refreshSubagents(parentId)` and are still supported). Open web clients
therefore drop the deleted subagent without a manual page reload. The marker's
`_no-cwd` artifact is swept after detach, so the refresh glue leaves no residue.

One honest limit: the parent Session's `subagent/catalog` facts are append-only
durable history, so a deleted child can remain a **historical row** in the
parent's header catalog dropdown until that parent log itself moves on.
Removing the fact would mean rewriting a committed session log, which dsh does
not support. The sidebar session list is refreshed normally.

## HTTP routes (web profiles)

For client integration and local debugging the host plugin registers:

- `GET  /dsh-plugin-subagent-delete/list?parentSessionId=<id>[&activity=…][&mode=…]`
- `POST /dsh-plugin-subagent-delete/delete` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`
- `POST /dsh-plugin-subagent-delete/release` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`

HTTP callers must name the same `parentSessionId` the target descends from; the
same ownership check runs on every mutation.

## Safety

- A subagent can only be deleted by its own session-tree ancestor. Foreign or
  unknown ids return `not-your-subagent`; an id whose durable session is already
  gone returns `already_absent` rather than a hard failure.
- Running subagents are cancelled and awaited (15s quiescence bound) before
  their files are removed; the timeout never leaves a pending timer behind.
- File removal is confirmed before workspace accounting is stripped, so a
  failed delete cannot produce a half-removed row.

## Development

```sh
npm test        # node --test
npm run check   # syntax check (host + client bundle) + tests
npm run verify:dsh          # contract probe against published dsh 0.2.1-alpha.2
npm run verify:dsh 0.2.2-rc.1   # ...against another published release
npm run pack:dry
```

The test suite includes unit tests and an integration fixture created from ten
real one-shot test subagents (see `test/fixtures/test-subagents.json`).

`npm run verify:dsh` installs the requested published `@deepseek-ai/dsh-*`
release into a temp directory and drives `src/index.js` through the real
`ToolRuntime` from those artifacts (registration, schema compilation, and
execution of all three tools) — use it to re-check the plugin against a new dsh
release without building the harness checkout.

## License

MIT
