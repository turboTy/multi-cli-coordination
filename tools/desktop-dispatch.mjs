#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createHub, ROOT } from './wsc-hub.mjs';
import { ROUTE_NOT_SENT, resolveRoute } from './routing.mjs';

// MCC 独立部署补丁（唯一改动）：允许用 WSC_BRIDGE_HOME 指定私有状态目录。
// 上游把 HOME 硬编码为共享 desktop-bridge，其中 {client}-endpoint.json / trae-deploy.json /
// workbuddy-runtime-config.json 都是单例文件名，多进程共存时互相覆盖。未设该变量时保持上游默认行为。
const BRIDGE_HOME = process.env.WSC_BRIDGE_HOME
  ? path.resolve(process.env.WSC_BRIDGE_HOME)
  : path.join(os.homedir(), '.local/share/wsc-hub/desktop-bridge');
// 契约 §2.4：派发身份不再硬编码某个客户端，改由 --as 指定，默认 ds。
export const DEFAULT_PLANNER = 'ds';
// 契约 §1.1：dispatched 与 in-progress 一并视为在途，用于并发冲突判定。
const IN_FLIGHT = ['dispatched', 'in-progress'];
function bridgeError(message, notSent = false) { return Object.assign(new Error(message), { notSent }); }
function validateResponse(value, client, action, id) {
  const valid = value && value.client === client && (action === 'status'
    ? value.root === ROOT.replaceAll('\\', '/') && typeof value.version === 'string' && typeof value.busy === 'boolean'
    : action === 'bind' ? (value.sessionCreated === true || value.sessionCreated === false)
      : value.id === id && (client === 'trae' ? value.nativeInvocationReturned === true : value.nativeInvocationSent === true));
  if (!valid) throw bridgeError('桥接响应缺少正确的任务或客户端确认；先核对队列');
  return value;
}
async function saveReceipt(file, record, create = false) {
  const target = create ? file : `${file}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(target, 'wx');
  try { await handle.writeFile(JSON.stringify(record, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  if (!create) {
    try { await fs.rename(target, file); }
    finally { await fs.unlink(target).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
}
export function approvalKey(task) {
  const last = [...task.history].reverse().find(x => x.action === 'approve' || x.action === 'return');
  if (!last) throw new Error('任务缺少批准历史');
  return crypto.createHash('sha256').update(`${task.id}:${last.at}`).digest('hex');
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

// 契约 §2.4：只有规划端身份才能建 hub；执行端身份在建 hub 之前即被拒绝。
function plannerHub(client) {
  const hub = createHub({ client });
  if (hub.role !== 'planner') throw new Error(`派发身份 ${client} 不是规划端；--as 只接受 planner 身份`);
  return hub;
}

// 契约 §2.5：投递状态回写队列，但必须先特性探测 hub 是否支持 dispatch 动作；
// 不支持或回写被拒都只降级为本地派发台账，不得让派发本身失败。
export async function recordDelivery(hub, { id, channel, state, error } = {}) {
  if (!hub.actions?.includes('dispatch')) return { recorded: false, reason: 'hub 不支持 dispatch 动作；降级为仅写本地派发台账' };
  try {
    const task = await hub.run('dispatch', { id, channel, state, ...(error ? { error } : {}) });
    return { recorded: true, state, status: task.status, nonce: task.nonce };
  } catch (runError) {
    return { recorded: false, state, reason: `hub dispatch 未受理：${runError.message}` };
  }
}

export async function callBridge(action, id, { home = BRIDGE_HOME, timeoutMs, client = 'trae', approvalKey: revision, nonce } = {}) {
  timeoutMs ??= client === 'workbuddy' && action === 'dispatch' ? 30000 : 10000;
  if (!['trae', 'workbuddy'].includes(client)) throw bridgeError('未知执行端', true);
  if (action === 'dispatch') {
    const status = await callBridge('status', undefined, { home, timeoutMs, client });
    if (client === 'workbuddy') {
      if (!status.conversationVerified || !status.conversationId) throw bridgeError('WORKBUDDY_CONVERSATION_NOT_VERIFIED', true);
    } else {
      if (!status.sessionBindingConfigured || !status.targetSessionId) throw bridgeError('TRAE_SESSION_NOT_CONFIGURED', true);
      if (status.currentSessionId !== status.targetSessionId) throw bridgeError('TRAE_SESSION_MISMATCH', true);
    }
  }
  let ep;
  try { ep = JSON.parse(await fs.readFile(path.join(home, `${client}-endpoint.json`), 'utf8')); }
  catch { throw bridgeError(`${client} 本机桥接未激活`, true); }
  if (ep.root !== ROOT.replaceAll('\\', '/') || !String(ep.pipe).startsWith(`\\\\.\\pipe\\wsc-${client}-`) || !/^[a-f0-9]{64}$/.test(ep.key)) throw bridgeError('桥接描述无效', true);
  return new Promise((resolve, reject) => {
    const socket = net.connect(ep.pipe);
    let data = '';
    let settled = false;
    let sent = false;
    const timer = setTimeout(() => finish(bridgeError('桥接响应超时；先检查队列，勿盲目重发', !sent)), timeoutMs);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', () => { sent = true; socket.write(JSON.stringify({ key: ep.key, action, ...(id ? { id, approvalKey: revision, ...(nonce ? { nonce } : {}) } : {}) }) + '\n'); });
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 4096) return finish(new Error('桥接响应过大'));
      if (!data.includes('\n')) return;
      try { const result = JSON.parse(data.split('\n')[0]); result.error ? finish(bridgeError(`桥接拒绝：${result.error}`, result.notSent === true)) : finish(null, validateResponse(result, client, action, id)); }
      catch (error) { finish(error); }
    });
    socket.on('error', () => finish(bridgeError('桥接连接失败；先检查队列，勿盲目重发', !sent)));
    socket.on('end', () => { if (!data.includes('\n')) finish(new Error('桥接未返回完整响应；先检查队列')); });
  });
}

export async function dispatchTask(id, { planner = DEFAULT_PLANNER, hub = plannerHub(planner), home = BRIDGE_HOME, call = callBridge, resolve = resolveRoute } = {}) {
  await fs.mkdir(home, { recursive: true });
  const lockPath = path.join(home, 'dispatch.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('派发操作正在进行或锁遗留；先核对队列和进程'); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const board = await hub.readBoard();
    const task = board.tasks.find(x => x.id === id);
    if (!task || !['trae', 'workbuddy'].includes(task.owner) || task.status !== 'approved') throw new Error('只派发归属执行端的 approved 任务');
    const channel = `mcc-${task.owner}`;
    const key = approvalKey(task);
    const receipt = path.join(home, `${key}.dispatch.json`);
    let priorAttempt;
    for (const name of await fs.readdir(home)) {
      if (!name.endsWith('.dispatch.json')) continue;
      let previous;
      try { previous = JSON.parse(await fs.readFile(path.join(home, name), 'utf8')); }
      catch { throw new Error('派发记录损坏；先核查原交付，不能盲目重发'); }
      if (previous.approvalKey === key) {
        if (previous.state !== 'not-sent') return { id, duplicatePrevented: true, status: task.status, receipt };
        priorAttempt = previous; continue;
      }
      if (previous.state === 'not-sent') continue;
      const pending = board.tasks.find(x => x.id === previous.id);
      if (pending && ['approved', ...IN_FLIGHT].includes(pending.status) && approvalKey(pending) === previous.approvalKey && tasksConflict(pending, task)) throw new Error(`已有冲突派发 ${pending.id}，不能启动此执行者`);
    }
    if (board.tasks.some(x => x !== task && IN_FLIGHT.includes(x.status) && tasksConflict(x, task))) throw new Error('已有同一执行端或路径重叠的在途任务，不能启动此执行者');
    // 契约 §2.2：先探测、后投递。探测只读，失败即路由错误（ROUTE_* 码携带 notSent 语义），
    // 此时确定没有发出原生调用，故不写派发台账，只把投递结果回写队列后原样抛出。
    const route = await resolve({ client: task.owner, home }).catch(failure => {
      if (!(failure.code in ROUTE_NOT_SENT)) throw failure;
      const state = failure.notSent === true ? 'not-sent' : 'uncertain';
      return recordDelivery(hub, { id, channel, state, error: `${failure.code}: ${failure.message}` })
        .then(delivery => { throw Object.assign(failure, { delivery }); });
    });
    const record = { id, owner: task.owner, approvalKey: key, at: new Date().toISOString(), state: 'attempting', priorAttempts: priorAttempt ? [...priorAttempt.priorAttempts ?? [], { at: priorAttempt.at, state: priorAttempt.state, error: priorAttempt.error }] : [] };
    await saveReceipt(receipt, record, !priorAttempt);
    try {
      // 契约 §3：令牌以队列为正本；首次投递时 nonce 尚未由 dispatch 动作铸造，
      // 故只把板上已有值随调用送达，扩展侧仍自行读取 task.nonce 为准。
      const native = validateResponse(await call('dispatch', id, { home, client: task.owner, approvalKey: key, ...(task.nonce ? { nonce: task.nonce } : {}) }), task.owner, 'dispatch', id);
      await saveReceipt(receipt, { ...record, state: 'native-invoked', native });
      const delivery = await recordDelivery(hub, { id, channel, state: 'sent' });
      return { id, nativeInvoked: true, status: (await hub.run('get', { id })).status, receipt, route: route.presence, delivery, completion: '等待执行端 submit；需要规划端独立验收' };
    } catch (error) {
      await saveReceipt(receipt, { ...record, state: error.notSent === true ? 'not-sent' : 'delivery-uncertain', error: error.message });
      const delivery = await recordDelivery(hub, { id, channel, state: error.notSent === true ? 'not-sent' : 'uncertain', error: error.message });
      throw Object.assign(error, { delivery });
    }
  } finally {
    try { await lock.close(); } finally { await fs.unlink(lockPath); }
  }
}

export async function recoverCancelledDispatch(id, note, { planner = DEFAULT_PLANNER, hub = plannerHub(planner), home = BRIDGE_HOME, call = callBridge, resolve = resolveRoute } = {}) {
  if (typeof note !== 'string' || !note.trim()) throw new Error('恢复必须说明续办边界');
  const task = await hub.run('get', { id });
  if (task.owner !== 'workbuddy' || !task.id.startsWith('TRANSPORT-') || !['approved', 'in-progress'].includes(task.status)) throw new Error('仅恢复 WB 未完成的运输任务');
  const key = approvalKey(task);
  const receipt = JSON.parse(await fs.readFile(path.join(home, `${key}.dispatch.json`), 'utf8'));
  const reply = JSON.parse(await fs.readFile(path.join(home, `${id}-wb-reply.json`), 'utf8'));
  if (receipt.id !== id || receipt.approvalKey !== key || receipt.state !== 'native-invoked' ||
      reply.id !== id || reply.result?.state !== 'cancelled' ||
      reply.conversationId !== receipt.native?.conversationId || !Number.isFinite(Date.parse(reply.at)) ||
      !Number.isFinite(Date.parse(receipt.at)) || Date.parse(reply.at) < Date.parse(receipt.at)) {
    throw new Error('缺少当前批准对应的原生取消证据；不能重发');
  }
  const claim = [...task.history].reverse().find(event => event.action === 'claim');
  const previousClaimAt = task.status === 'in-progress' ? claim?.at : undefined;
  if (task.status === 'in-progress' && (claim?.client !== task.owner || !Number.isFinite(Date.parse(previousClaimAt)) ||
      Date.parse(previousClaimAt) < Date.parse(receipt.at) || Date.parse(previousClaimAt) > Date.parse(reply.at))) {
    throw new Error('领取不属于本次已取消调用；不能恢复');
  }
  const status = validateResponse(await call('status', undefined, { home, client: task.owner }), task.owner, 'status');
  if (status.busy || !status.hostConnected || status.conversationVerified !== true || status.conversationId !== reply.conversationId) {
    throw new Error('原固定会话未确认空闲；不能恢复');
  }
  const current = await hub.run('get', { id });
  if (current.status !== task.status || approvalKey(current) !== key ||
      (previousClaimAt && [...current.history].reverse().find(event => event.action === 'claim')?.at !== previousClaimAt)) throw new Error('恢复期间任务修订变化；停止');
  const previousApprovalAt = [...task.history].reverse().find(event => ['approve', 'return'].includes(event.action)).at;
  await hub.run('renew', { id, previousApprovalAt, ...(previousClaimAt ? { previousClaimAt } : {}), note: `${note}\nCancelled native call: ${reply.at}; conversation: ${reply.conversationId}; previous approval: ${key}.` });
  return dispatchTask(id, { hub, home, call, resolve });
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  // 契约 §2.4：--as <规划端身份>，默认 ds；不得再硬编码某个客户端。
  const asIndex = args.indexOf('--as');
  let planner = DEFAULT_PLANNER;
  if (asIndex >= 0) {
    const [, value] = args.splice(asIndex, 2);
    if (!value || value.startsWith('--')) throw new Error('--as 需要规划端身份，例如 --as ds');
    planner = value;
  }
  if (args[0] === 'status' && args.length <= 2) return console.log(JSON.stringify(await callBridge('status', undefined, { client: args[1] ?? 'trae' }), null, 2));
  if (args[0] === 'bind' && args.length === 2) return console.log(JSON.stringify(await callBridge('bind', undefined, { client: args[1] }), null, 2));
  if (args[0] === 'dispatch' && args.length === 2) return console.log(JSON.stringify(await dispatchTask(args[1], { planner }), null, 2));
  if (args[0] === 'recover' && args.length === 3) return console.log(JSON.stringify(await recoverCancelledDispatch(args[1], args[2], { planner }), null, 2));
  throw new Error('用法：desktop-dispatch.mjs status [trae|workbuddy] | bind trae | dispatch <任务ID> | recover <任务ID> <续办说明> [--as ds|chatgpt]');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
