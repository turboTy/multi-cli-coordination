import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub, toolList } from '../tools/wsc-hub.mjs';

// 每个用例独立的临时队列根，绝不触碰真实 coordination/board.json。
async function freshRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'wsc-hub-test-'));
  await mkdir(path.join(root, 'coordination'), { recursive: true });
  await writeFile(path.join(root, 'coordination', 'board.json'), `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`);
  return root;
}

const hub = (root, client) => createHub({ root, client });
const ds = root => hub(root, 'ds');

// 建一个已批准（approved）的任务，返回创建与批准后的 planner 句柄。
async function approvedTask(root, { id = 'U1-T1', owner = 'trae', allowedPaths = ['artifacts/u1/'] } = {}) {
  const planner = ds(root);
  await planner.run('create', { id, title: `${id} 标题`, requirements: `${id} 需求`, acceptance: ['验收项一'], allowedPaths, owner });
  await planner.run('approve', { id });
  return planner;
}

const sent = (root, id, channel = 'mcc-ds-trae') => ds(root).run('dispatch', { id, channel, state: 'sent' });
const timestampLike = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

// —— 契约 §1.5 之一：ds 身份可 create/approve/accept ——
test('ds 身份可完成 create/approve/accept 的规划端闭环', async () => {
  const root = await freshRoot();
  const planner = ds(root);
  for (const action of ['create', 'approve', 'accept']) assert.ok(planner.actions.includes(action), `ds 应有权执行 ${action}`);
  await approvedTask(root);
  const owner = hub(root, 'trae');
  assert.equal((await owner.run('get', { id: 'U1-T1' })).status, 'approved');
  await owner.run('claim', { id: 'U1-T1' });
  await owner.run('submit', { id: 'U1-T1', summary: '交付摘要', evidence: ['命令与退出码'] });
  const accepted = await planner.run('accept', { id: 'U1-T1', note: '证据齐备，通过' });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.history.at(-1).action, 'accept');
  assert.equal(accepted.history.at(-1).client, 'ds');
});

// —— 契约 §1.5 之二：qoder 调 dispatch 被拒（含全部执行端与身份覆盖）——
test('执行端身份调用 dispatch 一律被拒，且不能在参数里覆盖身份', async () => {
  const root = await freshRoot();
  await approvedTask(root, { owner: 'qoder' });
  for (const client of ['qoder', 'trae', 'workbuddy']) {
    assert.ok(!hub(root, client).actions.includes('dispatch'), `${client} 不应具备 dispatch 权限`);
    await assert.rejects(hub(root, client).run('dispatch', { id: 'U1-T1', channel: 'mcc-x', state: 'sent' }), /无权执行 dispatch/);
  }
  // 规划端同样不能借参数改写归属身份：client/role/owner/status 都不在 FIELDS.dispatch 内。
  for (const key of ['client', 'role', 'owner', 'status']) {
    await assert.rejects(ds(root).run('dispatch', { id: 'U1-T1', channel: 'mcc-x', state: 'sent', [key]: 'qoder' }), /非法参数；不能在调用中覆盖身份/);
  }
  assert.equal((await ds(root).run('get', { id: 'U1-T1' })).status, 'approved');
});

// —— 契约 §1.5 之三：approved → dispatched → in-progress 全链路 ——
test('approved → dispatched → in-progress 全链路，delivery 与 nonce 符合 §1.2/§1.3', async () => {
  const root = await freshRoot();
  await approvedTask(root);
  const approvalAt = (await ds(root).run('get', { id: 'U1-T1' })).history.find(e => e.action === 'approve').at;
  const dispatched = await sent(root, 'U1-T1');
  assert.equal(dispatched.status, 'dispatched');
  assert.match(dispatched.nonce, /^MCC-ACK-[0-9a-f]{8}$/);
  assert.deepEqual(dispatched.delivery, {
    state: 'sent',
    channel: 'mcc-ds-trae',
    attempts: 1,
    at: dispatched.delivery.at,
    by: 'ds',
    approvalKey: createHash('sha256').update(`U1-T1:${approvalAt}`).digest('hex'),
    error: null,
  });
  assert.ok(timestampLike(dispatched.delivery.at));
  const last = dispatched.history.at(-1);
  assert.deepEqual({ action: last.action, client: last.client, channel: last.channel, state: last.state }, { action: 'dispatch', client: 'ds', channel: 'mcc-ds-trae', state: 'sent' });
  const claimed = await hub(root, 'trae').run('claim', { id: 'U1-T1' });
  assert.equal(claimed.status, 'in-progress');
  assert.equal(claimed.nonce, dispatched.nonce, 'claim 不得改写 nonce');
});

// —— 契约 §1.5 之四：not-sent 后 status 仍为 approved（uncertain / duplicate-prevented 同）——
test('not-sent / uncertain / duplicate-prevented 保持 approved，但仍写 delivery', async () => {
  const root = await freshRoot();
  await approvedTask(root);
  const first = await ds(root).run('dispatch', { id: 'U1-T1', channel: 'mcc-ds-trae', state: 'not-sent', error: '管道未就绪' });
  assert.equal(first.status, 'approved');
  assert.equal(first.delivery.state, 'not-sent');
  assert.equal(first.delivery.attempts, 1);
  assert.equal(first.delivery.error, '管道未就绪');
  assert.match(first.nonce, /^MCC-ACK-[0-9a-f]{8}$/, 'nonce 在首次 dispatch 即生成');
  const second = await ds(root).run('dispatch', { id: 'U1-T1', channel: 'mcc-ds-trae', state: 'uncertain', error: '投递超时，结果未知' });
  assert.equal(second.status, 'approved');
  assert.equal(second.delivery.attempts, 2, 'delivery 记录最后一次尝试，attempts 递增');
  assert.equal(second.nonce, first.nonce, 'nonce 一经写入不再重新生成');
  const third = await ds(root).run('dispatch', { id: 'U1-T1', channel: 'mcc-ds-trae', state: 'duplicate-prevented', error: '命中 approvalKey 幂等' });
  assert.equal(third.status, 'approved');
  assert.equal(third.delivery.attempts, 3);
  await assert.rejects(ds(root).run('dispatch', { id: 'U1-T1', channel: 'mcc-ds-trae', state: 'shipped' }), /投递状态必须为/);
});

// —— 契约 §1.5 之五：nonce 写入后执行端 submit 不能改写 ——
test('执行端 submit 无法改写 nonce：传入该字段即被拒，正常提交后原值不变', async () => {
  const root = await freshRoot();
  await approvedTask(root);
  const before = await sent(root, 'U1-T1');
  const executor = hub(root, 'trae');
  await executor.run('claim', { id: 'U1-T1' });
  await assert.rejects(
    executor.run('submit', { id: 'U1-T1', summary: '交付摘要', evidence: ['证据'], nonce: 'MCC-ACK-deadbeef' }),
    /非法参数；不能在调用中覆盖身份/,
  );
  // 整表校验也拒绝任何非法 nonce，堵住“绕过 run 直接改文件”的路径。
  const after = await executor.run('submit', { id: 'U1-T1', summary: '交付摘要', evidence: ['证据'] });
  assert.equal(after.status, 'awaiting-acceptance');
  assert.equal(after.nonce, before.nonce);
  const accepted = await ds(root).run('accept', { id: 'U1-T1', note: 'nonce 未被改动' });
  assert.equal(accepted.nonce, before.nonce);
});

// —— 契约 §1.5 之六：dispatched 与 in-progress 互斥判定生效 ——
test('dispatched 与 in-progress 一并视为在途，双向阻塞重叠任务', async () => {
  const root = await freshRoot();
  // dispatched 阻塞他人领取路径重叠的任务
  await approvedTask(root, { id: 'U1-A', owner: 'trae', allowedPaths: ['artifacts/shared/'] });
  await sent(root, 'U1-A');
  await approvedTask(root, { id: 'U1-B', owner: 'qoder', allowedPaths: ['artifacts/shared/nested/'] });
  await assert.rejects(hub(root, 'qoder').run('claim', { id: 'U1-B' }), /已有同一执行端或路径重叠任务；请等待其完成/);
  // in-progress 阻塞对重叠任务的再次投递
  await hub(root, 'trae').run('claim', { id: 'U1-A' });
  await assert.rejects(ds(root).run('dispatch', { id: 'U1-B', channel: 'mcc-ds-qoder', state: 'sent' }), /禁止重复投递/);
  // 反证：不重叠且不同执行端的在途任务互不阻塞
  await approvedTask(root, { id: 'U1-C', owner: 'workbuddy', allowedPaths: ['artifacts/other/'] });
  assert.equal((await hub(root, 'workbuddy').run('claim', { id: 'U1-C' })).status, 'in-progress');
  // 同一执行端的第二个任务即使在非在途状态也不得并行领取
  await approvedTask(root, { id: 'U1-D', owner: 'workbuddy', allowedPaths: ['artifacts/another/'] });
  await assert.rejects(hub(root, 'workbuddy').run('claim', { id: 'U1-D' }), /已有同一执行端或路径重叠任务；请等待其完成/);
});

// —— 契约 §1.5 之七：已取消任务仍能通过整表校验（回归保护）——
test('从 approved / dispatched / in-progress 取消后仍能通过整表校验', async () => {
  const root = await freshRoot();
  await approvedTask(root, { id: 'U1-X', owner: 'trae', allowedPaths: ['artifacts/x/'] });
  const cancelledFromApproved = await ds(root).run('cancel', { id: 'U1-X', note: '方向作废' });
  assert.equal(cancelledFromApproved.status, 'cancelled');
  await approvedTask(root, { id: 'U1-Y', owner: 'qoder', allowedPaths: ['artifacts/y/'] });
  await sent(root, 'U1-Y', 'mcc-ds-qoder');
  const cancelledFromDispatched = await ds(root).run('cancel', { id: 'U1-Y', note: '投递后作废' });
  assert.equal(cancelledFromDispatched.status, 'cancelled');
  await approvedTask(root, { id: 'U1-Z', owner: 'workbuddy', allowedPaths: ['artifacts/z/'] });
  await hub(root, 'workbuddy').run('claim', { id: 'U1-Z' });
  const cancelledFromInProgress = await ds(root).run('cancel', { id: 'U1-Z', note: '执行中作废' });
  assert.equal(cancelledFromInProgress.status, 'cancelled');
  // 三条取消记录都留在途任务之外，整表校验（list）必须通过，且携带 delivery/nonce 的已取消任务不被误判。
  const board = await ds(root).run('list', {});
  assert.deepEqual(board.tasks.map(t => [t.id, t.status]).sort(), [['U1-X', 'cancelled'], ['U1-Y', 'cancelled'], ['U1-Z', 'cancelled']].sort());
  const carried = board.tasks.find(t => t.id === 'U1-Y');
  assert.equal(carried.delivery.state, 'sent');
  assert.match(carried.nonce, /^MCC-ACK-[0-9a-f]{8}$/);
  for (const task of board.tasks) assert.equal(task.history.at(-1).action, 'cancel');
  // 取消态不可再被领取或投递
  await assert.rejects(hub(root, 'qoder').run('claim', { id: 'U1-Y' }), /claim 需要 approved\/dispatched 状态/);
  await assert.rejects(ds(root).run('dispatch', { id: 'U1-Y', channel: 'mcc-ds-qoder', state: 'sent' }), /dispatch 需要 approved 状态/);
});

// —— FIELDS 登记与 MCP 工具面（§1.4 要求 FIELDS 必须登记）——
test('dispatch 已登记进 planner 工具面，error 为可选入参', async () => {
  const root = await freshRoot();
  const names = toolList(ds(root)).map(tool => tool.name);
  assert.ok(names.includes('wsc_dispatch'), 'MCP 工具列表须含 wsc_dispatch');
  assert.ok(!toolList(hub(root, 'trae')).some(tool => tool.name === 'wsc_dispatch'), '执行端工具列表不得含 wsc_dispatch');
  const schema = toolList(ds(root)).find(tool => tool.name === 'wsc_dispatch').inputSchema;
  assert.deepEqual(schema.required, ['id', 'channel', 'state']);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['channel', 'error', 'id', 'state']);
  assert.deepEqual(schema.properties.state.enum, ['sent', 'not-sent', 'uncertain', 'duplicate-prevented']);
  assert.equal(schema.additionalProperties, false);
});
