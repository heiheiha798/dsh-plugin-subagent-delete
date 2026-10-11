// Client bundle revision: projection-aware refresh for dsh 0.2.1 (2026-10-11).
// dsh-plugin-subagent-delete — web client glue.
//
// Permanent deletion removes the durable child session server-side, but an
// open client keeps its cached Session list and projection reads until
// something invalidates them. New subagents light the UI up through the
// `session/created -> api-session/added` frame path; this client mirrors that
// refresh for deletion:
//
//   * the host plugin publishes a transient child marker after every permanent
//     delete (official `sessions.prepare/enter/announce/detach` seam);
//   * this component subscribes to the sessions list snapshot, detects the
//     marker being removed (`api-session/removed`), and asks the sessions
//     service to reload the Host list and the parent's projection reads.
//
// Refresh uses the current public face: `sessions.refresh()` plus
// `sessions.refreshProjections(parentId)` (dsh >= 0.2.1). Older releases that
// spell the catalog reload `sessions.refreshSubagents(parentId)` are still
// supported. The parent Session's durable `subagent/catalog` facts are
// append-only, so a deleted child can remain a historical row in the header
// catalog dropdown until that parent log itself moves on; the sidebar Session
// list drops it as soon as this refresh lands.
//
// The component itself renders nothing: it is a lifecycle-only slot
// contribution mounted in the conversation header actions.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-subagent-delete',
  factory: (require) => {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports

    var react = require('react')
    var createElement = react.createElement
    var useEffect = react.useEffect
    var useRef = react.useRef

    var REFRESH_DEBOUNCE_MS = 350

    // The apply()-owned sessions service; one client instance per page.
    var sessionsService = null

    function parentIndex(snapshot) {
      var out = new Map()
      var byId = snapshot && snapshot.byId ? snapshot.byId : {}
      for (var id of Object.keys(byId)) {
        // The public sessions.list projection exposes lineage as `parentId`.
        out.set(id, byId[id].parentId)
      }
      return out
    }

    /** Reload the Host list and the parent's projections on the current face. */
    function refreshParents(sessions, parentsToRefresh) {
      if (typeof sessions.refresh === 'function') void sessions.refresh()
      if (typeof sessions.refreshProjections === 'function') {
        for (var parentId of parentsToRefresh) void sessions.refreshProjections(parentId)
        return
      }
      // dsh < 0.2.1 exposed the subagent-catalog reload under this name.
      if (typeof sessions.refreshSubagents === 'function') {
        for (var legacyParentId of parentsToRefresh) void sessions.refreshSubagents(legacyParentId)
      }
    }

    function UiSync(props) {
      var sessions = props.sessions
      var sessionId = props.sessionId

      var parentRef = useRef(sessionId)
      parentRef.current = sessionId
      var previousRef = useRef(null)
      var timerRef = useRef(null)

      useEffect(function () {
        var list = sessions && sessions.list
        if (!list || typeof list.subscribe !== 'function') return undefined

        previousRef.current = parentIndex(list.getSnapshot())

        var schedule = function (parents) {
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(function () {
            timerRef.current = null
            var parentsToRefresh = parents
            if (parentRef.current !== undefined && parentRef.current !== null) {
              parentsToRefresh = new Set(parentsToRefresh)
              parentsToRefresh.add(parentRef.current)
            }
            refreshParents(sessions, parentsToRefresh)
          }, REFRESH_DEBOUNCE_MS)
        }

        var dispose = list.subscribe(function () {
          var snapshot = list.getSnapshot()
          var previous = previousRef.current
          previousRef.current = parentIndex(snapshot)
          if (!previous) return

          var parents = new Set()
          for (var entry of previous) {
            var id = entry[0]
            var parentId = entry[1]
            if (parentId === undefined || parentId === null) continue
            if (snapshot.byId[id] === undefined) parents.add(parentId)
          }
          if (parents.size > 0) schedule(parents)
        })

        return function () {
          dispose()
          if (timerRef.current !== null) clearTimeout(timerRef.current)
        }
      }, [sessions])

      return null
    }

    /** Stable slot component: the registration identity must not churn. */
    function HeaderSlot(props) {
      return createElement(UiSync, { sessionId: props.sessionId, sessions: sessionsService })
    }

    exports.name = 'dsh-plugin-subagent-delete/client'
    exports.inject = ['slots', 'sessions']

    exports.apply = function apply(ctx) {
      sessionsService = ctx.sessions
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'subagent-delete-refresh',
          order: 100,
        }, HeaderSlot)
      })
    }

    return module.exports
  },
})
