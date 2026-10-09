#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, access, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ROOT, createHub } from './wsc-hub.mjs';

// 本地安装根按当前用户解析：原实现写死作者机器的用户目录，换机即失效。
const EKKO_HOME = path.join(homedir(), '.local/share/wsc-hub').replace(/\\/g, '/');
const runCommand = promisify(execFile);

export function validateListener(records, expectedPid) {
  const listeners = Array.isArray(records) ? records : [records];
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || !listeners.length || listeners.some(record => record?.OwningProcess !== expectedPid || !['127.0.0.1', '::1'].includes(record?.LocalAddress))) throw new Error('Ekko 监听地址或状态目录对应的进程不一致');
}

// One child per probe, bounded requests, no stderr or raw tool output (may contain secrets).
export async function probeMcp(args, { timeout = 15000, env = process.env, command = process.execPath, cwd = ROOT, call } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 1;
  const pending = new Map();
  const closed = new Promise(resolve => child.once('close', resolve));
  const failAll = () => { for (const item of pending.values()) item.reject(new Error('MCP 子进程提前结束')); pending.clear(); };
  child.on('error', failAll); child.on('exit', failAll);
  lines.on('line', line => {
    try { const message = JSON.parse(line); const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error('MCP 返回协议错误')) : item.resolve(message.result); } } catch { /* Ignore non-protocol logs. */ }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => { if (error) { const item = pending.get(id); pending.delete(id); item?.reject(new Error('无法写入 MCP 子进程')); } });
  });
  try {
    const initialize = await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wsc-hub-check', version: '1.0.0' } });
    if (!initialize?.serverInfo?.name || !initialize?.protocolVersion || !initialize?.capabilities?.tools) throw new Error('initialize 响应不完整');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await request('tools/list', {});
    if (!Array.isArray(listed?.tools) || !listed.tools.length) throw new Error('tools/list 缺少工具');
    let data;
    if (call) {
      const result = await request('tools/call', call);
      if (!result || result.isError) throw new Error('实际工具调用失败（不输出原始响应）');
      try { data = JSON.parse(result.content.find(block => block.type === 'text').text); }
      catch { throw new Error('实际工具调用未返回有效 JSON'); }
      if (data?.isError || data?.error || data?.success === false) throw new Error('实际工具调用返回失败（不输出原始响应）');
    }
    return { protocol: initialize.protocolVersion, tools: listed.tools.map(tool => tool.name), data };
  } finally {
    failAll(); lines.close(); child.stdin.destroy(); child.kill();
    await Promise.race([closed, new Promise(resolve => { const timer = setTimeout(resolve, 2000); timer.unref(); })]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

export async function diagnose() {
  const results = [];
  async function check(name, fn) {
    try { const detail = await fn(); results.push({ name, status: 'PASS', ...(detail ? { detail } : {}) }); }
    catch (error) { results.push({ name, status: 'FAIL', reason: error.message }); }
  }
  await check('同目录与角色映射', async () => {
    const config = JSON.parse(await readFile(path.join(ROOT, 'coordination/clients.json'), 'utf8'));
    if (config.version !== 1 || config.executionMode !== 'scoped-parallel') throw new Error('配置版本或执行模式无效');
    for (const [client, role] of Object.entries({ chatgpt: 'planner', workbuddy: 'executor', trae: 'executor', qoder: 'executor' })) {
      if (config.clients?.[client]?.role !== role || await realpath(config.clients[client].root) !== await realpath(ROOT)) throw new Error(`${client} 目录或职责不一致`);
    }
    if (config.ekko?.url !== 'http://127.0.0.1:8648' || config.ekko.install !== `${EKKO_HOME}/ekko` || config.ekko.state !== `${EKKO_HOME}/ekko-state`) throw new Error('Ekko 固定安装配置不一致');
  });
  await check('本地队列读取', async () => { await createHub({ client: 'chatgpt' }).readBoard(); });
  for (const client of ['chatgpt', 'workbuddy', 'trae', 'qoder']) {
    await check(`${client} MCP initialize/tools/list`, async () => {
      const result = await probeMcp([path.join(ROOT, 'tools/coordination/wsc-hub.mjs'), '--client', client, 'mcp'], { call: { name: 'wsc_list', arguments: {} } });
      const expected = createHub({ client }).actions.map(action => `wsc_${action}`);
      if (JSON.stringify(result.tools) !== JSON.stringify(expected)) throw new Error('角色工具集不一致');
      if (result.data?.client !== client || path.resolve(result.data.root) !== ROOT) throw new Error('实际调用目录或身份不一致');
      return `${result.tools.length} 项角色工具`;
    });
  }
  await check('Ekko 安装与状态目录', async () => {
    await access(`${EKKO_HOME}/ekko/node_modules/ekko-studio/bin/ekko-studio-mcp.mjs`);
    await access(`${EKKO_HOME}/ekko-state`);
    await access(path.join(ROOT, 'tools/coordination/ekko-mcp.mjs'));
  });
  await check('Ekko HTTP 可达', async () => {
    const response = await fetch('http://127.0.0.1:8648', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  });
  await check('Ekko 实际监听与项目工作根', async () => {
    if (process.platform !== 'win32') throw new Error('本部署需要 Windows 监听核验');
    const expectedPid = Number((await readFile(`${EKKO_HOME}/ekko-state/server.pid`, 'utf8')).trim());
    const { stdout } = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection -LocalPort 8648 -State Listen | Select-Object LocalAddress,OwningProcess | ConvertTo-Json -Compress'], { timeout: 8000, windowsHide: true });
    validateListener(JSON.parse(stdout), expectedPid);
    const result = await probeMcp([path.join(ROOT, 'tools/coordination/ekko-mcp.mjs'), 'api'], { call: { name: 'ekko_studio_api_request', arguments: { method: 'GET', path: '/api/studio/workspace/folders' } } });
    if (result.data?.status !== 200 || path.resolve(result.data?.body?.base ?? '') !== ROOT) throw new Error('Ekko 运行中的工作根不是 WSC');
    return '已核验回环监听、独立状态目录 PID、运行时 workspace base';
  });
  const ekkoCall = { name: 'ekko_studio_use_toolset', arguments: { action: 'call', tool: 'ekko_studio_use_workflows_list', arguments: {} } };
  await check('Ekko MCP initialize/tools/list/workflows_list', async () => {
    const result = await probeMcp([path.join(ROOT, 'tools/coordination/ekko-mcp.mjs'), 'use'], { call: ekkoCall });
    return `${result.tools.length} 项原生工具；workflows_list 实调通过`;
  });
  const clientConfigs = [
    ['workbuddy', path.join(homedir(), '.workbuddy/mcp.json'), ['wsc-coordination', 'wsc-ekko-use']],
    ['trae', path.join(ROOT, '.trae/mcp.json'), ['wsc-coordination', 'wsc-ekko-use']],
    ['qoder', path.join(ROOT, '.qoder/settings.local.json'), ['wsc-coordination']],
  ];
  for (const [client, configFile, requiredServers] of clientConfigs) {
    await check(`${client} 已保存配置与实际工具调用`, async () => {
      const config = JSON.parse(await readFile(configFile, 'utf8'));
      for (const name of requiredServers) {
        const server = config.mcpServers?.[name];
        if (!server || typeof server.command !== 'string' || !Array.isArray(server.args) || !server.cwd) throw new Error('客户端配置缺少启动参数');
        await access(server.command);
        if (await realpath(server.command) !== await realpath(process.execPath) || await realpath(server.cwd) !== await realpath(ROOT)) throw new Error('客户端 Node 命令或工作目录不一致');
        const expectedArgs = name === 'wsc-coordination' ? [path.join(ROOT, 'tools/coordination/wsc-hub.mjs'), '--client', client, 'mcp'] : [path.join(ROOT, 'tools/coordination/ekko-mcp.mjs'), 'use'];
        // Windows 路径不区分大小写：配置里 D:/ 与 ROOT 的 d:\ 只是盘符大小写差异，不应判为不一致。
        if (server.args.length !== expectedArgs.length || path.resolve(server.args[0]).toLowerCase() !== path.resolve(expectedArgs[0]).toLowerCase() || server.args.slice(1).some((arg, index) => arg !== expectedArgs[index + 1])) throw new Error('客户端入口或固定身份参数不一致');
        if (name === 'wsc-coordination' && server.env?.WSC_CLIENT && server.env.WSC_CLIENT !== client) throw new Error('客户端身份环境不一致');
        const call = name === 'wsc-coordination' ? { name: 'wsc_list', arguments: {} } : ekkoCall;
        const result = await probeMcp(server.args, { command: server.command, cwd: server.cwd, env: { ...process.env, ...server.env }, call });
        if (name === 'wsc-coordination') {
          if (result.data?.client !== client || path.resolve(result.data?.root ?? '').toLowerCase() !== ROOT.toLowerCase() || result.tools.some(tool => ['wsc_create', 'wsc_approve', 'wsc_accept', 'wsc_return'].includes(tool))) throw new Error('客户端目录、身份或执行权限不一致');
        }
      }
      return `${requiredServers.length} 项保存配置按原参数启动，initialize/tools/list/只读调用通过；真实客户端加载待确认`;
    });
  }
  return { root: ROOT, results, clientLoading: 'PENDING：保存配置和 stdio 实测通过不等于客户端已刷新、信任或加载；普通 ChatGPT 云端未直连本地 MCP' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  diagnose().then(report => { console.log(JSON.stringify(report, null, 2)); if (report.results.some(item => item.status === 'FAIL')) process.exitCode = 1; }).catch(() => { console.error('协作中枢诊断失败'); process.exitCode = 1; });
}
