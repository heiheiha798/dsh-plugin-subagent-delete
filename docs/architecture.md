# Architecture: web UI refresh after delete

DSH ships a refresh path for subagent **creation** but not for permanent
**deletion**. This plugin bridges that gap without patching DSH.

## Creation path (official)

1. A subagent session is prepared and announced through `SessionStore`.
2. `session/created` is emitted and the host API proxy broadcasts
   `host/session-added` with `origin: "subagent"` and `parentSessionId`.
3. The web client marks the parent's catalog expandable and schedules a
   catalog refresh when the parent session is selected.

## Deletion path (this plugin)

1. `deleteSessionCore()` removes the durable child from disk, the
   `session_projcache` row, and workspace accounting.
2. `emitRemovalMarker()` publishes a transient marker session through the
   official seam:

   ```
   sessions.prepare(markerId, { meta: { parentSession: parentSessionId } })
   sessions.enter(marker)
   sessions.announce(marker)            // -> host/session-added
   await sessions.flush(marker)         // materialize the _no-cwd artifact
   await delay(250ms)                   // cross one client notifier flush
   detach()                             // -> host/session-removed
   sweepMarkerDirs(markerId)            // leave no residue
   ```

3. The bundled client component (`lib/client.js`) subscribes to the public
   `sessions.list` snapshot, tracks `byId[id].parentId`, and detects the
   marker removal.
4. It debounces 350ms, then calls `sessions.refresh()` for the session
   baseline and `sessions.refreshSubagents(parentId)` for the affected
   parents plus the currently selected session.

The 250ms host delay and 350ms client debounce are deliberately small: the
marker blinks for far less than a second in the sidebar, while the catalog
refresh happens after the disposal frame has settled.

## Key field mapping

| Wire frame (`host/session-added`) | Public list snapshot |
| --- | --- |
| `parentSessionId` | `byId[id].parentId` |
| `origin` | `byId[id].origin` |
