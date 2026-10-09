const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');

// vsix 部署形态下扩展安装目录与源码目录无关，__dirname 四层推导会落到 C:/Users。
// 仓库根改为运行时解析：优先安装器写入用户目录的部署配置，源码形态才允许带 board.json 校验的相对推导兜底。
const HOME = path.join(os.homedir(), '.local/share/wsc-hub/desktop-bridge');
const DEPLOY_CONFIG_FILE = path.join(HOME, 'trae-deploy.json');
const LOG_FILE = path.join(HOME, 'trae-bridge.log');
const SESSION_BINDING_FILE = path.join(HOME, 'trae-session.json');
const SESSION_TITLE = 'vscode-WSC';
const VERSION = '0.2.2';
let server;
let busy = false;
let pending;

// 日志只写时间戳、事件名与定位信息，严禁含鉴权 key、token 或凭据。
async function appendLog(event, detail) {
  try {
    await fs.mkdir(HOME, { recursive: true });
    await fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${event} ${detail}\n`, { mode: 0o600 });
  } catch { /* 日志不可写不改变激活结果 */ }
}

function posixAbsolute(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const candidate = value.trim().replace(/\\/g, '/');
  return path.posix.isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate) ? candidate : undefined;
}

async function deriveRootFromSourceLayout() {
  if (typeof __dirname !== 'string') return undefined;
  const candidate = posixAbsolute(path.resolve(__dirname, '../../../..'));
  if (!candidate) return undefined;
  try {
    await fs.access(path.resolve(candidate, 'coordination', 'board.json'));
  } catch {
    return undefined;
  }
  return candidate;
}

async function resolveRoot() {
  let raw;
  try {
    raw = await fs.readFile(DEPLOY_CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      await appendLog('DEPLOY_CONFIG_INVALID', `cannot read ${DEPLOY_CONFIG_FILE}: ${error.message}`);
      return undefined;
    }
    const derived = await deriveRootFromSourceLayout();
    if (!derived) await appendLog('ACTIVATE_SKIPPED', `missing deploy config at ${DEPLOY_CONFIG_FILE}`);
    return derived;
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    await appendLog('DEPLOY_CONFIG_INVALID', `cannot parse ${DEPLOY_CONFIG_FILE}: ${error.message}`);
    return undefined;
  }
  const root = config?.client === 'trae' ? posixAbsolute(config.root) : undefined;
  if (!root) {
    await appendLog('DEPLOY_CONFIG_INVALID', `${DEPLOY_CONFIG_FILE} declares no valid trae root`);
    return undefined;
  }
  return root;
}

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

function supportedWorkspace(workspaceFolders, root, container) {
  return workspaceFolders.some(folder => {
    const candidate = path.resolve(folder.uri.fsPath).toLowerCase();
    return candidate === path.resolve(root).toLowerCase() || candidate === path.resolve(container).toLowerCase();
  });
}

async function getSessionBinding() {
  try {
    const binding = JSON.parse(await fs.readFile(SESSION_BINDING_FILE, 'utf8'));
    if (binding?.title !== SESSION_TITLE || typeof binding.sessionId !== 'string' || !binding.sessionId) return undefined;
    return binding;
  } catch {
    return undefined;
  }
}

async function activate(context) {
  const root = await resolveRoot();
  if (!root) return;
  const container = path.resolve(root, '..').replace(/\\/g, '/');
  const workspaceRoots = vscode.workspace.workspaceFolders ?? [];
  if (!supportedWorkspace(workspaceRoots, root, container)) {
    await appendLog('WORKSPACE_MISMATCH', `expected=${root} folders=${JSON.stringify(workspaceRoots.map(folder => folder.uri.fsPath))}`);
    return;
  }
  const key = crypto.randomBytes(32).toString('hex');
  const pipe = `\\\\.\\pipe\\wsc-trae-${crypto.randomUUID()}`;
  await fs.mkdir(HOME, { recursive: true });
  server = net.createServer(socket => {
    let data = '';
    let handled = false;
    socket.setTimeout(10000, () => { if (!handled) socket.destroy(); });
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk.toString('utf8');
      if (data.length > 4096) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      socket.setTimeout(0);
      const reply = value => { if (!socket.destroyed) socket.end(JSON.stringify(value) + '\n'); };
      let invocationStarted = false;
      let ownPending;
      (async () => {
        let req;
        try { req = JSON.parse(data.split('\n')[0]); } catch { return reply({ error: 'INVALID_JSON', notSent: true }); }
        if (req.key !== key) return reply({ error: 'UNAUTHORIZED', notSent: true });
        const roots = vscode.workspace.workspaceFolders ?? [];
        if (!supportedWorkspace(roots, root, container)) return reply({ error: 'WRONG_WORKSPACE', notSent: true });
        const commands = await vscode.commands.getCommands(true);
        const sessionCommandAvailable = commands.includes('icube.chat.getCurrentSessionId');
        const currentSessionId = (req.action === 'status' || req.action === 'bind') && sessionCommandAvailable
          ? await vscode.commands.executeCommand('icube.chat.getCurrentSessionId')
          : undefined;
        const binding = await getSessionBinding();
        if (req.action === 'status') return reply({ client: 'trae', version: VERSION, root, busy, commandAvailable: commands.includes('wx.bridge.sendAndWaitResponse'), sessionCommandAvailable, sessionTitle: SESSION_TITLE, sessionBindingConfigured: Boolean(binding), currentSessionId, targetSessionId: binding?.sessionId });
        if (req.action === 'bind') {
          if (binding) return reply({ client: 'trae', version: VERSION, root, sessionTitle: SESSION_TITLE, sessionId: binding.sessionId, sessionCreated: false });
          if (!sessionCommandAvailable) return reply({ error: 'TRAE_SESSION_COMMAND_UNAVAILABLE', notSent: true });
          if (typeof currentSessionId !== 'string' || !currentSessionId) return reply({ error: 'TRAE_SESSION_NOT_ACTIVE', notSent: true });
          await fs.writeFile(SESSION_BINDING_FILE, JSON.stringify({ schemaVersion: 1, title: SESSION_TITLE, sessionId: currentSessionId, at: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
          return reply({ client: 'trae', version: VERSION, root, sessionTitle: SESSION_TITLE, sessionId: currentSessionId, sessionCreated: false, sessionBound: true });
        }
        if (req.action !== 'dispatch' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(req.id ?? '')) return reply({ error: 'INVALID_REQUEST', notSent: true });
        if (busy) return reply({ error: 'BUSY', notSent: true });
        const board = JSON.parse(await fs.readFile(path.join(root, 'coordination/board.json'), 'utf8'));
        const task = board.tasks.find(t => t.id === req.id);
        if (!task || task.owner !== 'trae' || task.status !== 'approved') return reply({ error: 'TASK_NOT_APPROVED_FOR_TRAE', notSent: true });
        const revision = t => crypto.createHash('sha256').update(`${t.id}:${[...t.history].reverse().find(x => x.action === 'approve' || x.action === 'return')?.at}`).digest('hex');
        if (req.approvalKey !== revision(task)) return reply({ error: 'APPROVAL_CHANGED', notSent: true });
        const prior = pending && board.tasks.find(t => t.id === pending.id);
        if (prior && ['approved', 'in-progress'].includes(prior.status) && revision(prior) === pending.revision) return reply({ error: 'DELIVERY_PENDING', notSent: true });
        if (board.tasks.some(t => t.status === 'in-progress' && tasksConflict(t, task))) return reply({ error: 'WRITER_ACTIVE', notSent: true });
        if (!commands.includes('wx.bridge.sendAndWaitResponse')) return reply({ error: 'NATIVE_COMMAND_UNAVAILABLE', notSent: true });
        if (!binding) return reply({ error: 'TRAE_SESSION_NOT_CONFIGURED', notSent: true });
        if (!sessionCommandAvailable) return reply({ error: 'TRAE_SESSION_COMMAND_UNAVAILABLE', notSent: true });
        // 文件读取期间用户可能切换聊天；发送前重新检查，检查后不再等待文件操作。
        const dispatchSessionId = await vscode.commands.executeCommand('icube.chat.getCurrentSessionId');
        if (dispatchSessionId !== binding.sessionId) return reply({ error: 'TRAE_SESSION_MISMATCH', notSent: true });
        busy = true;
        pending = { id: task.id, revision: req.approvalKey };
        ownPending = pending;
        try {
          const prompt = `你是本项目的 TRAE 执行端。请现在实际调用 wsc_list/get，核对并领取 ${task.id}；读取完整 history，优先处理最新 return 的修订要求。只按任务 allowedPaths 实施，再 submit 摘要和可复查证据。先读项目协作文档（如 README 的执行端章节）与任务要求的文档。不得切换 planner 身份、自验放行或改其他文件。如 MCP 不可用，允许同一 wsc-hub.mjs --client trae CLI 完成任务流，但记录真实通道，不冒称 MCP 成功。要求：${task.requirements}\n验收：${JSON.stringify(task.acceptance)}\n允许路径：${JSON.stringify(task.allowedPaths)}`;
          invocationStarted = true;
          const response = await vscode.commands.executeCommand('wx.bridge.sendAndWaitResponse', prompt);
          await fs.writeFile(path.join(HOME, `${task.id}-reply.json`), JSON.stringify({ id: task.id, client: 'trae', at: new Date().toISOString(), response }, null, 2));
          reply({ id: task.id, client: 'trae', nativeInvocationReturned: true, replyFile: path.join(HOME, `${task.id}-reply.json`), completion: '以共享队列 submit 和文件证据为准' });
        } finally { busy = false; if (!invocationStarted && pending === ownPending) pending = undefined; }
      })().catch(() => { reply({ error: 'DISPATCH_FAILED', notSent: !invocationStarted }); });
    });
  });
  server.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  } catch (error) {
    await appendLog('LISTEN_FAILED', error.message);
    server.close(() => {});
    server = undefined;
    return;
  }
  await fs.writeFile(path.join(HOME, 'trae-endpoint.json'), JSON.stringify({ pipe, key, root, pid: process.pid }), { mode: 0o600 });
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: async () => {} }));
  context.subscriptions.push({ dispose: () => { server?.close(); } });
}

function deactivate() { server?.close(); }
module.exports = { activate, deactivate };
