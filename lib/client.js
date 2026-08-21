// Client bundle revision: parentId-aware removal detection (2026-08-21).
// dsh-plugin-subagent-delete — web client glue.
//
// The official subagent catalog (the header button with the descendant count)
// is driven by the client sessions runtime. Permanent deletion removes the
// durable child server-side, but the runtime keeps its cached summary until a
// session-list/subagent-catalog refresh happens. New subagents light the UI up
// through the `session/created -> host/session-added` frame path; this client
// mirrors that refresh for deletion:
//
//   * the host plugin publishes a transient child marker after every permanent
//     delete (official `sessions.prepare/enter/announce/detach` seam);
//   * this component subscribes to the sessions list store, detects the marker
//     being removed (`host/session-removed`), and refreshes both the session
//     baseline and the parent's subagent catalog.
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

    function parentIndex(snapshot) {
      var out = new Map()
      var byId = snapshot && snapshot.byId ? snapshot.byId : {}
      for (var id of Object.keys(byId)) {
        // The public sessions.list projection exposes lineage as `parentId`.
        out.set(id, byId[id].parentId)
      }
      return out
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
            if (typeof sessions.refresh === 'function') void sessions.refresh()
            if (typeof sessions.refreshSubagents === 'function') {
              for (var parentId of parentsToRefresh) {
                void sessions.refreshSubagents(parentId)
              }
            }
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

    exports.name = 'dsh-plugin-subagent-delete/client'
    exports.inject = ['slots', 'sessions']

    exports.apply = function apply(ctx) {
      var sessions = ctx.sessions
      ctx.slots.inject('conversation.session.header.actions', function () {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'subagent-delete-refresh',
          order: 100,
        }, function (props) {
          return createElement(UiSync, { sessionId: props.sessionId, sessions: sessions })
        })
      })
    }

    return module.exports
  },
})
