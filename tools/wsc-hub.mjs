#!/usr/bin/env node
import { readFile, open, rename, unlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// 项目根 = 本脚本所在 tools/ 目录的上一级；队列正本固定在 <root>/coordination/board.json。
// MCC 独立部署补丁（唯一改动）：允许用 WSC_ROOT 指定队列正本所在的项目根。
// 上游按本文件位置向上两级推导项目根；当需要把队列指向另一个项目（例如目标会话所在的工作区）时必须显式指定。
// 锁文件为 <root>/coordination/board.json.lock，因此指向同一 board 的多个进程仍共享同一把锁，互斥有效。
// 未设该变量时保持上游行为。
export const ROOT = process.env.WSC_ROOT
  ? path.resolve(process.env.WSC_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = { chatgpt: 'planner', ds: 'planner', workbuddy: 'executor', trae: 'executor', qoder: 'executor' };
const STATES = ['draft', 'approved', 'in-progress', 'awaiting-acceptance', 'accepted', 'cancelled'];
const FIELDS = {
  list: [], get: ['id'], create: ['id', 'title', 'requirements', 'acceptance', 'allowedPaths', 'owner'],
  approve: ['id'], renew: ['id', 'note', 'previousApprovalAt', 'previousClaimAt'], cancel: ['id', 'note'], claim: ['id'], submit: ['id', 'summary', 'evidence'], accept: ['id', 'note'], return: ['id', 'note'],
};
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 50000) throw new Error(`${label} 必须是非空文本（最多 50000 字符）`);
  return value;
};
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const idCheck = id => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) throw new Error('非法任务 ID');
};
const listCheck = (value, label) => {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`${label} 必须至少有一项（最多 100 项）`);
  value.forEach(item => text(item, label));
};

function validatePathSyntax(value) {
  text(value, '允许路径');
  if (value.includes('\\') || /[:*?\x00-\x1f]/.test(value) || path.posix.isAbsolute(value) || value.split('/').some(s => s === '.' || s === '..') || value === '/' || !value.replace(/\/$/, '')) throw new Error('允许路径须为仓库内相对路径，不能含遍历、盘符、反斜杠或通配符');
}
export async function validateAllowedPath(root, value) {
  validatePathSyntax(value);
  const base = await realpath(root);
  let candidate = path.resolve(root, value);
  // Resolve the nearest existing ancestor so a junction/symlink cannot escape the root.
  while (true) {
    try { candidate = await realpath(candidate); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(candidate); if (parent === candidate) throw error; candidate = parent; }
  }
  const relative = path.relative(base, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('允许路径通过链接越出仓库');
  return value;
}

function pathsOverlap(left, right) {
  const normalize = value => {
    const normalized = path.posix.normalize(value).replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const leftPath = normalize(left), rightPath = normalize(right);
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

function tasksConflict(left, right) {
  return left.owner === right.owner || left.allowedPaths.some(held => right.allowedPaths.some(candidate => pathsOverlap(held, candidate)));
}

// _testIo is available only to direct module tests; CLI/MCP never accept I/O overrides.
export function createHub({ root = ROOT, client, _testIo = {} } = {}) {
  if (!Object.hasOwn(ROLES, client)) throw new Error('身份必须为 chatgpt、ds、workbuddy、trae 或 qoder');
  const boardPath = path.join(root, 'coordination/board.json');
  const role = ROLES[client];
  async function readBoard() {
    const board = JSON.parse(await readFile(boardPath, 'utf8'));
    if (board.version !== 1 || !Array.isArray(board.tasks)) throw new Error('队列格式无效');
    const ids = new Set();
    for (const task of board.tasks) {
      idCheck(task.id);
      if (ids.has(task.id) || !STATES.includes(task.status) || ROLES[task.owner] !== 'executor') throw new Error('队列含非法任务、重复 ID 或状态');
      ids.add(task.id);
      text(task.title, '标题'); text(task.requirements, '需求');
      listCheck(task.acceptance, '验收'); listCheck(task.allowedPaths, '允许路径');
      for (const entry of task.allowedPaths) validatePathSyntax(entry);
      if (['awaiting-acceptance', 'accepted'].includes(task.status)) { text(task.summary, '交付摘要'); listCheck(task.evidence, '证据'); }
      if (!Array.isArray(task.history)) throw new Error('队列缺少历史');
      if (task.status === 'cancelled') {
        const cancellation = task.history.at(-1);
        if (!cancellation || cancellation.action !== 'cancel' || ROLES[cancellation.client] !== 'planner' || !timestamp(cancellation.at)) {
          throw new Error('已取消任务缺少可审计的取消记录');
        }
        text(cancellation.note, '取消说明');
      }
    }
    const active = board.tasks.filter(t => t.status === 'in-progress');
    for (let index = 0; index < active.length; index++) {
      if (active.slice(index + 1).some(task => tasksConflict(active[index], task))) throw new Error('队列存在同一执行端或路径重叠的并发任务');
    }
    return board;
  }
  async function update(change) {
    let lock;
    const lockPath = `${boardPath}.lock`;
    for (let attempt = 0; ; attempt++) {
      try { lock = await open(lockPath, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST' || attempt >= 20) {
          if (error.code === 'EEXIST') throw new Error('队列正在写入或遗留锁待人工核查；请稍后重试');
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 5 + attempt * 5));
      }
    }
    const temp = `${boardPath}.${randomUUID()}.tmp`;
    let primaryFailure;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, client, at: new Date().toISOString() }));
      const board = await readBoard();
      const result = await change(board);
      const file = await open(temp, 'wx');
      try { await file.writeFile(`${JSON.stringify(board, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
      // Windows readers may briefly hold a handle that prevents replacement.
      // Retry replacement under the same lock; never truncate/unlink the old board.
      for (let attempt = 0; ; attempt++) {
        try { await (_testIo.rename ?? rename)(temp, boardPath); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 + attempt * 5));
        }
      }
      return result;
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanupFailures = [];
      for (const cleanup of [
        () => (_testIo.unlink ?? unlink)(temp),
        () => lock.close(),
        () => (_testIo.unlink ?? unlink)(lockPath),
      ]) {
        try { await cleanup(); }
        catch (error) { if (error.code !== 'ENOENT') cleanupFailures.push(error); }
      }
      if (!primaryFailure && cleanupFailures.length) throw new AggregateError(cleanupFailures, '持久化完成，但清理失败；请核查遗留运行文件');
    }
  }
  const actions = role === 'planner' ? ['list', 'get', 'create', 'approve', 'renew', 'cancel', 'accept', 'return'] : ['list', 'get', 'claim', 'submit'];
  async function run(action, args = {}) {
    if (!actions.includes(action)) throw new Error(`身份 ${client} 无权执行 ${action}`);
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !FIELDS[action].includes(key))) throw new Error('非法参数；不能在调用中覆盖身份');
    if (action !== 'list') idCheck(args.id);
    if (action === 'list') return { client, role, root, ...(await readBoard()) };
    if (action === 'get') { const task = (await readBoard()).tasks.find(t => t.id === args.id); if (!task) throw new Error('任务不存在'); return task; }
    return update(async board => {
      const timestamp = new Date().toISOString();
      let task = board.tasks.find(t => t.id === args.id);
      if (action === 'create') {
        if (task) throw new Error('任务 ID 已存在');
        text(args.title, '标题'); text(args.requirements, '需求'); listCheck(args.acceptance, '验收'); listCheck(args.allowedPaths, '允许路径');
        if (ROLES[args.owner] !== 'executor') throw new Error('负责人须为 workbuddy、trae 或 qoder');
        for (const entry of args.allowedPaths) await validateAllowedPath(root, entry);
        task = { ...args, status: 'draft', history: [] }; board.tasks.push(task);
      } else {
        if (!task) throw new Error('任务不存在');
        const expected = action === 'renew' ? ['approved', 'in-progress'] : [{ approve: 'draft', cancel: 'in-progress', claim: 'approved', submit: 'in-progress', accept: 'awaiting-acceptance', return: 'awaiting-acceptance' }[action]];
        if (!expected.includes(task.status)) throw new Error(`${action} 需要 ${expected.join('/')} 状态，当前为 ${task.status}`);
        if (action === 'renew') {
          text(args.note, '恢复说明');
          const previous = [...task.history].reverse().find(event => ['approve', 'return'].includes(event.action));
          if (previous?.at !== text(args.previousApprovalAt, '原批准时间')) throw new Error('原批准已变化；停止恢复');
          if (!task.id.startsWith('TRANSPORT-')) throw new Error('renew 仅用于未完成运输任务；须先核对原生取消证据');
          const claim = [...task.history].reverse().find(event => event.action === 'claim');
          if (task.status === 'in-progress' && (claim?.client !== task.owner || claim?.at !== text(args.previousClaimAt, '原领取时间'))) throw new Error('原领取已变化；停止恢复');
          if (task.status === 'approved' && args.previousClaimAt !== undefined) throw new Error('当前未领取；停止恢复');
          task.history.push({ action: 'renew', client, at: timestamp, note: args.note, fromStatus: task.status, ...(args.previousClaimAt ? { previousClaimAt: args.previousClaimAt } : {}) });
        }
        if (role === 'executor' && task.owner !== client) throw new Error('只能领取或提交本人任务');
        if (['approve', 'renew', 'claim'].includes(action)) for (const entry of task.allowedPaths) await validateAllowedPath(root, entry);
        if (action === 'claim' && board.tasks.some(t => t.status === 'in-progress' && tasksConflict(t, task))) throw new Error('已有同一执行端或路径重叠任务；请等待其完成');
        if (action === 'claim' && board.tasks.some(t => t.status === 'awaiting-acceptance' && t.allowedPaths.some(held => task.allowedPaths.some(candidate => pathsOverlap(held, candidate))))) throw new Error('允许路径与待验收任务重叠；请先完成该任务验收');
        if (action === 'submit') { text(args.summary, '交付摘要'); listCheck(args.evidence, '证据'); task.summary = args.summary; task.evidence = [...args.evidence]; }
        if (action === 'cancel') text(args.note, '取消说明');
        if (action === 'accept' || action === 'return') text(args.note, '验收说明');
        task.status = { approve: 'approved', renew: 'approved', cancel: 'cancelled', claim: 'in-progress', submit: 'awaiting-acceptance', accept: 'accepted', return: 'approved' }[action];
      }
      task.updatedAt = timestamp;
      task.history.push({ action: action === 'renew' ? 'approve' : action, client, at: timestamp, ...(args.note ? { note: args.note } : {}), ...(action === 'submit' ? { summary: args.summary, evidence: [...args.evidence] } : {}) });
      return task;
    });
  }
  return { client, role, root, actions, run, readBoard };
}

const schemas = {
  id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$' },
  title: { type: 'string', minLength: 1 }, requirements: { type: 'string', minLength: 1 },
  owner: { type: 'string', enum: ['workbuddy', 'trae', 'qoder'] }, summary: { type: 'string', minLength: 1 }, note: { type: 'string', minLength: 1 },
  acceptance: { type: 'array', minItems: 1, items: { type: 'string' } }, allowedPaths: { type: 'array', minItems: 1, items: { type: 'string' } }, evidence: { type: 'array', minItems: 1, items: { type: 'string' } }, previousApprovalAt: { type: 'string', minLength: 1 }, previousClaimAt: { type: 'string', minLength: 1 },
};
export function toolList(hub) {
  const descriptions = { list: '读取共享队列与固定身份', get: '读取任务包', create: '创建草稿（不能直接开始）', approve: '批准草稿', renew: '核实原生取消后续办未完成运输，保留历史且需说明', cancel: '规划端隔离陈旧或明确取消的进行中任务', claim: '领取本人批准任务，同一端或重叠路径互斥', submit: '提交摘要和证据，等待规划端验收', accept: '据证据验收通过，需说明', return: '退回修改，需说明' };
  return hub.actions.map(action => ({ name: `wsc_${action}`, description: descriptions[action], inputSchema: { type: 'object', properties: Object.fromEntries(FIELDS[action].map(key => [key, schemas[key]])), required: FIELDS[action], additionalProperties: false } }));
}
export async function handleRpc(hub, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: '非法 JSON-RPC 请求' } };
  if (!Object.hasOwn(message, 'id')) return null;
  const response = { jsonrpc: '2.0', id: message.id };
  try {
    if (message.method === 'initialize') response.result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wsc-hub', version: '1.0.0' } };
    else if (message.method === 'ping') response.result = {};
    else if (message.method === 'tools/list') response.result = { tools: toolList(hub) };
    else if (message.method === 'tools/call') {
      const name = message.params?.name;
      try {
        if (typeof name !== 'string' || !name.startsWith('wsc_')) throw new Error('未知工具');
        const data = await hub.run(name.slice(4), message.params?.arguments ?? {});
        response.result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) { response.result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else response.error = { code: -32601, message: '未知 MCP 方法' };
  } catch (error) { response.error = { code: -32603, message: error.message }; }
  return response;
}
export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const identity = args.indexOf('--client');
  const client = identity >= 0 ? args.splice(identity, 2)[1] : process.env.WSC_CLIENT;
  const hub = createHub({ client });
  const mode = args.shift();
  if (mode === 'mcp' && args.length === 0) {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let result;
      try { result = await handleRpc(hub, JSON.parse(line)); }
      catch { result = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }; }
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    return;
  }
  if (!mode || args.length > 1) throw new Error('用法：node tools/wsc-hub.mjs --client chatgpt|ds|workbuddy|trae|qoder mcp|list|get|create|approve|renew|cancel|claim|submit|accept|return [JSON]');
  process.stdout.write(`${JSON.stringify(await hub.run(mode, args.length ? JSON.parse(args[0]) : {}), null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
