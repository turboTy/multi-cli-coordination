#!/usr/bin/env node
// 通道连通性自检：把一只**只读探测单**推进目标会话，再用队列 history 判定闭环。
//
// 为什么需要它：desktop-dispatch 的 `status` 只证明"桥进程在、端点描述有效、绑定校验通过"，
// **不证明任务真能送到执行端手里**。唯一判据是队列 history 里出现执行端本人真实的
// claim + submit（见 README「安全与红线」与 PITFALLS 共性 5）。
// 本工具把这个判据做成一条可复跑的命令，用于：换机重建后自检、新接入方首次联调、
// 绑定变更/客户端升级后的回归。
//
// 探测单的硬约束：只读、零文件写入、不 commit、不替 planner 验收；执行端只需
// claim 后在回复里原样输出标记再 submit。
//
// 用法（无第三方依赖，仅 Node 内置模块）：
//   node tools/probe.mjs build  <owner> [stamp]        # 建单 + 批准（queued）
//   node tools/probe.mjs send   <owner> [stamp]        # 桥派发（可选；不经桥也可让执行端自己 claim）
//   node tools/probe.mjs verify <owner> [stamp]        # 独立判定是否闭环（唯一判据）
//   node tools/probe.mjs status [owner]                # 列出探测单与当前状态
//
// 退出码：0 通过 / 1 未通过或出错（可直接用于 CI 或脚本 gate）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from './wsc-hub.mjs';

const STAMP_FALLBACK = new Date().toISOString().slice(0, 10).replaceAll('-', '');
// 与 tools/wsc-hub.mjs 的 ROLES 表保持同步（这里只列可作执行端的身份）。
const OWNERS = ['workbuddy', 'trae', 'qoder'];

// allowedPaths 必须**每单独立**，只按 owner 分还不够。
//
// 闸门 tasksConflict 判据：`owner 相等 || allowedPaths 任一对重叠`，且 pathsOverlap
// 会**剥掉尾斜杠**做前缀比较。因此：
//   · 三端共用同一路径 → 任一端已存在的探测单会挡住另一端的 claim/派发；
//   · 只按 owner 分（`probes/<owner>/`）→ 跨端不再互挡，但**同一端跑第二次仍会被
//     上一单挡住**：上一单闭环后停在 awaiting-acceptance，其 `probes/<owner>` 与新单的
//     `probes/<owner>/` 剥斜杠后相等，L178 的待验收重叠闸门直接报错（实测踩过）。
// 所以路径带 stamp：`coordination/probes/<owner>/<stamp>/`，每一单一个独立前缀，
// 新旧探测单之间不会再互相阻塞。marker 与目录名同步从 id 派生。
export function probeId(owner, stamp) {
  return `PROBE-${String(owner).toUpperCase()}-${stamp}`;
}

export function probeSpec(owner, stamp) {
  if (!/^[a-zA-Z0-9_-]+$/.test(String(stamp))) throw new Error('stamp 只能是字母、数字、下划线或短横线（会进任务 ID 与 allowedPaths）');
  if (!OWNERS.includes(owner)) throw new Error(`未知 owner「${owner}」；可用：${OWNERS.join(' / ')}（如需新增，必须同时确认它能为探测单提供独立 allowedPaths）`);
  const marker = `${probeId(owner, stamp)}-LINK-OK`;
  const probesDir = `coordination/probes/${owner}/${stamp}/`;
  return {
    id: probeId(owner, stamp),
    marker,
    probesDir,
    spec: {
      id: probeId(owner, stamp),
      title: `通道连通性自检（${owner}）· ${stamp}`,
      requirements: [
        '这是一次**只读**连通性探测，目的仅是证明队列与桥能把任务送到你手上，并拿到你本人的真实 claim/submit。',
        '1) 用 list / get 核对本任务：owner 是你、status=approved；',
        '2) claim 本任务；',
        `3) 在回复正文里**原样输出**标记 ${marker}；`,
        '4) submit；summary 必须包含该标记，evidence 写你实际执行的时间戳与命令。',
        `硬约束：不新建、不修改、不删除任何文件。本任务只给了唯一白名单 ${probesDir}，但**不要求你写任何文件**；`,
        '若要把"零写入"落成证据，可在 evidence 里写执行前后 `git status --porcelain` 的比对结果，不要为了留证而去创建文件。',
        '不 commit / push / merge；不改队列以外的任何状态；不替 planner 做验收。',
        '若你的 MCP 工具不可用，可改用同一 wsc-hub.mjs 的 CLI，但**如实标注通道**。',
      ].join('\n'),
      acceptance: [
        `history 中出现 ${owner} 本人的真实 claim 与 submit`,
        `submit.summary 含标记 ${marker}`,
        '执行期间没有任何文件写入记录',
      ],
      allowedPaths: [probesDir],
      owner,
    },
  };
}

/** 独立判定闭环：只看队列 history，不看任何"送达/在线"信号。 */
export function judge(task, owner, marker) {
  const history = Array.isArray(task?.history) ? task.history : [];
  const claims = history.filter((e) => e.action === 'claim' && e.client === owner);
  const submits = history.filter((e) => e.action === 'submit' && e.client === owner);
  const authoritative = history.filter((e) => ['claim', 'submit'].includes(e.action) && e.client !== owner);
  // 闭环成功后状态自然停在 awaiting-acceptance（submit 之后、planner accept 之前），
  // 所以这里**不能要求 approved**——那会把"已闭环"误判成"未闭环"（实测踩过）。
  // 只排除 draft / cancelled 这类"根本没进入执行"的状态。
  const runnable = ['approved', 'in-progress', 'awaiting-acceptance', 'accepted'];
  const checks = [
    ['任务存在', Boolean(task), task ? '' : '队列里找不到该任务'],
    ['status 已进入执行区间', runnable.includes(task?.status), `当前 ${task?.status}`],
    [`claim 由 ${owner} 本人发起`, claims.length > 0, claims.length ? `${claims.length} 次` : '没有'],
    [`submit 由 ${owner} 本人发起`, submits.length > 0, submits.length ? `${submits.length} 次` : '没有'],
    ['闭环动作未被冒用身份', authoritative.length === 0, authoritative.length ? `出现 ${authoritative.map((e) => `${e.action}@${e.client}`).join(', ')}` : ''],
    ['summary 含约定标记', String(task?.summary ?? '').includes(marker), String(task?.summary ?? '').includes(marker) ? '' : `标记 ${marker}`],
    ['evidence 非空', Array.isArray(task?.evidence) && task.evidence.length > 0, Array.isArray(task?.evidence) ? `${task.evidence.length} 条` : '缺失'],
  ];
  const check = (name) => checks.find(([n]) => n === name)?.[1] === true;
  // 闭环判据（缺一不可）：任务在、执行端本人 claim、执行端本人 submit、
  // 没有被冒用身份的动作、summary 带回约定标记、evidence 非空。
  const passed = Boolean(task)
    && check('claim 由 ' + owner + ' 本人发起')
    && check('submit 由 ' + owner + ' 本人发起')
    && check('闭环动作未被冒用身份')
    && check('summary 含约定标记')
    && check('evidence 非空');
  return { passed, checks };
}

async function main(argv = process.argv.slice(2)) {
  const [action, ownerArg, stampArg] = argv;
  const owner = ownerArg ?? 'workbuddy';
  const stamp = stampArg ?? STAMP_FALLBACK;
  const { spec, marker } = probeSpec(owner, stamp);
  const hub = createHub({ client: 'chatgpt' });

  if (action === 'build') {
    const board = await hub.run('list');
    const existing = board.tasks.find((t) => t.id === spec.id);
    if (existing) {
      // 同一 stamp 复用：已领取/已交付的单不能重建（会打断执行端）
      console.log(JSON.stringify({ id: spec.id, marker, reused: true, status: existing.status, hint: existing.status === 'approved' ? '可直接 send' : '该 stamp 已有在途/已完成记录，换一个 stamp 再探测' }, null, 2));
      return;
    }
    await hub.run('create', spec);
    await hub.run('approve', { id: spec.id });
    const after = await hub.run('get', { id: spec.id });
    console.log(JSON.stringify({ id: spec.id, marker, owner, allowedPaths: spec.allowedPaths, status: after.status, next: `node tools/probe.mjs send ${owner} ${stamp}   # 或让执行端自己 claim` }, null, 2));
    return;
  }

  if (action === 'send') {
    const { dispatchTask } = await import('./desktop-dispatch.mjs');
    const result = await dispatchTask(spec.id, { hub, home: process.env.WSC_BRIDGE_HOME });
    console.log(JSON.stringify({ ...result, marker, note: 'nativeInvoked 只代表"已送进会话"，闭环仍以 verify 的 history 判据为准' }, null, 2));
    return;
  }

  if (action === 'verify') {
    const task = await hub.run('get', { id: spec.id });
    const { passed, checks } = judge(task, owner, marker);
    for (const [name, ok, extra] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
    console.log(`\n${passed ? '闭环成立' : '**未闭环**'}：${spec.id}`);
    if (!passed) process.exitCode = 1;
    return;
  }

  if (action === 'status') {
    const board = await hub.run('list');
    const rows = board.tasks.filter((t) => /^PROBE-/.test(t.id) && (!ownerArg || t.id.includes(String(ownerArg).toUpperCase())));
    if (!rows.length) { console.log(ownerArg ? `没有 ${ownerArg} 的探测单` : '没有任何探测单'); return; }
    for (const t of rows) {
      const h = (t.history ?? []).map((e) => `${e.action}@${e.client}`).join(' → ');
      console.log(`${t.id.padEnd(34)} ${String(t.status).padEnd(20)} ${h}`);
    }
    return;
  }

  throw new Error('用法：probe.mjs build|send|verify|status <owner> [stamp]');
}

// 入口守卫与 wsc-hub.mjs 保持同一写法：Windows 上 argv[1] 是反斜杠形式，
// 直接与 fileURLToPath 的字符串比较会判假，必须走 path.resolve。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
