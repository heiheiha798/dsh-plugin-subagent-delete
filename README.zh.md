# dsh-plugin-subagent-delete

DeepSeek Harness（DSH）插件，补齐缺失的子代理生命周期接口：

- `delete_subagent` — 永久删除子代理会话，并把它从 web UI 列表中移除
- `release_subagent` — 停止 / 释放子代理，但保留其对话记录
- `list_subagents` — 列出当前会话的全部后代子代理（包括已结束的一次性子代理）

兼容 DSH `0.1.0-rc.8`。

## 为什么需要它

DSH 内置的子代理控制面只有 `send_message`、`interrupt_agent` 和 `list_agents`，
没有删除 / 释放接口。已结束的一次性子代理和不再使用的可续接子代理会一直堆积在
web UI 列表中。本插件补上这个缺口，提供带归属校验的、模型可调用的工具，以及可选的
HTTP 路由。

## 安装

```sh
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete
# 或从本地目录安装
dsh plugin --profile web add /path/to/dsh-plugin-subagent-delete
```

重启 profile，然后开始一个新会话。会话会获得三个工具。

## 工具

### `list_subagents`

```jsonc
list_subagents({})                      // 所有后代
list_subagents({ activity: "running" }) // 仅运行中的
list_subagents({ mode: "one-shot" })    // 仅一次性子代理
```

返回调用者的后代子代理树：`id`、`label`、`mode`（`one-shot` | `continuable`）、
`activity`（`running` | `inactive`）、`depth`、`parentId` 和 `hasChildren`。

### `delete_subagent`

```jsonc
delete_subagent({ subagent_id: "0fcfbdd6-5d21-46a4-bd95-2ca6edac1261" })
delete_subagent({ subagent_id: "<id>", recursive: true })
```

永久删除子代理：

1. 校验目标是调用代理会话的后代（后代发现使用官方 `ctx.subagents.listDescendants`）；
2. 停止存活代理 / 排空驻留的 continuable Activation；
3. 从 `ctx.sessions` flush 并 detach 存活会话；
4. 删除磁盘上的会话日志目录（两种 uuid 写法都会处理）；
5. 删除 `session_projcache` 行；
6. 从 workspace 记账和归档集合中移除该 id。

没有传 `recursive: true` 时，如果目标仍有后代，会以 `has-descendants` 拒绝。
删除按子节点优先执行，且是永久性的。

### `release_subagent`

```jsonc
release_subagent({ subagent_id: "<id>" })
release_subagent({ subagent_id: "<id>", recursive: true })
```

停止当前回合，并通过 `ctx.subagents.drainContinuableChildren` 释放驻留的
continuable Activation，但保留持久化记录。之后仍可用 `send_message` 恢复。

## web UI 自动刷新

DSH 官方对「新建子代理」有完整的 web 刷新链路（`session/created` →
`host/session-added`），但删除没有对称语义：`host/session-removed` 对持久子代理
只被当作「运行状态变为 false」，不会刷新会话列表或子代理目录。因此本插件在每次
永久删除后，通过官方生命周期接口（`prepare → enter → announce → detach`）发布一个
短生命周期的 marker 会话；随包发布的 web client 组件监听 `sessions.list`，
在 marker 被移除时对父会话列表和子代理目录做一次 350ms 防抖刷新。删除后打开的
web UI 会自动更新计数，无需刷新页面。

## HTTP 路由（web profile）

用于客户端集成和本地调试，host 插件会注册：

- `GET  /dsh-plugin-subagent-delete/list?parentSessionId=<id>[&activity=…][&mode=…]`
- `POST /dsh-plugin-subagent-delete/delete` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`
- `POST /dsh-plugin-subagent-delete/release` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`

HTTP 调用方必须提供目标实际所属的 `parentSessionId`；每次变更都会执行相同的归属校验。

## 安全

- 子代理只能被它自己的会话树祖先删除。外部或未知 id 会返回 `not-your-subagent` / `not-found`。
- 运行中的子代理会先被取消并等待（15 秒静默上界），然后才删除其文件。
- 文件删除会先确认成功，之后才清理 workspace 记账，失败的删除不会留下半清理的状态。

## 开发

```sh
npm test       # node --test
npm run check  # 语法检查 + 测试
npm run pack:dry
```

测试套件包含单元测试，以及从十个真实一次性测试子代理生成的集成 fixture
（见 `test/fixtures/test-subagents.json`）。

## License

MIT
