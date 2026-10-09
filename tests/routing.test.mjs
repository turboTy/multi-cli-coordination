import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROOT, createHub } from '../tools/wsc-hub.mjs';
import { PRESENCE_TTL_MS, ROUTE_NOT_SENT, readPresence, resolveRoute, routeError } from '../tools/routing.mjs';
import { DEFAULT_PLANNER, dispatchTask } from '../tools/desktop-dispatch.mjs';

// 契约 §2 的验收测试：只碰临时目录与注入的假探针，绝不连真实桥、绝不派发。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOLS = path.join(HERE, '..', 'tools');
const ROOT_URL = ROOT.replaceAll('\\', '/');
const KEY = 'a'.repeat(64);
const COMMON_KEYS = ['busy', 'client', 'deployment', 'heartbeatAt', 'pipe', 'pid', 'reason', 'root', 'state'];
const STALE_KEYS = ['client', 'deployment', 'heartbeatAt', 'pid', 'pipe', 'reason', 'root', 'state'];

async function tempHome(label) { return fs.mkdtemp(path.join(os.tmpdir(), `routing-${label}-`)); }

async function writeEndpoint(home, client, overrides = {}) {
  const endpoint = { pipe: `\\\\.\\pipe\\wsc-${client}-test`, key: KEY, root: ROOT_URL, pid: 4242, ...overrides };
  await fs.writeFile(path.join(home, `${client}-endpoint.json`), JSON.stringify(endpoint));
  return endpoint;
}

function statusFor(client, overrides = {}) {
  return {
    client, version: '0.0.0-test', root: ROOT_URL, busy: false,
    ...(client === 'trae'
      ? { sessionBindingConfigured: true, sessionTitle: 'gpt-WSC', currentSessionId: 'session-same', targetSessionId: 'session-same' }
      : { hostConnected: true, conversationVerified: true, conversationId: 'conversation-1' }),
    ...overrides,
  };
}

async function routeFailure(options) {
  try { await resolveRoute(options); }
  catch (error) { return error; }
  throw new Error('预期路由解析失败，但返回成功');
}

async function approvedTaskHub(label) {
  const root = await tempHome(`${label}-root`);
  const home = await tempHome(`${label}-home`);
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination', 'board.json'), `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`);
  return { root, home, hub: createHub({ root, client: 'ds' }) };
}

async function makeTask(hub, id, owner = 'workbuddy', allowedPaths = ['tools/a.mjs']) {
  await hub.run('create', { id, title: `路由测试 ${id}`, requirements: '契约 §2 测试任务', acceptance: ['node --test tests/routing.test.mjs 全绿'], allowedPaths, owner });
  await hub.run('approve', { id });
}

function okCall(calls) {
  return async (action, id, { client }) => {
    calls.push({ action, id, client });
    return client === 'trae' ? { client, id, nativeInvocationReturned: true } : { client, id, nativeInvocationSent: true };
  };
}

const liveRoute = async ({ client }) => ({ client, state: 'live', cached: false, presence: { client, state: 'live', heartbeatAt: new Date().toISOString() } });

test('契约 §2.1：五类错误码与 notSent 映射逐字相符，ROUTE_BUSY 不得允许重发', () => {
  assert.deepEqual(ROUTE_NOT_SENT, {
    ROUTE_UNCONFIGURED: true, ROUTE_DEAD: true, ROUTE_SESSION_MISMATCH: true, ROUTE_UNVERIFIED: true, ROUTE_BUSY: false,
  });
  assert.equal(ROUTE_NOT_SENT.ROUTE_BUSY, false);
  for (const [code, notSent] of Object.entries(ROUTE_NOT_SENT)) {
    const error = routeError(code, `${code} 测试`);
    assert.equal(error.code, code);
    assert.equal(error.notSent, notSent);
  }
  assert.throws(() => routeError('ROUTE_MADE_UP', '未知码'), /未知路由错误码/);
});

test('ROUTE_UNCONFIGURED：endpoint 缺失或形状非法 → notSent=true，presence 记 stale', async () => {
  const home = await tempHome('unconfigured');
  const missing = await routeFailure({ client: 'trae', home });
  assert.equal(missing.code, 'ROUTE_UNCONFIGURED');
  assert.equal(missing.notSent, true);
  const presence = await readPresence(home, 'trae');
  assert.equal(presence.state, 'stale');
  assert.match(presence.reason, /^ROUTE_UNCONFIGURED: /);
  assert.equal(presence.pid, null);
  assert.equal(presence.pipe, null);
  assert.deepEqual(Object.keys(presence).sort(), STALE_KEYS);

  await writeEndpoint(home, 'trae', { key: 'short' });
  assert.equal((await routeFailure({ client: 'trae', home, forceProbe: true })).code, 'ROUTE_UNCONFIGURED');
  await writeEndpoint(home, 'trae', { key: KEY, pipe: '\\\\.\\pipe\\wsc-workbuddy-test' });
  assert.equal((await routeFailure({ client: 'trae', home, forceProbe: true })).code, 'ROUTE_UNCONFIGURED');
  await writeEndpoint(home, 'trae', { pipe: `\\\\.\\pipe\\wsc-trae-test`, root: 'D:/other-root' });
  const wrongRoot = await routeFailure({ client: 'trae', home, forceProbe: true });
  assert.equal(wrongRoot.code, 'ROUTE_UNCONFIGURED');
  assert.match(wrongRoot.message, /root 与项目根不符/);
});

test('ROUTE_DEAD：探测连接失败或响应不同源 → notSent=true，presence 留 reason', async () => {
  const home = await tempHome('dead');
  await writeEndpoint(home, 'workbuddy');
  const dead = await routeFailure({ client: 'workbuddy', home, probe: async () => { throw new Error('ECONNREFUSED 桥接未在线'); } });
  assert.equal(dead.code, 'ROUTE_DEAD');
  assert.equal(dead.notSent, true);
  const presence = await readPresence(home, 'workbuddy');
  assert.equal(presence.state, 'stale');
  assert.equal(presence.reason, 'ROUTE_DEAD: ECONNREFUSED 桥接未在线');
  assert.equal(presence.pid, 4242);
  assert.deepEqual(Object.keys(presence).sort(), STALE_KEYS);

  await writeEndpoint(home, 'trae');
  const offRoot = await routeFailure({ client: 'trae', home, forceProbe: true, probe: async () => statusFor('trae', { root: 'D:/other-root' }) });
  assert.equal(offRoot.code, 'ROUTE_DEAD');
  assert.match(offRoot.message, /不同源或形状非法/);
  const noBusy = await routeFailure({ client: 'trae', home, forceProbe: true, probe: async () => ({ client: 'trae', root: ROOT_URL }) });
  assert.equal(noBusy.code, 'ROUTE_DEAD');
});

test('ROUTE_SESSION_MISMATCH：trae currentSessionId 与 targetSessionId 不符 → notSent=true', async () => {
  const home = await tempHome('mismatch');
  await writeEndpoint(home, 'trae');
  const error = await routeFailure({
    client: 'trae', home,
    probe: async () => statusFor('trae', { currentSessionId: 'session-one', targetSessionId: 'session-two' }),
  });
  assert.equal(error.code, 'ROUTE_SESSION_MISMATCH');
  assert.equal(error.notSent, true);
  assert.equal((await readPresence(home, 'trae')).state, 'stale');
});

test('ROUTE_UNVERIFIED：workbuddy conversationVerified 非 true → notSent=true', async () => {
  const home = await tempHome('unverified');
  await writeEndpoint(home, 'workbuddy');
  for (const overrides of [{ conversationVerified: false }, { conversationVerified: undefined }]) {
    const error = await routeFailure({ client: 'workbuddy', home, forceProbe: true, probe: async () => statusFor('workbuddy', overrides) });
    assert.equal(error.code, 'ROUTE_UNVERIFIED');
    assert.equal(error.notSent, true);
  }
});

test('ROUTE_BUSY：执行端正在跑 → notSent=false，禁止自动重发', async () => {
  const home = await tempHome('busy');
  await writeEndpoint(home, 'workbuddy');
  const error = await routeFailure({ client: 'workbuddy', home, probe: async () => statusFor('workbuddy', { busy: true }) });
  assert.equal(error.code, 'ROUTE_BUSY');
  assert.equal(error.notSent, false);
  const presence = await readPresence(home, 'workbuddy');
  assert.equal(presence.state, 'stale');
  assert.equal(presence.busy, true);
  assert.match(presence.reason, /^ROUTE_BUSY: /);
});

test('契约 §2.3：live presence 形状与 deployment/heartbeat 一致', async () => {
  const home = await tempHome('presence-live');
  await writeEndpoint(home, 'trae');
  const trae = await resolveRoute({ client: 'trae', home, probe: async () => statusFor('trae') });
  assert.equal(trae.state, 'live');
  assert.equal(trae.cached, false);
  assert.deepEqual(Object.keys(trae.presence).sort(),
    [...COMMON_KEYS, 'currentSessionId', 'sessionTitle', 'targetSessionId'].sort());
  assert.equal(trae.presence.deployment, path.basename(home));
  assert.equal(trae.presence.root, ROOT_URL);
  assert.equal(trae.presence.reason, null);
  assert.ok(Number.isFinite(Date.parse(trae.presence.heartbeatAt)));
  assert.deepEqual(await readPresence(home, 'trae'), trae.presence);

  await writeEndpoint(home, 'workbuddy');
  const wb = await resolveRoute({ client: 'workbuddy', home, probe: async () => statusFor('workbuddy') });
  assert.deepEqual(Object.keys(wb.presence).sort(), [...COMMON_KEYS, 'conversationVerified', 'hostConnected'].sort());
});

test('契约 §2.2 第 5 步：TTL 内复用 presence，forceProbe 与 TTL 过期重新探测', async () => {
  const home = await tempHome('ttl');
  await writeEndpoint(home, 'trae');
  let probes = 0;
  const probe = async () => { probes += 1; return statusFor('trae'); };
  const first = await resolveRoute({ client: 'trae', home, probe });
  assert.equal(probes, 1);
  const second = await resolveRoute({ client: 'trae', home, probe });
  assert.equal(probes, 1);
  assert.equal(second.cached, true);
  assert.equal(second.presence.heartbeatAt, first.presence.heartbeatAt);
  assert.equal(second.status, undefined);
  await resolveRoute({ client: 'trae', home, forceProbe: true, probe });
  assert.equal(probes, 2);
  await resolveRoute({ client: 'trae', home, ttlMs: 0, probe });
  assert.equal(probes, 3);
  assert.equal(PRESENCE_TTL_MS, 15000);
});

test('resolveRoute 只服务执行端；persist=false 不落盘', async () => {
  const home = await tempHome('guards');
  await writeEndpoint(home, 'trae');
  await assert.rejects(() => resolveRoute({ client: 'qoder', home }), /只针对执行端/);
  const result = await resolveRoute({ client: 'trae', home, persist: false, probe: async () => statusFor('trae') });
  assert.equal(result.state, 'live');
  assert.equal(await readPresence(home, 'trae'), null);
});

test('契约 §2.4：DEFAULT_PLANNER=ds，源码不再硬编码 chatgpt，--as 拒绝执行端身份', async () => {
  assert.equal(DEFAULT_PLANNER, 'ds');
  const source = await fs.readFile(path.join(TOOLS, 'desktop-dispatch.mjs'), 'utf8');
  assert.doesNotMatch(source, /createHub\(\{ *client: *'chatgpt' *\}\)/);
  assert.match(source, /--as/);

  const root = await tempHome('as-root');
  const home = await tempHome('as-home');
  const env = { ...process.env, WSC_ROOT: root, WSC_BRIDGE_HOME: home };
  const executor = spawnSync(process.execPath, [path.join(TOOLS, 'desktop-dispatch.mjs'), 'dispatch', 'ROUTE-TEST-001', '--as', 'qoder'], { encoding: 'utf8', env });
  assert.equal(executor.status, 1);
  assert.match(executor.stderr, /不是规划端/);
  assert.equal((await fs.readdir(home)).filter(n => n.endsWith('.dispatch.json')).length, 0);

  const noValue = spawnSync(process.execPath, [path.join(TOOLS, 'desktop-dispatch.mjs'), 'dispatch', 'ROUTE-TEST-001', '--as'], { encoding: 'utf8', env });
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--as 需要规划端身份/);

  const ghost = spawnSync(process.execPath, [path.join(TOOLS, 'desktop-dispatch.mjs'), 'dispatch', 'ROUTE-TEST-001', '--as', 'nobody'], { encoding: 'utf8', env });
  assert.equal(ghost.status, 1);
  assert.match(ghost.stderr, /身份必须为/);
});

async function receipts(home) {
  const names = (await fs.readdir(home)).filter(n => n.endsWith('.dispatch.json'));
  return Promise.all(names.map(async name => ({ name, record: JSON.parse(await fs.readFile(path.join(home, name), 'utf8')) })));
}

test('契约 §2.2：派发前探测失败 → 抛 ROUTE_* 码与 notSent，不写派发台账，队列记 not-sent', async () => {
  const { home, hub } = await approvedTaskHub('preflight');
  await makeTask(hub, 'ROUTE-PREFLIGHT-001');
  const calls = [];
  await assert.rejects(() => dispatchTask('ROUTE-PREFLIGHT-001', {
    hub, home, call: okCall(calls), resolve: async () => { throw routeError('ROUTE_DEAD', '桥接未在线'); },
  }), error => {
    assert.equal(error.code, 'ROUTE_DEAD');
    assert.equal(error.notSent, true);
    assert.equal(error.delivery.recorded, true);
    assert.equal(error.delivery.state, 'not-sent');
    return true;
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await receipts(home), []);
  const task = await hub.run('get', { id: 'ROUTE-PREFLIGHT-001' });
  assert.equal(task.status, 'approved');
  assert.equal(task.delivery.state, 'not-sent');
  assert.equal(task.delivery.channel, 'mcc-workbuddy');
  assert.match(task.delivery.error, /^ROUTE_DEAD: /);
  assert.match(task.nonce, /^MCC-ACK-[0-9a-f]{8}$/);

  await assert.rejects(() => dispatchTask('ROUTE-PREFLIGHT-001', {
    hub, home, call: okCall(calls), resolve: async () => { throw routeError('ROUTE_BUSY', '正在执行回合'); },
  }), error => {
    assert.equal(error.notSent, false);
    assert.equal(error.delivery.state, 'uncertain');
    return true;
  });
  assert.equal((await hub.run('get', { id: 'ROUTE-PREFLIGHT-001' })).delivery.state, 'uncertain');
  assert.equal(calls.length, 0);
  assert.deepEqual(await receipts(home), []);

  await assert.rejects(() => dispatchTask('ROUTE-PREFLIGHT-001', {
    hub, home, call: okCall(calls), resolve: async () => { throw new Error('非契约错误'); },
  }), /非契约错误/);
  assert.equal(calls.length, 0);
});

test('契约 §2.5：hub 支持 dispatch → 投递 sent，队列转 dispatched 并生成 nonce', async () => {
  const { home, hub } = await approvedTaskHub('sent');
  await makeTask(hub, 'ROUTE-SENT-001', 'trae', ['tools/b.mjs']);
  const calls = [];
  const result = await dispatchTask('ROUTE-SENT-001', { hub, home, call: okCall(calls), resolve: liveRoute });
  assert.equal(result.nativeInvoked, true);
  assert.equal(result.status, 'dispatched');
  assert.equal(result.delivery.recorded, true);
  assert.equal(result.delivery.state, 'sent');
  assert.match(result.delivery.nonce, /^MCC-ACK-[0-9a-f]{8}$/);
  assert.equal(result.route.state, 'live');
  assert.deepEqual(calls, [{ action: 'dispatch', id: 'ROUTE-SENT-001', client: 'trae' }]);
  const [only] = await receipts(home);
  assert.equal(only.record.state, 'native-invoked');
  assert.equal(only.record.owner, 'trae');

  // 队列已转 dispatched：重复派发在状态守卫处即被拒绝，原生调用不得发出第二次。
  await assert.rejects(() => dispatchTask('ROUTE-SENT-001', { hub, home, call: okCall(calls), resolve: liveRoute }),
    /只派发归属执行端的 approved 任务/);
  assert.equal(calls.length, 1);
  assert.equal((await hub.run('get', { id: 'ROUTE-SENT-001' })).delivery.attempts, 1);
});

test('契约 §2.5 降级路径仍由 approvalKey 幂等：队列停在 approved 时第二次派发不重发', async () => {
  const { home, hub } = await approvedTaskHub('dup');
  await makeTask(hub, 'ROUTE-DUP-001');
  const calls = [];
  const legacy = { ...hub, actions: [] };
  const first = await dispatchTask('ROUTE-DUP-001', { hub: legacy, home, call: okCall(calls), resolve: liveRoute });
  assert.equal(first.status, 'approved');
  const second = await dispatchTask('ROUTE-DUP-001', { hub: legacy, home, call: okCall(calls), resolve: liveRoute });
  assert.equal(second.duplicatePrevented, true);
  assert.equal(calls.length, 1);
});

test('契约 §2.5：hub 不支持或拒绝 dispatch → 降级为本地台账，派发本身不得失败', async () => {
  const { home, hub } = await approvedTaskHub('degrade');
  await makeTask(hub, 'ROUTE-DEGRADE-001');
  const calls = [];
  const legacy = { ...hub, actions: hub.actions.filter(action => action !== 'dispatch') };
  const result = await dispatchTask('ROUTE-DEGRADE-001', { hub: legacy, home, call: okCall(calls), resolve: liveRoute });
  assert.equal(result.nativeInvoked, true);
  assert.equal(result.delivery.recorded, false);
  assert.match(result.delivery.reason, /不支持 dispatch 动作/);
  assert.equal(calls.length, 1);
  const [only] = await receipts(home);
  assert.equal(only.record.state, 'native-invoked');
  assert.equal((await hub.run('get', { id: 'ROUTE-DEGRADE-001' })).status, 'approved');

  const fresh = await approvedTaskHub('degrade2');
  await makeTask(fresh.hub, 'ROUTE-DEGRADE-002');
  const rejected = { ...fresh.hub, run: (action, args) => action === 'dispatch' ? Promise.reject(new Error('队列拒绝')) : fresh.hub.run(action, args) };
  const degraded = await dispatchTask('ROUTE-DEGRADE-002', { hub: rejected, home: fresh.home, call: okCall(calls), resolve: liveRoute });
  assert.equal(degraded.nativeInvoked, true);
  assert.equal(degraded.delivery.recorded, false);
  assert.match(degraded.delivery.reason, /hub dispatch 未受理/);
  assert.equal((await fresh.hub.run('get', { id: 'ROUTE-DEGRADE-002' })).status, 'approved');
});

test('契约 §1.1：dispatched 视为在途，同执行端不得并行派发', async () => {
  // 场景 A：在途任务由队列 dispatch 动作置为 dispatched，本 home 无台账 → 命中整表在途守卫。
  const a = await approvedTaskHub('inflight-a');
  await makeTask(a.hub, 'ROUTE-INFLIGHT-A0', 'trae', ['tools/c.mjs']);
  await makeTask(a.hub, 'ROUTE-INFLIGHT-A1', 'trae', ['tools/d.mjs']);
  await a.hub.run('dispatch', { id: 'ROUTE-INFLIGHT-A0', channel: 'mcc-trae', state: 'sent' });
  assert.equal((await a.hub.run('get', { id: 'ROUTE-INFLIGHT-A0' })).status, 'dispatched');
  const callsA = [];
  await assert.rejects(() => dispatchTask('ROUTE-INFLIGHT-A1', { hub: a.hub, home: a.home, call: okCall(callsA), resolve: liveRoute }),
    /已有同一执行端或路径重叠的在途任务/);
  assert.equal(callsA.length, 0);
  assert.deepEqual(await receipts(a.home), []);

  // 场景 B：在途任务由本文件派发（有 native-invoked 台账）→ 命中派发冲突守卫。
  const { home, hub } = await approvedTaskHub('inflight');
  await makeTask(hub, 'ROUTE-INFLIGHT-001', 'trae', ['tools/c.mjs']);
  await makeTask(hub, 'ROUTE-INFLIGHT-002', 'trae', ['tools/d.mjs']);
  const calls = [];
  const first = await dispatchTask('ROUTE-INFLIGHT-001', { hub, home, call: okCall(calls), resolve: liveRoute });
  assert.equal(first.status, 'dispatched');
  await assert.rejects(() => dispatchTask('ROUTE-INFLIGHT-002', { hub, home, call: okCall(calls), resolve: liveRoute }),
    /已有冲突派发 ROUTE-INFLIGHT-001/);
  assert.equal(calls.length, 1);
});

test('契约 §2.1/§2.5：原生调用失败按 notSent 记投递状态，not-sent 可安全重发', async () => {
  const { home, hub } = await approvedTaskHub('native-fail');
  await makeTask(hub, 'ROUTE-FAIL-001', 'trae', ['tools/e.mjs']);
  await assert.rejects(() => dispatchTask('ROUTE-FAIL-001', {
    hub, home, resolve: liveRoute, call: async () => { throw Object.assign(new Error('本机桥接未激活'), { notSent: true }); },
  }), error => {
    assert.equal(error.delivery.state, 'not-sent');
    return true;
  });
  assert.equal((await hub.run('get', { id: 'ROUTE-FAIL-001' })).delivery.state, 'not-sent');
  const [only] = await receipts(home);
  assert.equal(only.record.state, 'not-sent');

  const retry = await dispatchTask('ROUTE-FAIL-001', { hub, home, call: okCall([]), resolve: liveRoute });
  assert.equal(retry.status, 'dispatched');
  const [retried] = await receipts(home);
  assert.equal(retried.record.state, 'native-invoked');
  assert.equal(retried.record.priorAttempts.length, 1);
  assert.equal(retried.record.priorAttempts[0].state, 'not-sent');
});
