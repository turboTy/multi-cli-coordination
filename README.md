# multi-cli-coordination

**让多个 CLI / AI Agent（ChatGPT、Codex、Claude、TRAE、WorkBuddy、qoder……）围绕同一个项目安全协作的工具包**：一个共享任务队列 + 一个把任务推进到目标会话的桌面桥 + 一个 Ekko 会话通道。纯 Node 内置模块，零第三方依赖。

> 从真实游戏项目（WASTELAND CHOICE）的多 Agent 生产协作中抽出，已在 Windows 本机长期运行。
>
> 🔧 **把桥接进真实客户端前，先读 [PITFALLS.md](PITFALLS.md)**——真实 WB / TRAE / Qoder 三通道联调的踩坑与规避清单（每条含现象 / 根因 / 规避 / 验证四项）。

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

## 快速接入：5 分钟联调跑通第一单

前置：Node ≥ 18（无需 npm install）；两个 CLI 客户端，一个当 **planner**（派活/验收，如 ChatGPT、Codex），一个当 **executor**（干活/交付，如 TRAE、WorkBuddy、Claude Code）。

### 第 1 步 · 把工具放进你的项目

```bash
# 方式 A：直接 clone（独立仓库时）
git clone https://github.com/turboTy/multi-cli-coordination.git your-project && cd your-project
# 方式 B：已有项目，只拷两个目录进去
#   tools/           ← 本仓库 tools/ 整个目录（代码）
#   coordination/    ← 本仓库 coordination/ 整个目录（队列种子 board.json）
```

### 第 2 步 · 注册两端身份（各一行代码）

打开 `tools/wsc-hub.mjs` 顶部 `ROLES` 表，为每个 CLI 各加一行（规划方 `planner`，执行方 `executor`；`chatgpt/workbuddy/trae/qoder` 已预置，可改成你自己的名字）：

```js
const ROLES = { chatgpt: 'planner', workbuddy: 'executor', trae: 'executor', qoder: 'executor' };
```

### 第 3 步 · 两端各跑一次配对自检（联调的核心）

```bash
node tools/pair.mjs --client <你的身份名>
```

一条命令完成四件事：**目录布局自检 → 身份注册判定 → 队列 CLI 实调 → MCP stdio 握手实调**（与真实客户端完全同路），通过后直接输出可粘贴的 MCP 配置片段和该角色的下一步操作模板。期望输出：

```
== 多 CLI 协作配对：workbuddy (executor) ==
ROOT    : D:/work/your-project
队列正本: D:/work/your-project/coordination/board.json
自检 layout: OK — 队列正本就位（0 个任务）
自检 queue-list: OK — client=workbuddy role=executor root=D:/work/your-project tasks=0
自检 mcp-handshake: OK — wsc-hub / 协议 2024-11-05 / 4 项工具 / wsc_list 实调通过

MCP 配置（粘进该 CLI 的 mcp 配置）：
{ "command": "…node", "args": ["…/tools/wsc-hub.mjs", "--client", "workbuddy", "mcp"], "cwd": "…" }
```

自检失败会给出精确原因和修法（未注册 → 退出码 2 + 注册指引；布局缺失 → 补 `coordination/` 种子）。**三行 OK = 联调环境就绪。**

### 第 4 步 · 把 MCP 配置粘进两端客户端

把 pair.mjs 输出的 JSON 粘进各 CLI 的 MCP 配置（文件路径按你机器的实际输出为准）。**不想用 MCP 也完全可以**：所有操作都有等价 CLI（见下）。

### 第 5 步 · 跑通第一单（验证全闭环）

终端 A（planner）创建并批准一个最小测试任务；终端 B（executor）领取执行后交付；终端 A 验收：

```bash
# ── 终端 A（planner）────────────────────────────────
# 1) 建任务（draft；owner 必须是执行端身份；allowedPaths 是执行端唯一可写白名单）
node tools/wsc-hub.mjs --client chatgpt create '{
  "id": "TEST-001",
  "title": "联调冒烟测试",
  "requirements": "运行 list 查看队列，把任务总数写入 coordination/demo-report.md",
  "acceptance": ["coordination/demo-report.md 存在且包含任务总数"],
  "allowedPaths": ["coordination/"],
  "owner": "workbuddy"
}'
# 2) 批准放行（draft → approved，执行端这才可见可领）
node tools/wsc-hub.mjs --client chatgpt approve '{"id":"TEST-001"}'

# ── 终端 B（executor）────────────────────────────────
# 3) 领取（approved → in-progress；同一端/路径重叠的任务互斥）
node tools/wsc-hub.mjs --client workbuddy claim '{"id":"TEST-001"}'
# 4) 按任务要求执行（只写 allowedPaths 白名单内文件）
# 5) 交付（→ awaiting-acceptance；然后 STOP 等验收，不要自验放行）
node tools/wsc-hub.mjs --client workbuddy submit '{"id":"TEST-001","summary":"已写 demo-report.md","evidence":["文件 coordination/demo-report.md"]}'
#    不想用 CLI 就在 B 的 MCP 工具面板里调 wsc_claim / wsc_submit，等价。

# ── 终端 A（planner）────────────────────────────────
# 6) 验收（→ accepted）或退回（→ approved，执行端重新 claim）
node tools/wsc-hub.mjs --client chatgpt accept '{"id":"TEST-001","note":"报告已核对"}'
```

✅ **联调成功的标志**：任务状态走到 `accepted`（`list` 里可见）。至此两端已具备完整协作能力，日常使用看下面的速查表即可。

## 两种接入形态（MCP / CLI 完全等价）

| | MCP 形态 | CLI 形态 |
|---|---|---|
| 接入 | pair.mjs 生成的配置片段粘进客户端 | 无需任何配置 |
| 调用 | 工具面板里 `wsc_list / wsc_claim / …` | `node tools/wsc-hub.mjs --client <身份> <动作> [JSON]` |
| 身份 | 由 `--client` 参数钉死 | 由 `--client` 参数（或 `WSC_CLIENT` 环境变量）钉死 |

身份钉死是协作隔离的关键：调用参数不能指定另一身份，执行端只能领/交本人任务。

## 命令速查

**planner（派活/验收）**

```bash
… --client chatgpt list                        # 看全队列（返回带 client/role/root 三字段自证身份）
… --client chatgpt get    '{"id":"…"}'          # 读单个任务包（含完整 history）
… --client chatgpt create '{"id":"…","title":"…","requirements":"…","acceptance":["…"],"allowedPaths":["…/"],"owner":"<executor>"}'
… --client chatgpt approve '{"id":"…"}'         # 批准放行
… --client chatgpt accept '{"id":"…","note":"…"}'   # 验收通过
… --client chatgpt return '{"id":"…","note":"…"}'   # 退回重做（→ approved）
… --client chatgpt cancel '{"id":"…","note":"…"}'   # 取消进行中任务
… --client chatgpt renew  '{"id":"…","note":"…","previousApprovalAt":"…","previousClaimAt":"…"}'  # 运输事故续办（须核对原时间戳）
```

**executor（干活/交付）**

```bash
… --client workbuddy list                      # 先核对 client/role/root 三字段
… --client workbuddy get    '{"id":"…"}'
… --client workbuddy claim  '{"id":"…"}'        # 只能领 owner===自己 且 status=approved 的任务
… --client workbuddy submit '{"id":"…","summary":"…","evidence":["SHA256=…"]}'
```

执行纪律：只动 `allowedPaths` 白名单内文件；不 commit/push（除非任务明确授权）；submit ≠ 放行（验收是 planner 的独立环节）；证据只写实测观察，时间戳绝不预填。

## 队列状态机

```
draft ──approve──▶ approved ──claim──▶ in-progress ──submit──▶ awaiting-acceptance ──accept──▶ accepted
   ▲                  ▲    ▲                │ cancel(隔离/取消)          │
   │                  │    └────────────────┘                          └── return ──▶ approved（重新 claim）
   └─ create          └── renew（运输任务恢复，须核对原批准/原领取时间戳）
```

## 进阶 1 · 桌面桥（把任务直接推进到某个会话，不用盯队列轮询）

- 安装：`powershell tools/desktop/install.ps1 -Client workbuddy`（或 `trae`）。扩展由桌面客户端的扩展宿主 fork `tools/desktop/<client>/`（WorkBuddy）或以 vsix（TRAE）加载。
- 会话绑定：WorkBuddy 扩展内 `CONVERSATION_ID`/`CONVERSATION_TITLE` 常量（**安装后必填**）决定目标会话；派发前校验该会话 `space.cwd === 项目根`，不符即拒发（不静默新建会话）。
- 防重放：dispatch 携带 approval revision = `sha256(任务ID + 最近一次 approve/return 时间戳)`。
- 排查：`node tools/desktop-dispatch.mjs status workbuddy`。
- ⚠️ 已知坑：扩展被安装到仓库外时，**不要用"相对层级推导项目根"**（层级不同会解析出错误根，导致所有校验永假）——用环境变量注入或分发时落配置文件。

## 进阶 1.5 · 多进程共存与独立部署（WSC_ROOT / WSC_BRIDGE_HOME）

两个环境变量解决「工具包部署在独立目录 / 多套桥并行」的场景；**都不设置时默认行为与上游完全一致**。

| 环境变量 | 作用对象 | 不设置时（默认） | 设置后 |
|---|---|---|---|
| `WSC_ROOT` | `tools/wsc-hub.mjs` | 队列正本按脚本自身位置向上一级推导 | 队列正本指向**另一个项目根**（目标会话所在工作区） |
| `WSC_BRIDGE_HOME` | `tools/desktop-dispatch.mjs` | 桥状态目录用共享 `desktop-bridge/` | 使用**私有桥状态目录**（`{client}-endpoint.json`、`trae-deploy.json`、`workbuddy-runtime-config.json` 落在这里） |

**为什么需要**：桥按项目根绑定（`ep.root === ROOT`），且状态目录里的文件名是单例——多进程共用一个 HOME 必然互相覆盖（实测坑，详见 [PITFALLS.md](PITFALLS.md) 共性 1/2）。

**多进程共存用法**：每个部署进程一组独立 `(WSC_ROOT, WSC_BRIDGE_HOME)` + 独立扩展 ID + 不可变 `<sessionId>` 绑定；多个部署指向同一个 `WSC_ROOT` 时，共享队列的 `board.json.lock` 跨进程互斥依然有效。

```bash
# 例：独立部署的 mcc 实例，队列正本在目标工作区、状态目录私有
WSC_ROOT=/path/to/target-workspace \
WSC_BRIDGE_HOME=~/.local/share/wsc-hub/mcc-desktop-bridge \
node tools/desktop-dispatch.mjs status workbuddy
```

## 进阶 2 · Ekko 会话通道（可选）

Ekko 控制面（`tools/start-ekko.ps1` 启动，127.0.0.1:8648）承载 Ekko 内 agent 会话：

- `tools/ekko-mcp.mjs`：认证 wrapper（读 `~/.local/share/wsc-hub/ekko-state/wsc-login.json` 自动登录换 JWT，再加载官方 ekko-studio-mcp）。
- 直连 API：`POST /api/auth/login` 换 JWT → `POST /api/studio/chat-run/runs`（`{input, session_id?}`）。
- 坑：`/api/studio/*` 只认登录 JWT（静态 token 全 401）；登录限流 10 次失败锁 60 分钟且状态持久化（`.login-lock.json`，须清锁+重启）；内置 hermes runtime 缺失时报 "Hermes Runtime is unavailable"（外部 CLI agent 改走 `/api/coding-agents/{id}/runs` 两步）。

## 安全与红线（所有接入方必读）

1. 队列正本 `coordination/board.json` 含你们的真实任务内容——**决定是否提交进 git**；本仓库 `.gitignore` 默认排除运行时凭据/桥状态，首次运行自动生成队列。
2. 凭据（Ekko 登录、桥 key）只存用户目录 `.local/share/wsc-hub/`，绝不进仓库。
3. 身份钉死不可参数化切换；执行端只动 `allowedPaths`；submit ≠ 放行（质量验收与主线裁决是独立环节）。
4. submit 证据只写实测观察，时间戳来自真实工具返回——**绝不预填未发生的事件**。
5. 并行开发用独立 git worktree 隔离各执行端。

## 目录结构

```
your-project/                 # 部署到你的项目时保持此结构（wsc-hub.mjs 按自身位置向上一级推导项目根）
├─ coordination/              # 队列正本（数据）：board.json 由 hub 读写
└─ tools/                     # 本工具包（代码）
   ├─ wsc-hub.mjs             # 队列中枢（~234 行）：stdio MCP server 与 CLI 双形态，身份钉死、状态机、互斥
   ├─ pair.mjs                # ★新用户入口：一键配对自检 + MCP 配置片段 + 角色操作模板
   ├─ desktop-dispatch.mjs    # 桌面桥派发（status/dispatch/recover）
   ├─ ekko-mcp.mjs            # Ekko 通道认证 wrapper（依赖官方 ekko-studio 包，见致谢）
   ├─ start-ekko.ps1          # Ekko 控制面标准启动（127.0.0.1:8648，含就绪核验）
   └─ desktop/                # 可选：桌面桥扩展
      ├─ install.ps1          # 安装入口（-Client workbuddy|trae）
      ├─ workbuddy/           # WorkBuddy 桌面桥扩展（v0.3.0：pipe + key，conversations.get/runPrompt）
      └─ trae/                # TRAE (VS Code 系) 桌面桥扩展（v0.2.3，部署配置动态解析根）
```

## 与 Ekko 类多 Agent 工作区的区别

[EkkolLearnAI/ekko-studio](https://github.com/EKKOLearnAI/ekko-studio) 这类产品把你的所有 agent 运行时（Claude Code、Codex、Hermes、OpenCode、DSH 等）收拢进一个统一的图形工作区——功能全面，但也意味着**换地方干活**。本工具包走的是另一条路：

| 维度 | Ekko 类工作区 | 本工具包 |
|---|---|---|
| 使用习惯 | Agent 迁入 Ekko 界面，在新工作区里开会话/管理 | **零改变**——各 CLI 留在原生客户端（ChatGPT 网页、Codex、TRAE、WorkBuddy 各自照用），桥只往既有会话注入一条任务 prompt |
| 新增工具 | 一个常驻桌面应用 + runtime 体系（hermes/ekko runtime） | **无新工具**——管理面就是项目里的一个 JSON 文件（`board.json`）+ 你已有的 git/编辑器；队列闭环只需 node，无常驻进程 |
| 重量 | 完整桌面应用（多平台安装包/Docker，Node≥23，Python bridge） | ~1000 行 Node 内置模块，零第三方依赖，冷启动一条命令 |
| 验收语义 | 工作流/approval gate 面向**单次运行**的审批 | 内建**任务级验收状态机**（draft→approved→in-progress→awaiting-acceptance→accepted/return）+ 角色权限 + allowedPaths 白名单互斥 + approval revision 防重放 |
| 状态可审计 | 平台内会话/SQLite | 队列即文档：`board.json` 人类可读、可 git diff、可离线审计、随仓库交接换机 |
| 多对话隔离 | 界面内多会话 | 固定会话各绑各的身份与 cwd 校验，跨对话借用被结构性阻止 |

两者**定位互补、不互斥**：如果你已经在用 Ekko 管理运行时，本包的 Ekko 通道可以继续把 Ekko 会话纳入同一套跨 CLI 验收队列；如果你不想引入任何新工作区，只用队列 + 桥即可。

## 致谢（Acknowledgements）

- **[Ekko Studio](https://github.com/EKKOLearnAI/ekko-studio)**（EKKOLearnAI，原 Hermes Studio）：local-first 的多 Agent 工作区，支持 Hermes / Ekko / Claude Code / Codex / Pi / Grok / OpenCode / DSH 等运行时的多 agent 聊天、编码与可视化工作流，提供桌面端与自托管 Web 控制台，并通过 `ekko_studio_*` 前缀的 MCP 工具集对外暴露能力。本工具包的 **Ekko 通道**（`ekko-mcp.mjs` 认证 wrapper 与 `start-ekko.ps1` 启动器）直接构建在其官方 npm 包 `ekko-studio` 与官方 MCP 入口 `bin/ekko-studio-mcp.mjs` 之上——没有这个项目，"Ekko 会话通道"这一形态不存在。Ekko Studio 采用 **BSL-1.1** 许可证（以[原仓库 LICENSE](https://github.com/EKKOLearnAI/ekko-studio/blob/main/LICENSE) 为准）；本工具包不包含、不修改其任何代码，仅做进程启动与登录态包装，使用请遵守其许可证条款。
- 感谢 WASTELAND CHOICE 项目：本工具包从其生产级多 Agent 协作流程（planner/executor 队列 + 桌面桥）中抽出，所有设计都经真实任务打磨。

## License

MIT
