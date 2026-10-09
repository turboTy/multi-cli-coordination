#!/usr/bin/env node
// U2：路由解析（契约正本 docs/routing-contract-v1.md §2）。先探测、后投递；探测只读。
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './wsc-hub.mjs';

export const ROUTE_CLIENTS = ['trae', 'workbuddy'];
// 契约 §2.1：notSent=true 才允许自动重发；ROUTE_BUSY 可能正在跑，必须为 false。
export const ROUTE_NOT_SENT = { ROUTE_UNCONFIGURED: true, ROUTE_DEAD: true, ROUTE_SESSION_MISMATCH: true, ROUTE_UNVERIFIED: true, ROUTE_BUSY: false };
export const PRESENCE_TTL_MS = 15000;

export function bridgeHome(env = process.env) {
  return env.WSC_BRIDGE_HOME ? path.resolve(env.WSC_BRIDGE_HOME) : path.join(os.homedir(), '.local/share/wsc-hub/desktop-bridge');
}

export function routeError(code, message) {
  if (!(code in ROUTE_NOT_SENT)) throw new Error(`未知路由错误码：${code}`);
  return Object.assign(new Error(message ?? code), { code, notSent: ROUTE_NOT_SENT[code] });
}

export function endpointPath(home, client) { return path.join(home, `${client}-endpoint.json`); }
export function presencePath(home, client) { return path.join(home, `${client}-presence.json`); }
export function deploymentOf(home) { return path.basename(home); }

export async function readEndpoint(home, client) {
  let raw;
  try { raw = await fs.readFile(endpointPath(home, client), 'utf8'); }
  catch (error) { throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint 不可读：${error.code ?? error.message}`); }
  let endpoint;
  try { endpoint = JSON.parse(raw); }
  catch { throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint 不是合法 JSON`); }
  if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint 不是对象`);
  if (endpoint.root !== ROOT.replaceAll('\\', '/')) throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint root 与项目根不符`);
  if (typeof endpoint.pipe !== 'string' || !endpoint.pipe.startsWith(`\\\\.\\pipe\\wsc-${client}-`)) throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint pipe 命名非法`);
  if (typeof endpoint.key !== 'string' || !/^[a-f0-9]{64}$/.test(endpoint.key)) throw routeError('ROUTE_UNCONFIGURED', `${client} endpoint key 形状非法`);
  return endpoint;
}

// 契约 §2.3：presence 是 live 与 stale 共用的统一形状，字段按客户端能力填充。
export function presenceRecord({ client, home, endpoint, status, state, reason, heartbeatAt }) {
  return {
    client,
    deployment: deploymentOf(home),
    root: endpoint?.root ?? ROOT.replaceAll('\\', '/'),
    pid: endpoint?.pid ?? null,
    pipe: endpoint?.pipe ?? null,
    state,
    ...(status?.sessionTitle !== undefined ? { sessionTitle: status.sessionTitle } : {}),
    ...(status?.currentSessionId !== undefined ? { currentSessionId: status.currentSessionId } : {}),
    ...(status?.targetSessionId !== undefined ? { targetSessionId: status.targetSessionId } : {}),
    ...(status?.hostConnected !== undefined ? { hostConnected: status.hostConnected } : {}),
    ...(status?.conversationVerified !== undefined ? { conversationVerified: status.conversationVerified } : {}),
    ...(status?.busy !== undefined ? { busy: status.busy } : {}),
    reason: reason ?? null,
    heartbeatAt,
  };
}

export async function readPresence(home, client) {
  try { return JSON.parse(await fs.readFile(presencePath(home, client), 'utf8')); }
  catch { return null; }
}

export async function writePresence(home, client, record) {
  await fs.mkdir(home, { recursive: true });
  const target = presencePath(home, client);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try { await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, target);
  return target;
}

export async function probeStatus({ client, endpoint, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint.pipe);
    let data = '';
    let settled = false;
    let timer;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    timer = setTimeout(() => finish(new Error(`${client} status 探测超时 ${timeoutMs}ms`)), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ key: endpoint.key, action: 'status' })}\n`));
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (data.length > 8192) return finish(new Error(`${client} status 响应过大`));
      if (!data.includes('\n')) return;
      let parsed;
      try { parsed = JSON.parse(data.split('\n')[0]); }
      catch (error) { return finish(error); }
      if (parsed?.error) return finish(new Error(`${client} 桥接拒绝 status：${parsed.error}`));
      finish(null, parsed);
    });
    socket.on('error', () => finish(new Error(`${client} status 探测连接失败（桥接未在线）`)));
    socket.on('end', () => { if (!data.includes('\n')) finish(new Error(`${client} status 未返回完整响应`)); });
  });
}

export async function resolveRoute({ client, home = bridgeHome(), timeoutMs = 10000, ttlMs = PRESENCE_TTL_MS, forceProbe = false, probe = probeStatus, now = () => new Date().toISOString(), persist = true } = {}) {
  if (!ROUTE_CLIENTS.includes(client)) throw new Error('路由解析只针对执行端 trae 或 workbuddy');
  if (!forceProbe) {
    const cached = await readPresence(home, client);
    if (cached?.state === 'live' && Number.isFinite(Date.parse(cached.heartbeatAt)) && Date.now() - Date.parse(cached.heartbeatAt) < ttlMs) {
      return { client, state: 'live', cached: true, presence: cached };
    }
  }
  let endpoint;
  let status;
  let failure;
  try {
    endpoint = await readEndpoint(home, client);
    status = await probe({ client, endpoint, timeoutMs, home, ttlMs });
    if (!status || typeof status !== 'object' || status.client !== client || status.root !== endpoint.root || typeof status.busy !== 'boolean') {
      throw routeError('ROUTE_DEAD', `${client} status 响应与 endpoint 不同源或形状非法`);
    }
    if (client === 'trae' && status.currentSessionId !== status.targetSessionId) throw routeError('ROUTE_SESSION_MISMATCH', `${client} currentSessionId(${status.currentSessionId ?? 'null'}) !== targetSessionId(${status.targetSessionId ?? 'null'})`);
    if (client === 'workbuddy' && status.conversationVerified !== true) throw routeError('ROUTE_UNVERIFIED', `${client} conversationVerified=${status.conversationVerified}`);
    if (status.busy === true) throw routeError('ROUTE_BUSY', `${client} 正在执行回合；不得自动重发`);
  } catch (error) {
    // 未分类的探测异常按通道不可用处理：确定没送出去，可安全重发。
    if (!(error.code in ROUTE_NOT_SENT)) error = routeError('ROUTE_DEAD', error.message);
    failure = error;
  }
  const heartbeatAt = now();
  const presence = presenceRecord({ client, home, endpoint, status, state: failure ? 'stale' : 'live', reason: failure ? `${failure.code}: ${failure.message}` : null, heartbeatAt });
  if (persist) await writePresence(home, client, presence);
  if (failure) throw Object.assign(failure, { presence });
  return { client, state: 'live', cached: false, presence, status };
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const client = args.shift();
  const options = { client };
  while (args.length) {
    const flag = args.shift();
    if (flag === '--home') options.home = path.resolve(args.shift());
    else if (flag === '--force') options.forceProbe = true;
    else if (flag === '--timeout') options.timeoutMs = Number(args.shift());
    else if (flag === '--ttl') options.ttlMs = Number(args.shift());
    else throw new Error(`未知参数：${flag}`);
  }
  const result = await resolveRoute(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${error.code ?? 'ROUTE_ERROR'} notSent=${error.notSent === true} ${error.message}\n`);
    process.exitCode = 1;
  });
}
