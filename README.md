# dsh-plugin-subagent-delete

DeepSeek Harness (DSH) plugin that adds the missing subagent lifecycle interface:

- `delete_subagent` — permanently delete a subagent session and take it out of the web UI list
- `release_subagent` — stop / release a subagent without deleting its transcript
- `list_subagents` — list the calling session's descendant subagents (including finished one-shot subagents)

Compatible with DSH `0.1.0-rc.8`.

## Why

DSH's built-in subagent control surface only provides `send_message`, `interrupt_agent`
and `list_agents`. There is no delete/release endpoint, so finished one-shot and stale
continuable subagents keep accumulating in the web UI list. This plugin fills that gap
with an ownership-checked, model-callable tool plus optional HTTP routes.

## Install

```sh
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete
# or pin to the published release
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete#v0.2.0
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
(`one-shot` | `continuable`), `activity` (`running` | `inactive`), `depth`,
`parentId` and `hasChildren`.

### `delete_subagent`

```jsonc
delete_subagent({ subagent_id: "0fcfbdd6-5d21-46a4-bd95-2ca6edac1261" })
delete_subagent({ subagent_id: "<id>", recursive: true })
```

Permanently removes the subagent:

1. verifies the target is a descendant of the calling agent's session
   (descendant discovery uses the official `ctx.subagents.listDescendants`);
2. stops the live agent / drains a resident continuable Activation;
3. flushes and detaches the live session from `ctx.sessions`;
4. removes the on-disk session log directory (both uuid spellings);
5. removes the `session_projcache` row;
6. removes the id from workspace accounting and the archive set.

Without `recursive: true` a target that still has descendants is refused with
`has-descendants`. Deletion is child-first and permanent.

### `release_subagent`

```jsonc
release_subagent({ subagent_id: "<id>" })
release_subagent({ subagent_id: "<id>", recursive: true })
```

Stops the current turn and releases a resident continuable Activation via
`ctx.subagents.drainContinuableChildren`, but keeps the durable transcript.
The subagent remains resumable with `send_message`.

## Web UI auto-refresh

DSH has an official refresh path for subagent creation (`session/created` →
`host/session-added`) but no symmetric contract for deletion: for a durable
subagent, `host/session-removed` is treated by the client as a status change
(`running: false`) only, so the sidebar list and subagent catalog are not
refreshed.

This plugin works around that gap without patching DSH: after every permanent
delete the host publishes a short-lived marker session through the official
`prepare → enter → announce → detach` lifecycle seam, and the bundled web
client component (`lib/client.js`) watches the public `sessions.list` snapshot.
When the marker child is removed it debounces (350ms) and calls
`sessions.refresh()` plus `sessions.refreshSubagents(parentId)` for the
affected parents. Open web clients therefore update the subagent count
immediately — no manual page reload required. The marker's `_no-cwd` artifact
is swept after detach, so the refresh glue leaves no residue.

## HTTP routes (web profiles)

For client integration and local debugging the host plugin registers:

- `GET  /dsh-plugin-subagent-delete/list?parentSessionId=<id>[&activity=…][&mode=…]`
- `POST /dsh-plugin-subagent-delete/delete` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`
- `POST /dsh-plugin-subagent-delete/release` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`

HTTP callers must name the same `parentSessionId` the target descends from; the
same ownership check runs on every mutation.

## Safety

- A subagent can only be deleted by its own session-tree ancestor. Foreign or
  unknown ids return `not-your-subagent` / `not-found`.
- Running subagents are cancelled and awaited (15s quiescence bound) before
  their files are removed.
- File removal is confirmed before workspace accounting is stripped, so a
  failed delete cannot produce a half-removed row.

## Development

```sh
npm test        # node --test
npm run check   # syntax check + tests
npm run pack:dry
```

The test suite includes unit tests and an integration fixture created from ten
real one-shot test subagents (see `test/fixtures/test-subagents.json`).

## License

MIT
