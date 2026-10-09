# 路由与投递契约 v1（冻结）

> 冻结人：`ds`（planner）｜2026-10-09｜适用单元：U1 队列投递状态、U2 路由解析、U3 回执 nonce、U4 pull 型执行端
> 本文件是**接口正本**。四个单元的实现不得偏离；要改契约，先回退到 planner 重新冻结，不得自行扩写。

## 0. 不变量（四个单元共同遵守）

1. **队列是唯一正本**：任务的存在、状态、投递结果、验收都必须能从 `coordination/board.json` 读出来；不得只存在于某个进程的内存或某份文档里。
2. **身份是角色，会话是路由**：授权 =（规划身份 × 执行角色 × 项目根），**与 sessionId 无关**。任何实现不得把某个具体 sessionId 写成授权前提。
3. **执行端不推送**：git 提交与推送由 planner 统一执行。执行端只写自己任务单允许的文件。
4. **证据只写实测**：命令、输出、退出码、时间戳必须来自真实执行；不得预填、不得转述。

## 1. U1：队列投递状态（`tools/wsc-hub.mjs` + `tests/`）

### 1.1 状态机

```
draft → approved → dispatched → in-progress → awaiting-acceptance → accepted
                      ↘ cancelled ↙        （cancelled 可从 approved / dispatched / in-progress 进入）
```

- `STATES` 增加 `dispatched`，语义 = **已投递给执行端、执行端尚未 claim**。
- `claim` 必须同时接受 `approved` 与 `dispatched`（兼容无投递记录的直接领取）。
- 并发冲突判定把 `dispatched` 与 `in-progress` **一并视为在途**（防止重复投递）；planner 可用 `cancel` 作为卡死任务的唯一出口。

### 1.2 `task.delivery`

```json
{ "state": "sent | not-sent | uncertain | duplicate-prevented",
  "channel": "<渠道标识，如 mcc-workbuddy / qoder-visible-cli>",
  "attempts": 1, "at": "<ISO8601>", "by": "<planner身份>",
  "approvalKey": "<sha256>", "error": "<string|null>" }
```

- `not-sent` = 确定没送出去（可安全重发）；`uncertain` = 送没送到未知（**不得自动重发**）；`duplicate-prevented` = 命中 approvalKey 幂等。
- `delivery` 是**最后一次投递尝试**的记录，追加式历史仍在 `history`。

### 1.3 `task.nonce`

- 格式：`MCC-ACK-<8位小写十六进制>`。
- **只有 planner 的 `dispatch` 动作可写入**；一经写入，执行端与其他动作不得改写。

### 1.4 新增 planner 动作 `dispatch`

入参：`{ "id", "channel", "state", "error"? }`（`FIELDS.dispatch` 需登记，禁止越权覆盖身份）

- 仅 planner 可调用；仅当任务 `status === "approved"`。
- 写入/更新 `delivery`；若 `task.nonce` 缺失则生成。
- `state === "sent"` → `status` 转 `dispatched`；`not-sent` / `uncertain` → 保持 `approved`，但仍写 `delivery`。
- `history` 追加 `{ action: "dispatch", client, at, channel, state }`。

### 1.5 测试（`node --test`，零第三方依赖）

至少覆盖：`ds` 身份可 create/approve/accept；`qoder` 调 `dispatch` 被拒；`approved → dispatched → in-progress` 全链路；`not-sent` 后 `status` 仍为 `approved`；`nonce` 写入后执行端 `submit` 不能改写它；`dispatched` 与 `in-progress` 互斥判定生效；已取消任务仍能通过整表校验（回归保护）。

## 2. U2：路由解析（`tools/routing.mjs` 新增 + `tools/desktop-dispatch.mjs`）

### 2.1 路由失败分类（结构化错误码）

| 错误码 | 触发条件 | `notSent` |
|---|---|---|
| `ROUTE_UNCONFIGURED` | 无 endpoint 文件或形状非法（root/pipe/key） | true |
| `ROUTE_DEAD` | status 探测连接失败 / 超时 | true |
| `ROUTE_SESSION_MISMATCH` | `currentSessionId !== targetSessionId` | true |
| `ROUTE_UNVERIFIED` | WB 侧 `conversationVerified !== true` | true |
| `ROUTE_BUSY` | `busy === true` | **false**（可能正在跑，不许重发） |

`notSent` 语义必须与现有 `bridgeError(message, notSent)` 一致：只有确定没送出去才允许自动重发。

### 2.2 解析算法（先探测、后投递）

1. 读 `<BRIDGE_HOME>/<client>-endpoint.json`，校验形状 → 否则 `ROUTE_UNCONFIGURED`。
2. 调 `status`（沿用现有超时）→ 连接失败 `ROUTE_DEAD`；会话/会话验证不符 → 对应错误码。
3. 探测成功则把结果写入 `<BRIDGE_HOME>/<client>-presence.json`（`heartbeatAt = now`）。
4. 探测失败则把失败原因写入 presence（`state: "stale"` + `reason`），**使"通道断了"成为队列可读的事实，而不是一次含糊的连接失败**。
5. TTL（默认 15s）内的 presence 可复用，避免每次派发都探测。

### 2.3 presence 记录

```json
{ "client", "deployment", "root", "pid", "pipe", "state": "live|stale",
  "sessionTitle", "currentSessionId", "targetSessionId",
  "hostConnected", "conversationVerified", "busy", "reason", "heartbeatAt" }
```

### 2.4 planner 身份

`desktop-dispatch.mjs` **不得再硬编码 `createHub({ client: 'chatgpt' })`**；改为可由 `--as <planner身份>` 指定，默认 `ds`。

### 2.5 与 U1 的软依赖

`dispatch` 成功后应调用 hub 的 `dispatch` 动作记录投递状态。**必须特性探测**：若运行的 hub 尚不支持该动作，降级为仅写本地 dispatch 台账并明确记录降级原因，**不得因此让派发失败**。测试不得依赖 U1 已合入。

## 3. U3：回执 nonce（`tools/desktop/trae/extension.cjs`、`tools/desktop/workbuddy/server/index.cjs`）

- 投递 prompt 末尾追加固定句：`【回执】完成后必须在回复中原文包含一次性令牌 <nonce>，不得改写或省略。`
- 判据：`reply.includes(nonce)` → `matchesExpected = true`。**精确令牌匹配，禁止宽松语义匹配**（宽松匹配分不清"换了措辞的正确答案"和"听起来对的旧回复"，会毁掉防串证据）。
- 台账记录 `replyText` 原文与 `match ∈ { "nonce", "none" }`；`nonce` 缺失时明确记 `match: "not-requested"`，不得伪装成通过。

## 4. U4：pull 型执行端（`tools/pull-agent.mjs` 新增 + `tests/`）

- 用法：`node tools/pull-agent.mjs --client <qoder|trae|workbuddy> --once | --watch [--dry-run] [--transport <模块路径>]`
- 只处理 `owner === 自己` 且 `status ∈ { approved, dispatched }` 的任务；投递成功后**以自身身份** `claim`。
- **幂等**：同一 `task.id + approvalKey` 只投递一次，台账 `<BRIDGE_HOME>/pull-agent/<client>.json`。
- `--dry-run` 只打印将投递的任务，**零写入**（不发网络、不写队列、不写台账）。
- 传输层必须可注入（`--transport` 指向一个 `export async function deliver(task, ctx)` 的模块），默认传输为显式报错的占位实现——**不得**在未配置传输时静默假装成功。
- 不得 import 或修改 `desktop-dispatch.mjs` 的既有导出行为。

## 5. 文件写集（并行边界，越界即 BLOCKED）

| 单元 | 独占写集 |
|---|---|
| U1 | `tools/wsc-hub.mjs`、`tests/wsc-hub.test.mjs` |
| U2 | `tools/routing.mjs`、`tools/desktop-dispatch.mjs`、`tests/routing.test.mjs` |
| U3 | `tools/desktop/trae/extension.cjs`、`tools/desktop/workbuddy/server/index.cjs` |
| U4 | `tools/pull-agent.mjs`、`tests/pull-agent.test.mjs` |

`U3` 依赖 `U1`（读 `task.nonce`）与 `U2`（投递侧注入点），**必须等 U1、U2 交付后再开工**。
