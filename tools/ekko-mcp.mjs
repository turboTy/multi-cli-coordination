#!/usr/bin/env node
// 为独立 WSC Ekko 实例获取登录态；凭据只保存在用户本地目录。
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = join(homedir(), '.local/share/wsc-hub');
const state = join(base, 'ekko-state');
const url = 'http://127.0.0.1:8648';
const category = process.argv[2] || 'use';
if (!['api', 'use', 'plan', 'browser', 'devices'].includes(category)) {
  process.stderr.write('未知 Ekko 工具集。\n');
  process.exit(1);
}
try {
  const login = JSON.parse(readFileSync(join(state, 'wsc-login.json'), 'utf8'));
  if (typeof login.username !== 'string' || !login.username || typeof login.password !== 'string' || !login.password) throw new Error('invalid-login');
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: login.username, password: login.password }),
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Ekko 登录失败 HTTP ${response.status}`);
  const auth = await response.json();
  if (typeof auth.token !== 'string' || !auth.token) throw new Error('Ekko 没有返回有效登录态');
  process.env.HERMES_WEB_UI_URL = url;
  process.env.HERMES_WEB_UI_HOME = state;
  process.env.HERMES_WEB_UI_TOKEN = auth.token;
  // 在同一进程加载官方入口，客户端结束进程时不会遗留认证包装器的后代。
  await import(pathToFileURL(join(base, 'ekko/node_modules/ekko-studio/bin/ekko-studio-mcp.mjs')).href);
} catch {
  // JSON 解析异常可能带原始内容；任何认证失败都只输出固定提示。
  process.stderr.write('Ekko 连接或认证失败；请检查本地服务与登录文件。\n');
  process.exitCode = 1;
}
