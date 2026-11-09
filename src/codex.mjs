import fs from 'node:fs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {messageDigest} from './share.mjs';

const scriptPath = fileURLToPath(new URL('./app-server.ps1', import.meta.url));

export class CodexServer {
  constructor({codexCommand, sessionHome, workspace}) {
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.child = spawn('pwsh', ['-NoLogo', '-NoProfile', '-File', scriptPath, '-CodexCommand', codexCommand], {
      cwd: workspace,
      env: {...process.env, CODEX_HOME: sessionHome},
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = false;
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', text => { this.stderr = (this.stderr + text).slice(-8000); });
    this.lines = readline.createInterface({input: this.child.stdout});
    this.lines.on('line', line => this.receive(line));
    this.child.on('error', error => this.failAll(error));
    this.child.on('close', code => {
      this.exited = true;
      this.failAll(new Error(`Codex app-server 已退出（${code}）。${this.stderr.slice(-1200)}`));
      this.resolveExit();
    });
    this.child.stdin.on('error', error => this.failAll(error));
  }

  receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      this.child.stdin.write(JSON.stringify({id: message.id, error: {code: -32601, message: 'This import client supports local session storage operations.'}}) + '\n');
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  call(method, params) {
    if (this.exited) return Promise.reject(new Error('Codex app-server 连接已关闭。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 在 45 秒内未完成。${this.stderr.slice(-800)}`));
      }, 45_000);
      this.pending.set(id, {resolve, reject, timer, method});
      this.child.stdin.write(JSON.stringify({id, method, params}) + '\n');
    });
  }

  async initialize() {
    const result = await this.call('initialize', {clientInfo: {name: 'chatgpt-session-import', title: 'ChatGPT to Codex', version: '1.0.0'}, capabilities: {experimentalApi: true, explicitGatewayOauth: true}});
    this.child.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
    return result;
  }

  async close() {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    try { await this.exitPromise; } finally { clearTimeout(timer); this.lines.close(); }
  }
}

function assertMessages(actual, expected, label) {
  if (actual.length !== expected.length || messageDigest(actual) !== messageDigest(expected)) {
    const different = actual.findIndex((item, index) => !expected[index] || item.role !== expected[index].role || item.text !== expected[index].text || (item.phase ?? null) !== (expected[index].phase ?? null));
    throw new Error(`${label}校验失败：期望 ${expected.length} 条消息，读取 ${actual.length} 条；首个差异位置 ${different + 1}。`);
  }
}

export async function verifySession(server, manifest, expected) {
  const read = await server.call('thread/read', {threadId: manifest.threadId, includeTurns: false});
  if (read.thread.id !== manifest.threadId || read.thread.historyMode !== 'paginated') throw new Error('Codex 返回的会话标识或历史模式不匹配。');
  const actual = [];
  const turnIds = new Set();
  const cursors = new Set();
  let cursor;
  do {
    const page = await server.call('thread/turns/list', {threadId: manifest.threadId, limit: 20, sortDirection: 'asc', itemsView: 'full', ...(cursor ? {cursor} : {})});
    for (const turn of page.data) {
      if (turnIds.has(turn.id)) throw new Error('Codex 分页历史出现重复轮次。');
      turnIds.add(turn.id);
      for (const item of turn.items ?? []) {
        if (item.type === 'userMessage') actual.push({role: 'user', text: item.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n'), phase: null});
        else if (item.type === 'agentMessage') actual.push({role: 'assistant', text: item.text, phase: item.phase ?? null});
      }
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex 分页游标没有前进。');
    cursors.add(cursor);
  } while (cursor);
  assertMessages(actual, expected, '界面历史');

  const records = fs.readFileSync(manifest.rolloutPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const context = records.filter(record => record.type === 'response_item' && record.payload.type === 'message' && ['user', 'assistant'].includes(record.payload.role))
    .map(record => ({role: record.payload.role, text: record.payload.content.map(part => part.text ?? '').join('\n\n'), phase: record.payload.phase ?? null}));
  assertMessages(context, expected, '模型上下文');
  if (records.some((record, index) => record.ordinal !== index)) throw new Error('Rollout ordinal 序列不连续。');
  const listed = await server.call('thread/list', {searchTerm: manifest.title, limit: 100, sourceKinds: ['cli'], modelProviders: [], useStateDbOnly: true});
  if (!listed.data.some(thread => thread.id === manifest.threadId)) throw new Error('Codex 会话列表中没有找到导入的会话。');
  return {codexVersion: manifest.codexVersion, nativeMessages: actual.length, contextMessages: context.length, turns: turnIds.size, exactMatch: true, listed: true, messageSha256: messageDigest(expected)};
}

export async function registerAndVerify(options, manifest, expected, server) {
  const resumed = await server.call('thread/resume', {threadId: manifest.threadId, path: manifest.rolloutPath, cwd: manifest.workspace, excludeTurns: true});
  if (resumed.thread.id !== manifest.threadId) throw new Error('Codex 恢复了不同的会话。');
  await server.call('thread/name/set', {threadId: manifest.threadId, name: manifest.title});
  const first = await verifySession(server, manifest, expected);
  await server.close();
  const reopened = new CodexServer(options);
  try {
    await reopened.initialize();
    await reopened.call('thread/resume', {threadId: manifest.threadId, cwd: manifest.workspace, excludeTurns: true});
    const second = await verifySession(reopened, manifest, expected);
    return {...first, ...second, restartVerified: true};
  } finally { await reopened.close(); }
}
