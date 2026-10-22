# dsh-plugin-subagent-delete

DeepSeek Harness（DSH）插件，补齐缺失的子代理生命周期接口：

- `delete_subagent` — 永久删除子代理会话，并把它从会话列表中移除
- `release_subagent` — 停止 / 释放子代理，但保留其对话记录
- `list_subagents` — 列出当前会话的全部后代子代理（包括已结束的一次性子代理）

已在 DSH `0.2.1-alpha.2` 上验证；同时保留 `0.2.0-rc.2` 与
`>=0.1.0-rc.8 <0.2.0-0` 的兼容分支（声明范围：
`>=0.1.0-rc.8 <0.2.0-0 || >=0.2.0-rc.2 <0.3.0-0`）。

## 为什么需要它

DSH 内置的子代理控制面只有 `send_message`、`interrupt_agent` 和 `list_agents`，
没有删除 / 释放接口。已结束的一次性子代理和不再使用的可续接子代理会一直堆积在
web UI 列表中。本插件补上这个缺口，提供带归属校验的、模型可调用的工具，以及可选的
HTTP 路由。

## 安装

```sh
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete
# 或固定到已发布版本
dsh plugin --profile web add github:heiheiha798/dsh-plugin-subagent-delete#v0.2.3
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

返回调用者的后代子代理树：`id`、`label`、`mode`（`one-shot` | `continuable` |
`external` | `unknown`）、`activity`（`running` | `inactive`）、`depth`、
`parentId`、`hasChildren`，以及 `present`（持久化会话文件是否仍存在）。若某个子代理的
目录分支读取失败，会带上 `unreadable`（`corrupt` | `unsupported` |
`unavailable`），它仍然是可以删除的目标。持久化会话已被永久删除的目录子项默认不再
列出；传 `include_absent: true` 可以查看它们（其 `present` 为 `false`）。

### `delete_subagent`

```jsonc
delete_subagent({ subagent_id: "0fcfbdd6-5d21-46a4-bd95-2ca6edac1261" })
delete_subagent({ subagent_id: "<id>", recursive: true })
```

永久删除子代理：

1. 校验目标是调用代理会话的后代（后代发现使用官方 `ctx.subagents.listDescendants`，
   失败时回退到持久化 header 的血缘遍历）；
2. 若目标是 Team 成员且调用方是 Team Lead，先通过官方
   `ctx.agentTeams.dismissTeammate` 把它从持久化花名册中移除，Team 面板才会真正
   不再列出该成员；
3. 停止存活代理 / 通过官方 `ctx.subagents.drainChildren(parent, childIds)` 释放驻留的
   子 Activation（同时把子会话从 live store 中解绑）；
4. 如仍存活，则从 `ctx.sessions` flush 并 detach 该会话；
5. 删除磁盘上的会话日志目录（两种 uuid 写法都会处理）；
6. 删除 `session_projcache` 行；
7. 从 workspace 记账和归档集合中移除该 id。

没有传 `recursive: true` 时，如果目标仍有后代，会以 `has-descendants` 拒绝。
删除按子节点优先执行，且是永久性的。若目标的持久化会话已不存在，会返回
`already_absent` 而不是报错，因此递归删除不会中途失败。每条删除结果都带
`dismissed`：目标不是花名册成员、调用方不是 Lead、或未组合 Team 服务时为 `false`。

### `release_subagent`

```jsonc
release_subagent({ subagent_id: "<id>" })
release_subagent({ subagent_id: "<id>", recursive: true })
```

停止当前回合，并通过 `ctx.subagents.drainChildren(parent, childIds)` 释放驻留的子
Activation，但保留持久化记录。之后仍可用 `send_message` 恢复。

## web UI 自动刷新

永久删除会移除持久化子会话，但已打开的客户端仍会持有缓存的会话列表与投影。本插件
在不修改 DSH 的前提下弥合这个缺口：每次永久删除后，host 通过官方生命周期接口
（`prepare → enter → announce → detach`）发布一个短生命周期的 marker 会话；
随包发布的 web client 组件监听 `sessions.list`，在 marker 子会话被移除
（`api-session/removed`）时做 350ms 防抖，然后调用 `sessions.refresh()` 与
`sessions.refreshProjections(parentId)`（当前 dsh 的接口；0.2.1 之前使用
`sessions.refreshSubagents(parentId)`，仍受支持）。因此删除后无需手动刷新页面，
列表会自动更新。marker 的 `_no-cwd` 文件会在 detach 后清扫，不留残留。

Team 会话还会把该成员从 Team 面板中移除：成员身份是持久化的 `team/member` 事实，
`delete_subagent` 会先通过官方的 Lead 专属 dismiss 终止它，再删除会话。

一个仍然存在的限制：父会话的 `subagent/catalog` 事实是只追加的持久历史，所以被删除
的子代理可能仍会作为**历史条目**出现在父会话头部的子代理目录下拉框中，直到父会话日志
本身发生迁移。要移除该事实需要重写已提交的会话日志，DSH 并不支持。侧边栏会话列表会
正常刷新。

## HTTP 路由（web profile）

用于客户端集成和本地调试，host 插件会注册：

- `GET  /dsh-plugin-subagent-delete/list?parentSessionId=<id>[&activity=…][&mode=…]`
- `POST /dsh-plugin-subagent-delete/delete` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`
- `POST /dsh-plugin-subagent-delete/release` `{ "parentSessionId": "<id>", "subagentId": "<id>", "recursive": false }`

HTTP 调用方必须提供目标实际所属的 `parentSessionId`；每次变更都会执行相同的归属校验。

## 安全

- 子代理只能被它自己的会话树祖先删除。外部或未知 id 会返回 `not-your-subagent`；
  持久化会话已不存在的 id 会返回 `already_absent`，而不是硬失败。
- 运行中的子代理会先被取消并等待（15 秒静默上界），然后才删除其文件；超时不会遗留
  未清理的定时器。
- 文件删除会先确认成功，之后才清理 workspace 记账，失败的删除不会留下半清理的状态。

## 开发

```sh
npm test       # node --test
npm run check  # 语法检查（host + client bundle）+ 测试
npm run verify:dsh              # 针对已发布的 dsh 0.2.1-alpha.2 做契约探测
npm run verify:dsh 0.2.2-rc.1   # ……针对其他已发布版本
npm run pack:dry
```

测试套件包含单元测试，以及从十个真实一次性测试子代理生成的集成 fixture
（见 `test/fixtures/test-subagents.json`）。

`npm run verify:dsh` 会把指定版本的已发布 `@deepseek-ai/dsh-*` 安装到临时目录，
并用这些产物里的真实 `ToolRuntime` 驱动 `src/index.js`（注册、schema 编译、三个工具
的实际执行）。要针对新的 dsh 版本复检插件时用它即可，不需要先构建 harness 检出。

## License

MIT
