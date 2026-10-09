#!/usr/bin/env node
// 多 CLI 桥接一键配对：判定身份注册 → 生成 MCP 配置片段 → 队列连通自检 → 打印两端操作模板。
// 用法：node tools/coordination/pair.mjs --client <name> [--json]
// 只读工具：不修改任何仓库文件；新身份注册需在 wsc-hub.mjs ROLES 表加一行（代码变更须 HTY 拍板）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './wsc-hub.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const jsonOut = args.includes('--json');
const client = flag('--client');
if (!client || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(client)) {
  console.error(`用法：node tools/coordination/${path.basename(process.argv[1])} --client <name> [--json]`);
  process.exit(2);
}
const hubPath = path.join(ROOT, 'tools', 'coordination', 'wsc-hub.mjs');
const boardPath = path.join(ROOT, 'coordination', 'board.json');

// 判定 1（主）：源码解析 ROLES 表（只读、跨环境可靠）
const hubSource = readFileSync(hubPath, 'utf8');
const roleMatch = hubSource.match(new RegExp(`\\b${client}\\s*:\\s*'(planner|executor)'`));
const role = roleMatch ? roleMatch[1] : null;
const registered = !!role;

// 判定 2（加强）：子进程实调 list（沙箱/受限环境可能 EBUSY，失败标 SKIP 不误报）
const checks = [];
const run = spawnSync(process.execPath, [hubPath, '--client', client, 'list'], { encoding: 'utf8', timeout: 15000 });
if (run.error) {
  checks.push({ name: 'queue-list', ok: null, detail: `环境限制无法子进程实调（${run.error.code || run.error.message}）；请手动跑: node tools/coordination/wsc-hub.mjs --client ${client} list` });
} else {
  let list = null;
  try { list = JSON.parse((run.stdout || '').trim().split(/\r?\n/).pop()); } catch { /* 未注册/出错时输出为错误文本 */ }
  const ok = run.status === 0 && !!list && list.client === client;
  checks.push({ name: 'queue-list', ok, detail: ok ? `client=${list.client} role=${list.role} root=${list.root} tasks=${list.tasks.length}` : ((run.stderr || run.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${run.status}`) });
}

const result = { client, role, registered, root: ROOT, hub: hubPath, board: boardPath, checks };
if (!registered) {
  result.next = [
    `1) 在 tools/coordination/wsc-hub.mjs 顶部 ROLES 表加一行（代码变更须 HTY 拍板）：`,
    `   ${client}: 'executor',   （若新 CLI 是规划方则写 'planner'）`,
    `2) 在 coordination/clients.json 的 clients 下加：`,
    `   "${client}": { "role": "executor", "root": "${ROOT.replace(/\\/g, '/')}" }`,
    '3) 重跑本命令完成自检。',
  ];
} else {
  result.mcpConfig = { command: process.execPath, args: [hubPath, '--client', client, 'mcp'], cwd: ROOT };
  result.next = role === 'planner'
    ? [
        `1) 挂载上方 mcpConfig 后创建任务（owner 须为执行端身份）：`,
        `   node tools/coordination/wsc-hub.mjs --client ${client} create '{"id":"TEST-<日期>-001","title":"…","requirements":"…","acceptance":["…"],"allowedPaths":["docs/coordination/"],"owner":"workbuddy"}'`,
        `2) 批准放行：… --client ${client} approve '{"id":"TEST-<日期>-001"}'`,
        `3)（可选）推进目标会话：node tools/coordination/desktop-dispatch.mjs dispatch TEST-<日期>-001`,
        `4) 执行端 submit 后验收：… accept '{"id":"TEST-<日期>-001","note":"…"}' 或 return（回 approved）`,
      ]
    : [
        `1) 挂载上方 mcpConfig 后查队列：list → 只认 owner=${client} 且 status=approved 的任务`,
        `2) 领取：claim '{"id":"…"}'（approved→in-progress）；只动 allowedPaths 白名单内文件`,
        `3) 交付：submit '{"id":"…","summary":"非空摘要","evidence":["可复查证据，如 SHA256"]}'（→awaiting-acceptance 后 STOP 等验收）`,
        `4) 红线：不得提交/推送/合流；submit 证据只写实测观察，时间戳绝不预填。`,
      ];
}
if (jsonOut) { console.log(JSON.stringify(result, null, 2)); process.exit(registered ? 0 : 2); }
console.log(`== WSC 多 CLI 配对：${client} (${role || '未注册'}) ==`);
console.log(`ROOT    : ${ROOT}`);
console.log(`队列正本: ${boardPath}`);
for (const c of checks) console.log(`自检 ${c.name}: ${c.ok === true ? 'OK' : c.ok === false ? 'FAIL' : 'SKIP'} — ${c.detail}`);
if (!registered) { console.log('\n[未注册] 完成以下步骤后重跑本命令：'); result.next.forEach(n => console.log('  ' + n)); process.exit(2); }
console.log('\nMCP 配置（粘进该 CLI 的 mcp 配置）：');
console.log(JSON.stringify(result.mcpConfig, null, 2));
console.log('\n下一步：');
result.next.forEach(n => console.log('  ' + n));
