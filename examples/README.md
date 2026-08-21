# Examples

The plugin is normally called by the model inside a DSH session. For local
debugging and client integration, the web-profile HTTP routes are the easiest
entry point.

## 1. List subagents

```sh
PARENT='session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
curl -s "http://127.0.0.1:3080/dsh-plugin-subagent-delete/list?parentSessionId=$PARENT" \
  | python3 -m json.tool
```

## 2. Delete one subagent

```sh
PARENT='session-95da8aa3-5611-4e59-9eee-697b6e345fd1'
SUB='34b01123-99a6-4b76-a21d-c682526e3629'
curl -s -X POST http://127.0.0.1:3080/dsh-plugin-subagent-delete/delete \
  -H 'content-type: application/json' \
  -d "{\"parentSessionId\":\"$PARENT\",\"subagentId\":\"$SUB\",\"recursive\":false}"
```

Pass `"recursive": true` to delete the target together with its descendants.

## 3. Release (stop but keep transcript)

```sh
curl -s -X POST http://127.0.0.1:3080/dsh-plugin-subagent-delete/release \
  -H 'content-type: application/json' \
  -d "{\"parentSessionId\":\"$PARENT\",\"subagentId\":\"$SUB\",\"recursive\":false}"
```

## 4. Model-facing tools

Inside a DSH session the model can call them directly:

```json
{ "name": "list_subagents", "arguments": { "activity": "inactive" } }
{ "name": "delete_subagent", "arguments": { "subagent_id": "<id>" } }
{ "name": "release_subagent", "arguments": { "subagent_id": "<id>", "recursive": false } }
```
