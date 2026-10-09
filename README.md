# multi-cli-coordination

**让多个 CLI / AI Agent（ChatGPT、Codex、Claude、TRAE、WorkBuddy、qoder……）围绕同一个项目安全协作的工具包**：一个共享任务队列 + 一个把任务推进到目标会话的桌面桥 + 一个 Ekko 会话通道。纯 Node 内置模块，零第三方依赖。

> 从真实游戏项目（WASTELAND CHOICE）的多 Agent 生产协作中抽出，已在 Windows 本机长期运行。

## 它解决什么问题

多个 AI CLI 各自是一个"黑盒对话"：互相看不见、没有共享状态、没有验收流程。本工具包把协作拆成三层：

```
调用方 planner(ChatGPT/Codex) ──create/approve──▶ coordination/board.json（共享队列正本）
                                                    ▲                 │
                     claim/submit（MCP 或 CLI）     │                 ▼ dispatch（桥，可选）
被调用方 executor(TRAE/WorkBuddy/qoder) ────────────┘      desktop-bridge ──▶ 桌面扩展宿主
                                                            (named pipe+key)      │ runPrompt
                                                                                ▼
                                                                  目标会话收到任务 prompt 并执行
```

- **被调用的对话不需要暴露任何远程接口**——它只需要：① 能收到一条 prompt（桥注入），② 能读写本机队列文件。
- 两端"配对"的实质 = 双方用**同一个身份名**操作**同一个队列正本**；桥只是把"队列里有活"变成"目标会话收到通知"。

## 快速开始（一键配对自检）

```bash
node tools/coordination/pair.mjs --client <你的身份名>
```

一条命令完成：判定身份是否注册 → 队列连通自检 → **生成可直接粘贴的 MCP 配置片段** → 打印该角色的下一步操作模板。未注册身份给出精确的注册指引并以退出码 2 结束。

新身份两步注册：
1. `tools/coordination/wsc-hub.mjs` 顶部 `ROLES` 表加一行：`<name>: 'executor',`（规划方写 `'planner'`）；
2. `coordination/clients.json` 的 `clients` 下加一条：`"<name>": { "role": "executor", "root": "<项目根>" }`。

## 目录约定（部署到你的项目时保持此结构）

```
your-project/
├─ coordination/           # 队列正本 board.json（运行时生成；建议 .gitignore 掉真实任务数据）
├─ tools/coordination/     # 本工具包（wsc-hub.mjs 按自身位置向上两级推导项目根）
└─ …
```

## 两种角色

| 角色 | 动作 | 典型身份 |
|---|---|---|
| **planner** | `list / get / create / approve / renew / cancel / accept / return` | ChatGPT、Codex |
| **executor** | `list / get / claim / submit` | TRAE、WorkBuddy、qoder、Claude Code |

身份在启动时由 `--client` 参数（优先）或 `WSC_CLIENT` 环境变量钉死，调用参数不能指定另一身份——这是协作隔离的关键。

## 调用方（planner）操作手册

```bash
# 1) 建任务（draft，不会被执行；owner 必须是执行端身份）
node tools/coordination/wsc-hub.mjs --client chatgpt create '{
  "id": "TEST-20261009-001",
  "title": "任务标题",
  "requirements": "做什么、约束（含禁改范围）",
  "acceptance": ["可验收条件 1", "可验收条件 2"],
  "allowedPaths": ["docs/"],          # 执行端唯一可写白名单，会被校验
  "owner": "workbuddy"
}'
# 2) 批准放行（approved 后执行端才可见可领）
node tools/coordination/wsc-hub.mjs --client chatgpt approve '{"id":"TEST-20261009-001"}'
# 3)（可选）推进到目标桌面会话
node tools/coordination/desktop-dispatch.mjs dispatch TEST-20261009-001
# 4) 执行端 submit 后验收
node tools/coordination/wsc-hub.mjs --client chatgpt accept '{"id":"TEST-20261009-001","note":"验收说明"}'
#    或退回重做：… return '{"id":"…","note":"退回原因"}'
```

## 被调用方（executor）操作手册

```bash
# 0) 挂载 MCP（pair.mjs 生成的配置），或直接用 CLI：
node tools/coordination/wsc-hub.mjs --client workbuddy list     # 先核对 client/role/root 三字段
# 1) 领取（只能领 owner===自己 且 status=approved 的任务）
node tools/coordination/wsc-hub.mjs --client workbuddy claim '{"id":"TEST-20261009-001"}'
# 2) 执行（只写 allowedPaths 白名单内文件；不 commit/push 除非任务明确授权）
# 3) 交付（非空摘要 + 可复查证据如 SHA256；→ awaiting-acceptance 后 STOP 等验收）
node tools/coordination/wsc-hub.mjs --client workbuddy submit '{"id":"TEST-20261009-001","summary":"…","evidence":["SHA256=…"]}'
```

MCP 形态（任何支持 MCP 的客户端）：`command = node`，`args = ["<仓库根>/tools/coordination/wsc-hub.mjs", "--client", "<身份>", "mcp"]`，`cwd = <仓库根>`。工具面与 CLI 完全等价。

## 桌面桥（可选深用：把任务直接推进到某个会话）

- 安装：`powershell tools/coordination/desktop/install.ps1 -Client workbuddy`（或 `trae`）。扩展由桌面客户端的扩展宿主 fork `desktop/<client>/server/`（WorkBuddy）或以 vsix（TRAE）加载。
- 会话绑定：扩展内 `CONVERSATION_ID`/`CONVERSATION_TITLE` 常量决定目标会话；派发前校验该会话 `space.cwd === 项目根`，不符即拒发（不静默新建会话）。
- 防重放：dispatch 携带 approval revision = `sha256(任务ID + 最近一次 approve/return 时间戳)`。
- 排查：`node tools/coordination/desktop-dispatch.mjs status workbuddy`。
- ⚠️ 已知坑：扩展被安装到仓库外时，**不要用"相对层级推导项目根"**（层级不同会解析出错误根，导致所有校验永假）——用环境变量注入或分发时落配置文件。

## Ekko 会话通道（可选深用）

Ekko 控制面（`start-ekko.ps1` 启动，127.0.0.1:8648）承载 Ekko 内 agent 会话：

- `ekko-mcp.mjs`：认证 wrapper（读 `~/.local/share/wsc-hub/ekko-state/wsc-login.json` 自动登录换 JWT，再加载官方 ekko-studio-mcp）。
- 直连 API：`POST /api/auth/login` 换 JWT → `POST /api/studio/chat-run/runs`（`{input, session_id?}`）。
- 坑：`/api/studio/*` 只认登录 JWT（静态 token 全 401）；登录限流 10 次失败锁 60 分钟且状态持久化（`.login-lock.json`，须清锁+重启）；内置 hermes runtime 缺失时报 "Hermes Runtime is unavailable"（外部 CLI agent 改走 `/api/coding-agents/{id}/runs` 两步）。

## 队列状态机

```
draft ──approve──▶ approved ──claim──▶ in-progress ──submit──▶ awaiting-acceptance ──accept──▶ accepted
   ▲                  ▲    ▲                │ cancel(隔离/取消)          │
   │                  │    └────────────────┘                          └── return ──▶ approved（重新 claim）
   └─ create          └── renew（运输任务恢复，须核对原批准/原领取时间戳）
```

## 安全与红线（所有接入方必读）

1. 队列正本 `coordination/board.json` 含你们的真实任务内容——**决定是否提交进 git**；本仓库 `.gitignore` 默认排除它，首次运行自动生成。
2. 凭据（Ekko 登录、桥 key）只存用户目录 `.local/share/wsc-hub/`，绝不进仓库。
3. 身份钉死不可参数化切换；执行端只动 `allowedPaths`；submit ≠ 放行（质量验收与主线裁决是独立环节）。
4. submit 证据只写实测观察，时间戳来自真实工具返回——**绝不预填未发生的事件**。
5. 并行开发用独立 git worktree（`worktree-manager.mjs`）。

## 文件清单

| 文件 | 职责 |
|---|---|
| `wsc-hub.mjs` | 队列中枢（~234 行，Node 内置模块零依赖）：stdio MCP server 与 CLI 双形态，身份钉死、状态机、互斥 |
| `pair.mjs` | 一键配对自检：身份判定 → MCP 配置片段 → 连通自检 → 角色操作模板 |
| `desktop-dispatch.mjs` | 把已批准任务经桥派发到桌面会话（status/dispatch/recover） |
| `desktop/install.ps1` | 桥扩展安装入口（-Client workbuddy\|trae） |
| `desktop/workbuddy/` | WorkBuddy 桌面桥扩展（v0.2.1：pipe + key，conversations.get/runPrompt） |
| `desktop/trae/` | TRAE (VS Code 系) 桌面桥扩展（v0.2.2，部署配置动态解析根） |
| `ekko-mcp.mjs` | Ekko 通道认证 wrapper |
| `start-ekko.ps1` | Ekko 控制面标准启动（127.0.0.1:8648） |
| `check-hub.mjs` | 队列与桥环境健康检查 |
| `worktree-manager.mjs` | 并行开发 git worktree 管理 |

## License

MIT
