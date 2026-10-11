# Architecture: web UI refresh after delete

DSH ships a refresh path for subagent **creation** but not for permanent
**deletion**. This plugin bridges that gap without patching DSH.

## Creation path (official)

1. A subagent session is prepared and announced through `SessionStore`.
2. `session/created` is emitted and the session controller broadcasts
   `api-session/added` with `origin: "subagent"` and its parent lineage.
3. The parent Session also durably appends a `subagent/catalog` fact, which the
   `subagentCatalog` projection serves to the web client.

## Deletion path (this plugin)

1. `deleteSessionCore()` releases the resident child Activation
   (`ctx.subagents.drainChildren(parent, childIds)`, which detaches the child
   Session from the live store), removes the durable child from disk, the
   `session_projcache` row, and workspace accounting.
2. `emitRemovalMarker()` publishes a transient marker session through the
   official seam:

   ```
   sessions.prepare(markerId, { meta: { parentSession: parentSessionId } })
   sessions.enter(marker)
   sessions.announce(marker)            // -> api-session/added
   await sessions.flush(marker)         // materialize the _no-cwd artifact
   await delay(250ms)                   // cross one client notifier flush
   detach()                             // -> session/disposed -> api-session/removed
   sweepMarkerDirs(markerId)            // leave no residue
   ```

3. The bundled client component (`lib/client.js`) subscribes to the public
   `sessions.list` snapshot, tracks `byId[id].parentId`, and detects the
   marker removal.
4. It debounces 350ms, then calls `sessions.refresh()` for the session
   baseline and `sessions.refreshProjections(parentId)` for the affected
   parents plus the currently selected session (pre-0.2.1 releases:
   `sessions.refreshSubagents(parentId)`).

The 250ms host delay and 350ms client debounce are deliberately small: the
marker blinks for far less than a second in the sidebar, while the refresh
happens after the disposal frame has settled.

## Durable catalog boundary

`subagent/catalog` events are append-only facts in the **parent** Session log.
A permanent delete removes the child's own artifacts, so the sidebar row and
any projection read for that child disappear — but the parent's catalog row is
not retractable without rewriting a committed Session log, which DSH forbids.
The header catalog dropdown can therefore keep showing a historical row for a
deleted child.

## Key field mapping

| Wire frame (`api-session/added`) | Public list snapshot |
| --- | --- |
| parent session field | `byId[id].parentId` |
| `origin: "subagent"` | `byId[id].origin` |
