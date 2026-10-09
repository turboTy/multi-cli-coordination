#!/usr/bin/env node
// 多 CLI 协作一键配对：布局自检 → 身份判定 → 队列连通 → MCP stdio 握手实调 → 输出配置片段与两端操作模板。
// 用法：node tools/pair.mjs --client <name> [--json]
// 只读工具：不修改任何仓库文件；新身份注册 = 在 tools/wsc-hub.mjs 顶部 ROLES 表加一行后重跑本命令。
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './wsc-hub.mjs';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const jsonOut = args.includes('--json');
const client = flag('--client');
if (!client || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(client)) {
  console.error(`用法：node tools/${path.basename(process.argv[1])} --client <name> [--json]`);
  process.exit(2);
}
const hubPath = path.join(ROOT, 'tools', 'wsc-hub.mjs');
const boardPath = path.join(ROOT, 'coordination', 'board.json');
const checks = [];

// 检查 0：目录布局——队列正本必须在 <root>/coordination/board.json 且格式有效。
try {
  const board = JSON.parse(readFileSync(boardPath, 'utf8'));
  if (board.version !== 1 || !Array.isArray(board.tasks)) throw new Error('格式无效');
  checks.push({ name: 'layout', ok: true, detail: `队列正本就位（${board.tasks.length} 个任务）` });
} catch (error) {
  checks.push({ name: 'layout', ok: false, detail: `${boardPath} 缺失或格式无效；请从本仓库拷贝 coordination/ 种子，或写入 {"version":1,"tasks":[]}` });
}

// 判定 1（主）：源码解析 ROLES 表（只读、跨环境可靠）
const hubSource = readFileSync(hubPath, 'utf8');
const roleMatch = hubSource.match(new RegExp(`\\b${client}\\s*:\\s*'(planner|executor)'`));
const role = roleMatch ? roleMatch[1] : null;
const registered = !!role;

// 检查 1：队列 CLI 实调（沙箱/受限环境可能无法子进程，失败标 SKIP 不误报；未注册则跳过，避免误报 FAIL）
if (!registered) {
  checks.push({ name: 'queue-list', ok: null, detail: '身份未注册，跳过（先注册再重跑）' });
} else {
  const run = spawnSync(process.execPath, [hubPath, '--client', client, 'list'], { encoding: 'utf8', timeout: 15000 });
  if (run.error) {
    checks.push({ name: 'queue-list', ok: null, detail: `环境限制无法子进程实调（${run.error.code || run.error.message}）；请手动跑: node tools/wsc-hub.mjs --client ${client} list` });
  } else {
    let list = null;
    try { list = JSON.parse(run.stdout || ''); } catch { /* list 输出为 pretty JSON 全文；解析失败说明非正常返回 */ }
    const ok = run.status === 0 && !!list && list.client === client;
    checks.push({ name: 'queue-list', ok, detail: ok ? `client=${list.client} role=${list.role} root=${list.root} tasks=${list.tasks.length}` : ((run.stderr || run.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${run.status}`) });
  }
}

// 检查 2：MCP stdio 握手实调——与真实客户端完全同路：initialize → tools/list → wsc_list。
async function probeMcp() {
  const child = spawn(process.execPath, [hubPath, '--client', client, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let nextId = 1;
  const pending = new Map();
  const failAll = (message) => { for (const item of pending.values()) item.reject(new Error(message)); pending.clear(); };
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try { const message = JSON.parse(line); const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error('MCP 返回协议错误')) : item.resolve(message.result); } } catch { /* 忽略非协议输出 */ }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, () => {});
  });
  try {
    const initialize = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pair-probe', version: '1.0.0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request('tools/list', {});
    if (!Array.isArray(listed?.tools) || !listed.tools.length) throw new Error('tools/list 缺少工具');
    const called = await request('tools/call', { name: 'wsc_list', arguments: {} });
    if (called.isError) throw new Error('wsc_list 实调失败');
    const data = JSON.parse(called.content.find(block => block.type === 'text').text);
    if (data.client !== client) throw new Error('实调返回身份不一致');
    return `${initialize.serverInfo?.name} / 协议 ${initialize.protocolVersion} / ${listed.tools.length} 项工具 / wsc_list 实调通过`;
  } finally {
    failAll('MCP 子进程提前结束'); lines.close(); child.stdin.destroy(); child.kill();
  }
}
if (!registered) checks.push({ name: 'mcp-handshake', ok: null, detail: '身份未注册，跳过' });
else {
  try { checks.push({ name: 'mcp-handshake', ok: true, detail: await probeMcp() }); }
  catch (error) { checks.push({ name: 'mcp-handshake', ok: false, detail: error.message }); }
}

const result = { client, role, registered, root: ROOT, hub: hubPath, board: boardPath, checks };
if (!registered) {
  result.next = [
    `1) 在 tools/wsc-hub.mjs 顶部 ROLES 表加一行，把本 CLI 注册为执行端：`,
    `   ${client}: 'executor',   （若是规划方则写 'planner'）`,
    '2) 重跑本命令完成自检。',
  ];
} else {
  result.mcpConfig = { command: process.execPath, args: [hubPath, '--client', client, 'mcp'], cwd: ROOT };
  result.next = role === 'planner'
    ? [
        `1) 挂载上方 mcpConfig 后创建任务（owner 须为执行端身份，allowedPaths 是执行端唯一可写白名单）：`,
        `   node tools/wsc-hub.mjs --client ${client} create '{"id":"TEST-<日期>-001","title":"…","requirements":"…","acceptance":["…"],"allowedPaths":["<可写目录>/"],"owner":"<执行端>"}'`,
        `2) 批准放行：… --client ${client} approve '{"id":"TEST-<日期>-001"}'`,
        `3)（可选）推进目标会话：node tools/desktop-dispatch.mjs dispatch TEST-<日期>-001`,
        `4) 执行端 submit 后验收：… accept '{"id":"TEST-<日期>-001","note":"…"}' 或 return（回 approved）`,
      ]
    : [
        `1) 挂载上方 mcpConfig 后查队列：list → 只认 owner=${client} 且 status=approved 的任务`,
        `2) 领取：claim '{"id":"…"}'（approved→in-progress）；只动 allowedPaths 白名单内文件`,
        `3) 交付：submit '{"id":"…","summary":"非空摘要","evidence":["可复查证据，如 SHA256"]}'（→awaiting-acceptance 后 STOP 等验收）`,
        `4) 红线：不得提交/推送/合流；submit 证据只写实测观察，时间戳绝不预填。`,
      ];
}
if (jsonOut) { console.log(JSON.stringify(result, null, 2)); process.exit(!registered ? 2 : checks.some(c => c.ok === false) ? 1 : 0); }
console.log(`== 多 CLI 协作配对：${client} (${role || '未注册'}) ==`);
console.log(`ROOT    : ${ROOT}`);
console.log(`队列正本: ${boardPath}`);
for (const c of checks) console.log(`自检 ${c.name}: ${c.ok === true ? 'OK' : c.ok === false ? 'FAIL' : 'SKIP'} — ${c.detail}`);
if (!registered) { console.log('\n[未注册] 完成以下步骤后重跑本命令：'); result.next.forEach(n => console.log('  ' + n)); process.exit(2); }
console.log('\nMCP 配置（粘进该 CLI 的 mcp 配置）：');
console.log(JSON.stringify(result.mcpConfig, null, 2));
console.log('\n下一步：');
result.next.forEach(n => console.log('  ' + n));
process.exit(checks.some(c => c.ok === false) ? 1 : 0);
