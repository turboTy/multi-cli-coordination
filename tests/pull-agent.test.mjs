import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../tools/wsc-hub.mjs';
import { approvalKey, ledgerFile, parseArgs, runPull, selectTasks } from '../tools/pull-agent.mjs';

const PULL_AGENT = fileURLToPath(new URL('../tools/pull-agent.mjs', import.meta.url));

// 子进程跑 CLI：成功路径下 execFile 不返回退出码，这里统一拿到真实 code。
function runAgent(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PULL_AGENT, ...args], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

const task = (overrides = {}) => ({
  id: 'U4-DEMO-001',
  title: '示例任务',
  requirements: '示例需求',
  acceptance: ['示例验收'],
  allowedPaths: ['artifacts/u4/'],
  owner: 'qoder',
  status: 'approved',
  history: [{ action: 'create', client: 'ds', at: '2026-10-09T10:00:00.000Z' }, { action: 'approve', client: 'ds', at: '2026-10-09T10:00:01.000Z' }],
  ...overrides,
});

async function workspace(tasks) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcc-pull-'));
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  const board = path.join(root, 'coordination/board.json');
  await fs.writeFile(board, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`);
  return { root, home: path.join(root, 'bridge-home'), board };
}

const writeBoard = async (board, tasks) => fs.writeFile(board, `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`);
const sha256 = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = async file => fs.access(file).then(() => true, () => false);
const recorder = () => {
  const calls = [];
  return { calls, deliver: async delivered => { calls.push(delivered.id); } };
};
const byId = summary => Object.fromEntries(summary.results.map(result => [result.id, result]));

test('parseArgs 只接受执行端身份，并要求唯一轮询模式', () => {
  assert.deepEqual(parseArgs(['--client', 'qoder', '--once']), { client: 'qoder', mode: 'once', dryRun: false, transport: null, intervalMs: 15000 });
  assert.equal(parseArgs(['--client', 'trae', '--watch', '--dry-run', '--transport', './t.mjs']).dryRun, true);
  assert.throws(() => parseArgs(['--client', 'ds', '--once']), /qoder、trae 或 workbuddy/);
  assert.throws(() => parseArgs(['--client', 'qoder']), /必须指定 --once 或 --watch/);
  assert.throws(() => parseArgs(['--client', 'qoder', '--once', '--watch']), /只能二选一/);
  assert.throws(() => parseArgs(['--client', 'qoder', '--once', '--nope']), /未知参数/);
});

test('approvalKey 以最近一次 approve/return 为版本，缺失即报错', () => {
  const approved = approvalKey(task());
  assert.match(approved, /^[0-9a-f]{64}$/);
  const returned = task({ history: [{ action: 'return', client: 'ds', at: '2026-10-09T11:00:00.000Z' }] });
  assert.notEqual(approvalKey(returned), approved);
  assert.throws(() => approvalKey(task({ history: [] })), /缺少可审计的批准历史/);
});

test('selectTasks 只取本人 approved/dispatched 任务', () => {
  const tasks = [
    task(),
    task({ id: 'U4-DISP', status: 'dispatched' }),
    task({ id: 'U4-OTHER', owner: 'trae' }),
    task({ id: 'U4-DRAFT', status: 'draft' }),
    task({ id: 'U4-RUN', status: 'in-progress' }),
    task({ id: 'U4-WAIT', status: 'awaiting-acceptance', summary: 's', evidence: ['e'] }),
    task({ id: 'U4-DONE', status: 'accepted', summary: 's', evidence: ['e'] }),
  ];
  assert.deepEqual(selectTasks(tasks, 'qoder').map(t => t.id), ['U4-DEMO-001', 'U4-DISP']);
});

test('--dry-run 零写入：不投递、不 claim、不建台账、队列哈希不变', async () => {
  const { root, home, board } = await workspace([task()]);
  const before = await sha256(board);
  const transport = recorder();
  const summary = await runPull({ client: 'qoder', hub: createHub({ root, client: 'qoder' }), home, transport, dryRun: true });
  assert.equal(summary.candidates, 1);
  assert.equal(summary.results[0].action, 'dry-run');
  assert.equal(summary.results[0].status, 'approved');
  assert.deepEqual(transport.calls, []);
  assert.equal(await exists(ledgerFile(home, 'qoder')), false);
  assert.equal(await sha256(board), before);
  assert.equal((await createHub({ root, client: 'qoder' }).run('get', { id: 'U4-DEMO-001' })).status, 'approved');
});

test('真实队列：投递成功后以自身身份 claim，并写台账', async () => {
  const { root, home } = await workspace([task(), task({ id: 'U4-OTHER', owner: 'trae' })]);
  const transport = recorder();
  const summary = await runPull({ client: 'qoder', hub: createHub({ root, client: 'qoder' }), home, transport });
  assert.deepEqual(transport.calls, ['U4-DEMO-001']);
  assert.equal(summary.results[0].action, 'delivered');
  assert.equal(summary.results[0].status, 'in-progress');
  const claimed = await createHub({ root, client: 'qoder' }).run('get', { id: 'U4-DEMO-001' });
  assert.equal(claimed.status, 'in-progress');
  assert.equal(claimed.history.at(-1).action, 'claim');
  assert.equal(claimed.history.at(-1).client, 'qoder');
  assert.equal((await createHub({ root, client: 'trae' }).run('get', { id: 'U4-OTHER' })).status, 'approved');
  const ledger = JSON.parse(await fs.readFile(ledgerFile(home, 'qoder'), 'utf8'));
  assert.deepEqual(ledger.entries.map(e => e.id), ['U4-DEMO-001']);
});

test('幂等：同一 task.id + approvalKey 命中台账即拦住，不再调用传输', async () => {
  const { root, home, board } = await workspace([task()]);
  const key = approvalKey(task());
  await fs.mkdir(path.dirname(ledgerFile(home, 'qoder')), { recursive: true });
  await fs.writeFile(ledgerFile(home, 'qoder'), `${JSON.stringify({ version: 1, entries: [{ id: 'U4-DEMO-001', approvalKey: key, at: '2026-10-09T10:05:00.000Z' }] }, null, 2)}\n`);
  const transport = recorder();
  const hub = createHub({ root, client: 'qoder' });
  const blocked = await runPull({ client: 'qoder', hub, home, transport });
  assert.equal(blocked.results[0].action, 'duplicate-prevented');
  assert.equal(blocked.results[0].approvalKey, key);
  assert.deepEqual(transport.calls, []);
  assert.equal((await hub.run('get', { id: 'U4-DEMO-001' })).status, 'approved');

  // 退回并重新批准 → 新 approvalKey → 允许再投一次
  await writeBoard(board, [task({ history: [...task().history, { action: 'claim', client: 'qoder', at: '2026-10-09T11:30:00.000Z' }, { action: 'return', client: 'ds', at: '2026-10-09T11:31:00.000Z' }] })]);
  const retried = await runPull({ client: 'qoder', hub, home, transport });
  assert.equal(retried.results[0].action, 'delivered');
  assert.deepEqual(transport.calls, ['U4-DEMO-001']);
  assert.notEqual(retried.results[0].approvalKey, key);
  const ledger = JSON.parse(await fs.readFile(ledgerFile(home, 'qoder'), 'utf8'));
  assert.deepEqual(ledger.entries.map(e => e.approvalKey), [key, retried.results[0].approvalKey]);
});

test('claim 失败不得回滚台账：已投递任务不会被重投', async () => {
  const { root, home } = await workspace([task({ id: 'U4-A' }), task({ id: 'U4-B' })]);
  const transport = recorder();
  const hub = createHub({ root, client: 'qoder' });
  const first = await runPull({ client: 'qoder', hub, home, transport });
  assert.deepEqual(transport.calls, ['U4-A', 'U4-B']);
  assert.equal(byId(first)['U4-A'].action, 'delivered');
  assert.equal(byId(first)['U4-B'].action, 'delivered-claim-failed');
  assert.match(byId(first)['U4-B'].error, /已有同一执行端或路径重叠任务/);
  const ledger = JSON.parse(await fs.readFile(ledgerFile(home, 'qoder'), 'utf8'));
  assert.deepEqual(ledger.entries.map(e => e.id), ['U4-A', 'U4-B']);

  const second = await runPull({ client: 'qoder', hub, home, transport });
  assert.deepEqual(transport.calls, ['U4-A', 'U4-B']);
  assert.deepEqual(second.results.map(r => [r.id, r.action]), [['U4-B', 'duplicate-prevented']]);
});

test('投递抛错：记为 delivery-failed，不写台账，队列状态不变', async () => {
  const { root, home } = await workspace([task()]);
  const hub = createHub({ root, client: 'qoder' });
  const summary = await runPull({ client: 'qoder', hub, home, transport: { deliver: async () => { throw new Error('ROUTE_DEAD'); } } });
  assert.equal(summary.results[0].action, 'delivery-failed');
  assert.match(summary.results[0].error, /ROUTE_DEAD/);
  assert.equal(await exists(ledgerFile(home, 'qoder')), false);
  assert.equal((await hub.run('get', { id: 'U4-DEMO-001' })).status, 'approved');
});

test('CLI：未配置 --transport 时显式报错并非 0 退出、零写入', async () => {
  const { root, home, board } = await workspace([task()]);
  const before = await sha256(board);
  const result = await runAgent(['--client', 'qoder', '--once'], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /\[delivery-failed\] U4-DEMO-001/);
  assert.match(result.stdout, /未配置传输层：任务 U4-DEMO-001 无法投递，请传 --transport <模块路径>/);
  assert.equal(await exists(ledgerFile(home, 'qoder')), false);
  assert.equal(await sha256(board), before);
  assert.equal((await createHub({ root, client: 'qoder' }).run('get', { id: 'U4-DEMO-001' })).status, 'approved');
});

test('CLI：--dry-run 对真实队列零写入，注入传输后正常投递', async () => {
  const { root, home, board } = await workspace([task()]);
  const before = await sha256(board);
  const dry = await runAgent(['--client', 'qoder', '--once', '--dry-run'], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /\[dry-run\] U4-DEMO-001 \(approved\)/);
  assert.equal(await exists(ledgerFile(home, 'qoder')), false);
  assert.equal(await sha256(board), before);

  const transportFile = path.join(root, 'stub-transport.mjs');
  await fs.writeFile(transportFile, 'export async function deliver(task, ctx) { return `${task.id}:${ctx.client}`; }\n');
  const live = await runAgent(['--client', 'qoder', '--once', '--transport', transportFile], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(live.code, 0);
  assert.match(live.stdout, /\[delivered\] U4-DEMO-001/);
  assert.equal((await createHub({ root, client: 'qoder' }).run('get', { id: 'U4-DEMO-001' })).status, 'in-progress');
  assert.equal(await exists(ledgerFile(home, 'qoder')), true);
});

test('CLI：传输模块缺少 deliver 导出时拒绝启动并非 0 退出', async () => {
  const { root, home, board } = await workspace([task()]);
  const before = await sha256(board);
  const bad = path.join(root, 'bad-transport.mjs');
  await fs.writeFile(bad, 'export const deliver = 1;\n');
  const result = await runAgent(['--client', 'qoder', '--once', '--transport', bad], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /必须导出 async function deliver/);
  assert.equal(await exists(ledgerFile(home, 'qoder')), false);
  assert.equal(await sha256(board), before);
});

test('CLI：非法身份与非正轮询间隔直接拒绝', async () => {
  const { root, home } = await workspace([task()]);
  const bad = await runAgent(['--client', 'ds', '--once'], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--client 必须为 qoder、trae 或 workbuddy/);
  const interval = await runAgent(['--client', 'qoder', '--watch', '--interval', '0'], { WSC_ROOT: root, WSC_BRIDGE_HOME: home });
  assert.equal(interval.code, 1);
  assert.match(interval.stderr, /--interval 必须是正数毫秒/);
});
