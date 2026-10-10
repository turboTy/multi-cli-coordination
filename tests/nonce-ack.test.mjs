import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROOT, createHub } from '../tools/wsc-hub.mjs';
import { callBridge, dispatchTask } from '../tools/desktop-dispatch.mjs';

// 契约 §3 验收：判据与 prompt 构造都是纯函数，在宿主外直接调用；只碰临时目录，绝不连真实桥。
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const traeBridge = require(path.join(HERE, '..', 'tools', 'desktop', 'trae', 'extension.cjs'));
const wbBridge = require(path.join(HERE, '..', 'tools', 'desktop', 'workbuddy', 'server', 'index.cjs'));
const BRIDGES = [['trae', traeBridge], ['workbuddy', wbBridge]];
const NONCE = 'MCC-ACK-de41beef';
const SENTENCE = `【回执】完成后必须在回复中原文包含一次性令牌 ${NONCE}，不得改写或省略。`;

async function approvedTaskHub(label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nonce-${label}-root-`));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `nonce-${label}-home-`));
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination', 'board.json'), `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`);
  return { root, home, hub: createHub({ root, client: 'ds' }) };
}

async function makeTask(hub, id, owner = 'trae') {
  await hub.run('create', { id, title: `回执测试 ${id}`, requirements: '契约 §3 测试任务', acceptance: ['node --test tests/nonce-ack.test.mjs 全绿'], allowedPaths: ['tools/x.mjs'], owner });
  await hub.run('approve', { id });
}

function recordCall(calls) {
  return async (action, id, options) => {
    calls.push({ action, id, ...options });
    return options.client === 'trae' ? { client: 'trae', id, nativeInvocationReturned: true } : { client: 'workbuddy', id, nativeInvocationSent: true };
  };
}

const liveRoute = async ({ client }) => ({ client, state: 'live', cached: false, presence: { client, state: 'live', heartbeatAt: new Date().toISOString() } });

test('契约 §3：回复原文包含令牌 → match=nonce，replyText 保留原文', () => {
  for (const [name, bridge] of BRIDGES) {
    const reply = `已按允许路径完成 tools/x.mjs。\n自验：node --test 全绿。\n【回执】${NONCE}\n以上。`;
    const verdict = bridge.judgeAck(reply, NONCE);
    assert.equal(verdict.requested, true, name);
    assert.equal(verdict.matchesExpected, true, name);
    assert.equal(verdict.match, 'nonce', name);
    assert.equal(verdict.replyText, reply, `${name} 必须逐字保留原始回复文本`);
  }
});

test('契约 §3：回复没有令牌 → match=none，不得伪装通过', () => {
  for (const [name, bridge] of BRIDGES) {
    const reply = '任务已完成并 submit，证据见提交摘要。';
    assert.deepEqual(bridge.judgeAck(reply, NONCE), { requested: true, matchesExpected: false, match: 'none', replyText: reply }, name);
    assert.equal(bridge.judgeAck({ text: '结构化回复里没有令牌' }, NONCE).match, 'none', name);
    assert.equal(bridge.judgeAck({ content: [{ type: 'text', text: '分块回复里没有令牌' }] }, NONCE).match, 'none', name);
    assert.equal(bridge.judgeAck(undefined, NONCE).match, 'none', name);
  }
});

test('契约 §3：近似令牌一律判负——不存在模糊或语义匹配分支', () => {
  const nearMisses = [
    'MCC-ACK-DE41BEEF 令牌在此（大小写不同）',
    'MCC-ACK-de41bee 令牌在此（少一字符）',
    'MCC-ACK-de41 beef 令牌在此（中间多空格）',
    'MCC_ACK_de41beef 令牌在此（分隔符不同）',
    'MCC-ACK- 令牌在此（只剩前缀）',
    'de41beef 令牌在此（只剩后缀）',
    '一次性令牌已原文带回，只是没写那串十六进制（语义等价改写）',
  ];
  for (const [name, bridge] of BRIDGES) {
    for (const reply of nearMisses) assert.equal(bridge.judgeAck(reply, NONCE).match, 'none', `${name} 对近似令牌必须判负：${reply}`);
    assert.equal(bridge.judgeAck(`前缀 ${NONCE} 后缀里再出现一次 ${NONCE}`, NONCE).match, 'nonce', `${name}：令牌作为子串出现即命中`);
    // 契约 §3 判据是 reply.includes(nonce)：逐字包含令牌的超串按契约即为命中，不是模糊匹配。
    assert.equal(bridge.judgeAck(`${NONCE}0 令牌在此（逐字含令牌后再加一字符）`, NONCE).match, 'nonce', `${name}：超串含令牌原文即命中`);
  }
});

test('契约 §3：请求侧没有有效令牌 → match=not-requested，不冒充已验证', () => {
  for (const [name, bridge] of BRIDGES) {
    for (const nonce of [undefined, null, '', 'MCC-ACK-ZZZZZZZZ', 'MCC-ACK-de41be', '随便一串']) {
      const verdict = bridge.judgeAck('回复正文', nonce);
      assert.equal(verdict.requested, false, `${name} nonce=${nonce}`);
      assert.equal(verdict.match, 'not-requested', `${name} nonce=${nonce}`);
      assert.equal(verdict.matchesExpected, false, `${name} nonce=${nonce}`);
      assert.equal(verdict.replyText, '回复正文', name);
    }
    assert.equal(bridge.NONCE_PATTERN.test(NONCE), true, name);
  }
});

test('契约 §3：固定回执句只在有效令牌时追加，追加在末尾且只追加一次', () => {
  const base = '你是本项目的执行端。要求：…\n验收：[…]';
  for (const [name, bridge] of BRIDGES) {
    const prompt = bridge.buildDeliveryPrompt(base, NONCE);
    assert.equal(prompt, `${base}\n${SENTENCE}`, name);
    assert.equal(prompt.split(SENTENCE).length - 1, 1, `${name} 固定句只能出现一次`);
    assert.equal(prompt.startsWith(base), true, `${name} 原 prompt 不得被改写`);
    assert.equal(prompt.endsWith(SENTENCE), true, `${name} 固定句必须追加在末尾`);
    assert.equal(bridge.buildDeliveryPrompt(base, undefined), base, `${name}：无令牌不得追加`);
    assert.equal(bridge.buildDeliveryPrompt(base, ''), base, name);
    assert.equal(bridge.buildDeliveryPrompt(base, 'MCC-ACK-ZZZZZZZZ'), base, `${name}：非法形状令牌不得追加`);
    assert.equal(bridge.ackInstruction(NONCE), SENTENCE, name);
  }
});

test('契约 §3：打印 prompt 构造器真实输出（证据，非断言）', () => {
  const base = '你是本项目的 TRAE 执行端。请现在实际调用 wsc_list/get…允许路径：["tools/x.mjs"]';
  const prompt = traeBridge.buildDeliveryPrompt(base, NONCE);
  console.log('[nonce-ack 证据] 投递 prompt 全文如下:\n' + prompt);
  console.log('[nonce-ack 证据] 末行: ' + JSON.stringify(prompt.split('\n').at(-1)));
  console.log('[nonce-ack 证据] 判定: ' + JSON.stringify(traeBridge.judgeAck(prompt, NONCE).match));
  assert.ok(prompt.includes(NONCE));
});

test('契约 §3：台账记录 replyText 与 match，无令牌记 not-requested 而非通过', () => {
  const task = { id: 'NONCE-LEDGER-001' };
  const reply = `交付完成，令牌 ${NONCE}`;
  const hit = traeBridge.ackLedger({ task, nonce: NONCE, verdict: traeBridge.judgeAck(reply, NONCE), payload: reply });
  assert.deepEqual(Object.keys(hit).sort(), ['at', 'client', 'id', 'match', 'matchesExpected', 'nonce', 'replyText', 'response']);
  assert.equal(hit.client, 'trae');
  assert.equal(hit.match, 'nonce');
  assert.equal(hit.matchesExpected, true);
  assert.equal(hit.replyText, reply);
  assert.equal(hit.nonce, NONCE);

  const missing = wbBridge.ackLedger({ task, conversationId: 'c-1', nonce: undefined, verdict: wbBridge.judgeAck(reply, undefined), result: reply });
  assert.equal(missing.match, 'not-requested');
  assert.equal(missing.matchesExpected, false);
  assert.equal(missing.nonce, null);
  assert.equal(missing.replyText, reply);
  assert.equal(missing.result, reply);
  assert.equal('error' in missing, false);

  const failed = wbBridge.ackLedger({ task, conversationId: 'c-1', nonce: NONCE, verdict: wbBridge.judgeAck(undefined, NONCE), error: 'HOST_RESPONSE_TIMEOUT' });
  assert.equal(failed.match, 'none');
  assert.equal(failed.replyText, '');
  assert.equal(failed.error, 'HOST_RESPONSE_TIMEOUT');
  assert.equal('result' in failed, false);
});

test('契约 §3：首投时令牌尚未铸造 → 桥调用不带 nonce，队列随后铸造', async () => {
  const { home, hub } = await approvedTaskHub('transport-first');
  await makeTask(hub, 'NONCE-FIRST-001');
  const calls = [];
  const result = await dispatchTask('NONCE-FIRST-001', { hub, home, call: recordCall(calls), resolve: liveRoute });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'dispatch');
  assert.equal('nonce' in calls[0], false, '首投不得凭空捏造令牌');
  assert.match(result.delivery.nonce, /^MCC-ACK-[0-9a-f]{8}$/);
  const task = await hub.run('get', { id: 'NONCE-FIRST-001' });
  assert.equal(task.status, 'dispatched');
  assert.equal(task.nonce, result.delivery.nonce);
});

test('契约 §3：队列已铸造令牌后重新投递 → 桥调用携带同一 nonce', async () => {
  const { home, hub } = await approvedTaskHub('transport-retry');
  await makeTask(hub, 'NONCE-RETRY-001');
  const minted = await hub.run('dispatch', { id: 'NONCE-RETRY-001', channel: 'mcc-trae', state: 'not-sent', error: 'ROUTE_DEAD: 探针连接失败' });
  assert.match(minted.nonce, /^MCC-ACK-[0-9a-f]{8}$/);
  assert.equal(minted.status, 'approved');
  const calls = [];
  const result = await dispatchTask('NONCE-RETRY-001', { hub, home, call: recordCall(calls), resolve: liveRoute });
  assert.equal(calls[0].nonce, minted.nonce, '桥调用必须收到队列里的令牌');
  assert.equal(calls[0].client, 'trae');
  assert.equal(result.status, 'dispatched');
  assert.equal(result.delivery.nonce, minted.nonce, '重投不得更换令牌');
});

test('契约 §3：判据源码只有 includes 精确子串判定，无折叠/归一化/相似度分支', () => {
  const forbidden = /toLowerCase|toUpperCase|\.normalize\(|localeCompare|levenshtein|similarity|fuzzy|semantic|\breplace\(/;
  for (const [name, bridge] of BRIDGES) {
    const src = `${bridge.judgeAck.toString()}\n${bridge.buildDeliveryPrompt.toString()}\n${bridge.replyTextOf.toString()}`;
    assert.match(src, /replyText\.includes\(nonce\)/, `${name} 判据必须是 replyText.includes(nonce)`);
    assert.doesNotMatch(src, forbidden, `${name} 判据不得含模糊匹配分支`);
  }
});

test('契约 §3：真实命名管道往返 → 桥收到的派发载荷确实携带 nonce', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'nonce-pipe-'));
  const ROOT_URL = ROOT.replaceAll('\\', '/');
  const seen = [];
  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString('utf8');
      if (!data.includes('\n')) return;
      const req = JSON.parse(data.split('\n')[0]);
      seen.push(req);
      socket.end(JSON.stringify(req.action === 'status'
        ? { client: 'trae', version: '0.0.0-test', root: ROOT_URL, busy: false, sessionBindingConfigured: true, currentSessionId: 's-1', targetSessionId: 's-1' }
        : { client: 'trae', id: req.id, nativeInvocationReturned: true }) + '\n');
    });
    socket.on('error', () => {});
  });
  const pipe = `\\\\.\\pipe\\wsc-trae-nonce-${crypto.randomUUID()}`;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  await fs.writeFile(path.join(home, 'trae-endpoint.json'), JSON.stringify({ pipe, key: 'a'.repeat(64), root: ROOT_URL, pid: process.pid }));
  try {
    await callBridge('dispatch', 'NONCE-PIPE-001', { home, client: 'trae', approvalKey: 'k-1', nonce: NONCE });
    await callBridge('dispatch', 'NONCE-PIPE-002', { home, client: 'trae', approvalKey: 'k-2' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const [first, second] = seen.filter(x => x.action === 'dispatch');
  assert.equal(first.id, 'NONCE-PIPE-001');
  assert.equal(first.nonce, NONCE, '令牌必须真的过管道送到桥');
  assert.equal(first.approvalKey, 'k-1');
  assert.equal('nonce' in second, false, '队列未铸造令牌时不得伪造字段');
});
