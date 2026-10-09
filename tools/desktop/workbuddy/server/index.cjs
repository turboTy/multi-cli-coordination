// 只能由 WorkBuddy 的扩展宿主 fork；会话调用经过宿主身份与权限检查。
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
// 从文件自身位置推导仓库根（server/ 在 tools/desktop/workbuddy/ 下，向上一级即项目根）。
const ROOT = path.resolve(__dirname, '../../../..').replace(/\\/g, '/');
const HOME = path.join(os.homedir(), '.local/share/wsc-hub/desktop-bridge');
// ★必填：目标会话 ID 与标题（在 WorkBuddy 目标对话属性里查看后填入）。
// 派发前会校验该会话存在且其工作目录等于仓库根，不匹配即拒发（不静默新建会话）。
const CONVERSATION_ID = '';
const CONVERSATION_TITLE = '';
const requests = new Map();
let server;
let busy = false;
let pending;
let lastDispatch;

function pathsOverlap(left, right) {
  const normalize = value => {
    const normalized = path.posix.normalize(value).replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const leftPath = normalize(left); const rightPath = normalize(right);
  return leftPath === rightPath || leftPath.startsWith(`${rightPath}/`) || rightPath.startsWith(`${leftPath}/`);
}

function tasksConflict(left, right) {
  return left.owner === right.owner || left.allowedPaths.some(held => right.allowedPaths.some(candidate => pathsOverlap(held, candidate)));
}

// 已绑定会话失效时停止：不能静默新建，避免把项目交接拆到其他聊天。
async function getProjectConversation() {
  const checked = await invoke('wb:conversations:get', [CONVERSATION_ID]);
  if (checked?.info?.id !== CONVERSATION_ID ||
      checked?.info?.space?.cwd?.replaceAll('\\', '/').toLowerCase() !== ROOT.toLowerCase()) {
    throw new Error('CONVERSATION_ROOT_MISMATCH');
  }
  return { conversationId: CONVERSATION_ID, reused: true };
}

function invoke(channel, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = `wsc-${crypto.randomUUID()}`;
    const timer = setTimeout(() => { requests.delete(requestId); reject(new Error('HOST_RESPONSE_TIMEOUT')); }, timeoutMs);
    requests.set(requestId, { resolve, reject, timer });
    process.send({ type: 'invoke:request', requestId, channel, args: [null, ...args] }, error => {
      if (!error) return;
      clearTimeout(timer); requests.delete(requestId); reject(new Error('HOST_SEND_FAILED'));
    });
  });
}

process.on('message', msg => {
  if (msg?.type !== 'invoke:response') return;
  const req = requests.get(msg.requestId);
  if (!req) return;
  requests.delete(msg.requestId); clearTimeout(req.timer);
  msg.error === undefined ? req.resolve(msg.result) : req.reject(new Error(`HOST_REJECTED: ${typeof msg.error === 'string' ? msg.error : msg.error.message ?? 'unknown'}`));
});
process.once('disconnect', () => { server?.close(); process.exit(0); });
process.once('SIGTERM', () => { server?.close(); process.exit(0); });

async function activate() {
  if (!process.send || process.env.WB_EXTENSION_ID !== 'wsc-coordination-bridge') throw new Error('WORKBUDDY_HOST_REQUIRED');
  const key = crypto.randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\wsc-workbuddy-${crypto.randomUUID()}`;
  await fs.mkdir(HOME, { recursive: true });
  server = net.createServer(socket => {
    let data = ''; let handled = false;
    socket.setTimeout(10000, () => { if (!handled) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk.toString('utf8');
      if (data.length > 4096) return socket.destroy();
      if (!data.includes('\n')) return;
      handled = true; socket.setTimeout(0);
      const reply = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
      let invocationStarted = false;
      let ownPending;
      (async () => {
        let req;
        try { req = JSON.parse(data.split('\n')[0]); } catch { return reply({ error: 'INVALID_JSON', notSent: true }); }
        if (req.key !== key) return reply({ error: 'UNAUTHORIZED', notSent: true });
        if (req.action === 'status') {
          let conversationVerified = false;
          try {
            const checked = await invoke('wb:conversations:get', [CONVERSATION_ID]);
            conversationVerified = checked?.info?.id === CONVERSATION_ID && checked?.info?.space?.cwd?.replaceAll('\\', '/').toLowerCase() === ROOT.toLowerCase();
          } catch {}
          return reply({ client: 'workbuddy', version: '0.3.0', root: ROOT, busy, hostConnected: process.connected, conversationId: CONVERSATION_ID, conversationTitle: CONVERSATION_TITLE, conversationVerified, lastDispatch });
        }
        if (req.action !== 'dispatch' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(req.id ?? '')) return reply({ error: 'INVALID_REQUEST', notSent: true });
        if (busy) return reply({ error: 'BUSY', notSent: true });
        const board = JSON.parse(await fs.readFile(path.join(ROOT, 'coordination/board.json'), 'utf8'));
        const task = board.tasks.find(t => t.id === req.id);
        if (!task || task.owner !== 'workbuddy' || task.status !== 'approved') return reply({ error: 'TASK_NOT_APPROVED_FOR_WORKBUDDY', notSent: true });
        const revision = t => crypto.createHash('sha256').update(`${t.id}:${[...t.history].reverse().find(x => x.action === 'approve' || x.action === 'return')?.at}`).digest('hex');
        if (req.approvalKey !== revision(task)) return reply({ error: 'APPROVAL_CHANGED', notSent: true });
        const prior = pending && board.tasks.find(t => t.id === pending.id);
        if (prior && ['approved', 'in-progress'].includes(prior.status) && revision(prior) === pending.revision) return reply({ error: 'DELIVERY_PENDING', notSent: true });
        if (board.tasks.some(t => t.status === 'in-progress' && tasksConflict(t, task))) return reply({ error: 'WRITER_ACTIVE', notSent: true });
        busy = true; pending = { id: task.id, revision: req.approvalKey };
        ownPending = pending;
        try {
          const { conversationId, reused } = await getProjectConversation();
          const prompt = `你是本项目的 WorkBuddy 执行端。请实际调用 wsc_list/get 核对 ${task.id}，阅读完整 history 并优先处理最新 return 意见，再 claim。只按允许路径执行，保护所有在途改动，不提交推送、不切换 planner、自验放行。完成后 submit 摘要与 SHA256 等可复查证据。先读项目协作文档（如 README 的执行端章节），再按任务要求追读。MCP 不可用时允许同一 wsc-hub.mjs --client workbuddy CLI，但如实标通道。要求：${task.requirements}\n验收：${JSON.stringify(task.acceptance)}\n允许路径：${JSON.stringify(task.allowedPaths)}`;
          invocationStarted = true;
          lastDispatch = { id: task.id, conversationId, conversationReused: reused, state: 'native-request-sent', at: new Date().toISOString() };
          const response = invoke('wb:conversations:runPrompt', [conversationId, [{ type: 'text', text: prompt }], { clientRequestId: req.approvalKey, timeoutMs: 600000 }], 610000);
          reply({ id: task.id, client: 'workbuddy', nativeInvocationSent: true, conversationId, conversationReused: reused, completion: '以共享队列 submit 和文件证据为准' });
          try {
            const result = await response;
            lastDispatch = { ...lastDispatch, state: result?.errorCode ? 'native-error' : 'native-returned', error: result?.errorCode, at: new Date().toISOString() };
            await fs.writeFile(path.join(HOME, `${task.id}-wb-reply.json`), JSON.stringify({ id: task.id, conversationId, at: new Date().toISOString(), result }, null, 2));
          } catch (error) {
            lastDispatch = { ...lastDispatch, state: 'native-error', error: error.message.slice(0, 256), at: new Date().toISOString() };
            await fs.writeFile(path.join(HOME, `${task.id}-wb-reply.json`), JSON.stringify({ id: task.id, conversationId, at: new Date().toISOString(), error: error.message }, null, 2));
          }
        } finally { busy = false; if (!invocationStarted && pending === ownPending) pending = undefined; }
      })().catch(error => { console.error(`[WSC] ${error.message}`); reply({ error: 'DISPATCH_FAILED', notSent: !invocationStarted }); });
    });
  });
  server.on('error', error => { console.error(`[WSC] pipe: ${error.code}`); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  await fs.writeFile(path.join(HOME, 'workbuddy-endpoint.json'), JSON.stringify({ pipe, key, root: ROOT, pid: process.pid }), { mode: 0o600 });
  process.send({ type: 'wb-extension-ready', extensionId: process.env.WB_EXTENSION_ID, pid: process.pid });
  console.log('[WSC] 本机派发桥接已就绪');
}
activate().catch(error => { console.error(`[WSC] ${error.message}`); process.exit(1); });
