#!/usr/bin/env node
// U4：pull 型执行端 agent（契约正本 docs/routing-contract-v1.md §4）。
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHub, ROOT } from './wsc-hub.mjs';

const EXECUTORS = ['qoder', 'trae', 'workbuddy'];
const PULL_STATES = ['approved', 'dispatched'];

// 契约 §4 禁止 import desktop-dispatch.mjs，故此处复刻同一键算法；改一边必须同步另一边。
export function approvalKey(task) {
  const last = [...(Array.isArray(task.history) ? task.history : [])].reverse().find(entry => entry.action === 'approve' || entry.action === 'return');
  if (!last || typeof last.at !== 'string') throw new Error(`任务 ${task.id} 缺少可审计的批准历史`);
  return createHash('sha256').update(`${task.id}:${last.at}`).digest('hex');
}

export function resolveBridgeHome(env = process.env) {
  return env.WSC_BRIDGE_HOME ? path.resolve(env.WSC_BRIDGE_HOME) : path.join(os.homedir(), '.local/share/wsc-hub/desktop-bridge');
}

export function ledgerFile(home, client) { return path.join(home, 'pull-agent', `${client}.json`); }

async function readLedger(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: [] }; throw error; }
  const parsed = JSON.parse(raw);
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('投递台账格式无效');
  return parsed;
}

async function writeLedger(file, ledger) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(`${JSON.stringify(ledger, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, file);
}

export function selectTasks(tasks, client) {
  return tasks.filter(task => task.owner === client && PULL_STATES.includes(task.status));
}

// 默认传输：显式报错的占位实现——宁可失败，不静默假装成功。
export const defaultTransport = {
  async deliver(task) {
    throw new Error(`未配置传输层：任务 ${task.id} 无法投递，请传 --transport <模块路径>`);
  },
};

export async function loadTransport(spec) {
  const file = path.resolve(spec);
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.deliver !== 'function') throw new Error(`传输模块 ${file} 必须导出 async function deliver(task, ctx)`);
  return { deliver: mod.deliver };
}

export async function runPull({ client, hub, home, transport = defaultTransport, dryRun = false, log = () => {} } = {}) {
  if (!EXECUTORS.includes(client)) throw new Error('--client 必须为 qoder、trae 或 workbuddy');
  const board = await hub.run('list');
  const candidates = selectTasks(Array.isArray(board.tasks) ? board.tasks : [], client);
  const file = ledgerFile(home, client);
  const ledger = await readLedger(file);
  const results = [];
  for (const task of candidates) {
    let key;
    try { key = approvalKey(task); }
    catch (error) { results.push({ id: task.id, action: 'invalid', error: error.message }); continue; }
    if (ledger.entries.some(entry => entry.id === task.id && entry.approvalKey === key)) {
      results.push({ id: task.id, action: 'duplicate-prevented', approvalKey: key });
      continue;
    }
    if (dryRun) {
      results.push({ id: task.id, action: 'dry-run', status: task.status, title: task.title, approvalKey: key });
      continue;
    }
    try { await transport.deliver(task, { client, hub, home, approvalKey: key, dryRun: false }); }
    catch (error) { results.push({ id: task.id, action: 'delivery-failed', approvalKey: key, error: error.message }); continue; }
    // 先落台账再 claim：claim 失败也不得回头重投同一 approvalKey。
    ledger.entries.push({ id: task.id, approvalKey: key, at: new Date().toISOString() });
    await writeLedger(file, ledger);
    try {
      const claimed = await hub.run('claim', { id: task.id });
      results.push({ id: task.id, action: 'delivered', approvalKey: key, status: claimed.status });
    } catch (error) {
      results.push({ id: task.id, action: 'delivered-claim-failed', approvalKey: key, error: error.message });
    }
  }
  for (const result of results) log(result.action === 'dry-run' ? `[dry-run] ${result.id} (${result.status})` : `[${result.action}] ${result.id}`);
  return { client, dryRun, scanned: Array.isArray(board.tasks) ? board.tasks.length : 0, candidates: candidates.length, results };
}

export function parseArgs(argv) {
  const out = { client: null, mode: null, dryRun: false, transport: null, intervalMs: 15000 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--client') out.client = argv[++index];
    else if (arg === '--once' || arg === '--watch') {
      if (out.mode) throw new Error('--once 与 --watch 只能二选一');
      out.mode = arg === '--once' ? 'once' : 'watch';
    }
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--transport') out.transport = argv[++index];
    else if (arg === '--interval') out.intervalMs = Number(argv[++index]);
    else throw new Error(`未知参数：${arg}`);
  }
  if (!EXECUTORS.includes(out.client)) throw new Error('--client 必须为 qoder、trae 或 workbuddy');
  if (out.mode !== 'once' && out.mode !== 'watch') throw new Error('必须指定 --once 或 --watch');
  if (!Number.isFinite(out.intervalMs) || out.intervalMs <= 0) throw new Error('--interval 必须是正数毫秒');
  return out;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const failed = summary => summary.results.some(result => !['dry-run', 'duplicate-prevented', 'delivered'].includes(result.action));

export async function main(argv = process.argv.slice(2), { log = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  const options = parseArgs(argv);
  const hub = createHub({ client: options.client });
  const transport = options.transport ? await loadTransport(options.transport) : defaultTransport;
  const home = resolveBridgeHome();
  for (;;) {
    const summary = await runPull({ client: options.client, hub, home, transport, dryRun: options.dryRun, log });
    log(JSON.stringify(summary, null, 2));
    if (options.mode !== 'watch') return failed(summary) ? 1 : 0;
    if (failed(summary)) fail('本轮存在失败投递；watch 继续轮询，不自动重发同一 approvalKey');
    await sleep(options.intervalMs);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export { ROOT };
