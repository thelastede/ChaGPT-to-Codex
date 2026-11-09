import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRollout, decodeTable, extractPayloads, normalizeConversation, parseShare, selectBranch} from '../src/share.mjs';

function node(id, parent, role, text, extra = {}) {
  return {id, parent, message: {id, author: {role}, recipient: 'all', content: {content_type: 'text', parts: [text]}, ...extra}};
}

test('current_node selects the chosen branch instead of sibling answers', () => {
  const mapping = {
    root: node('root', null, 'user', '问题'),
    left: node('left', 'root', 'assistant', '分支甲'),
    right: node('right', 'root', 'assistant', '分支乙'),
  };
  const data = {current_node: 'right', mapping, linear_conversation: Object.values(mapping)};
  assert.deepEqual(selectBranch(data).map(item => item.id), ['root', 'right']);
  assert.deepEqual(normalizeConversation(data).messages.map(item => item.text), ['问题', '分支乙']);
});

test('missing and cyclic branch nodes fail explicitly', () => {
  assert.throws(() => selectBranch({current_node: 'missing', mapping: {}}), /缺少/);
  assert.throws(() => selectBranch({current_node: 'a', mapping: {a: {parent: 'b'}, b: {parent: 'a'}}}), /循环/);
});

test('user text, code, phases and attachment names survive normalization', () => {
  const code = '  中文 "引号"\n```powershell\n$x = 1\n```\n';
  const data = {linear_conversation: [
    node('u', null, 'user', code, {metadata: {attachments: [{id: 'file-a', name: '材料.zip', size: 123}]}}),
    node('a1', 'u', 'assistant', '正在分析', {channel: 'commentary'}),
    node('a2', 'a1', 'assistant', '结果。', {channel: 'final'}),
  ]};
  const result = normalizeConversation(data);
  assert.equal(result.messages[0].text, code + '\n\n[ChatGPT 附件引用：材料.zip]');
  assert.deepEqual(result.messages.map(message => message.phase), [null, 'commentary', 'final_answer']);
  assert.equal(result.attachments[0].name, '材料.zip');
});

test('tool calls and outputs are archived as tools rather than assistant answers', () => {
  const data = {linear_conversation: [
    node('u', null, 'user', '分析数据'),
    node('code', 'u', 'assistant', '', {recipient: 'python', content: {content_type: 'code', text: 'print(42)'}}),
    node('out', 'code', 'tool', '', {author: {role: 'tool', name: 'python'}, content: {content_type: 'execution_output', text: '42'}}),
    node('hidden', 'out', 'assistant', '隐藏内容', {metadata: {is_hidden: true}}),
    node('reason', 'hidden', 'assistant', '', {content: {content_type: 'thoughts', thoughts: []}}),
    node('answer', 'reason', 'assistant', '结果为 42。', {channel: 'final'}),
  ]};
  const result = normalizeConversation(data);
  assert.deepEqual(result.messages.map(message => message.text), ['分析数据', '结果为 42。']);
  assert.equal(result.toolHistory.length, 2);
});

test('React Router strings are decoded as data, including escaped quotes and Unicode', () => {
  const payload = JSON.stringify([{_1: 2}, 'text', '中文 "quote" \\path\nnext']);
  const html = `<script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(payload)});</script>`;
  assert.deepEqual(extractPayloads(html), [payload]);
  assert.equal(decodeTable(JSON.parse(payload)).text, '中文 "quote" \\path\nnext');
  assert.throws(() => extractPayloads('window.__reactRouterContext.streamController.enqueue(fetch("url"))'), /格式/);
  assert.throws(() => parseShare('<html>Login</html>'), /没有/);
});

test('reference-table object keys do not modify object prototypes', () => {
  const decoded = decodeTable([{_1: 2}, '__proto__', {_3: 4}, 'polluted', true]);
  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(decoded.__proto__.polluted, true);
  assert.equal({}.polluted, undefined);
});

test('paginated rollout retains every message once in context and once in display history', () => {
  const messages = [
    {role: 'user', text: '第一问', phase: null},
    {role: 'assistant', text: '进度', phase: 'commentary'},
    {role: 'assistant', text: '第一答', phase: 'final_answer'},
    {role: 'user', text: '第二问', phase: null},
    {role: 'assistant', text: '第二答', phase: 'final_answer'},
  ];
  const result = buildRollout({messages, threadId: 'ecfe7e72-aa2f-4fdf-9e6e-f49514640489', importedAt: '2026-11-09T12:00:00.000Z', cwd: 'C:\\测试', codexVersion: '0.163.0', modelProvider: 'custom'});
  assert.equal(result.turns, 2);
  assert.deepEqual(result.records.map(record => record.ordinal), result.records.map((_, index) => index));
  const context = result.records.filter(record => record.type === 'response_item');
  const visible = result.records.filter(record => record.payload.type === 'item_completed');
  assert.deepEqual(context.map(record => record.payload.content[0].text), messages.map(message => message.text));
  assert.deepEqual(visible.map(record => record.payload.item.content[0].text), messages.map(message => message.text));
  assert.equal(new Set(context.map(record => record.payload.id)).size, messages.length);
  assert.equal(result.records[0].payload.history_mode, 'paginated');
  assert.equal(result.records[0].payload.model_provider, 'custom');
});
