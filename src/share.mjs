// React Router decoding is adapted from chatgpt2codex (MIT); see THIRD_PARTY_LICENSES.txt.
import crypto from 'node:crypto';

const ENQUEUE = 'window.__reactRouterContext.streamController.enqueue(';
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isHidden = message => ['is_visually_hidden_from_conversation', 'is_hidden', 'hidden']
  .some(key => message.metadata?.[key] === true);

export function extractPayloads(html) {
  const payloads = [];
  let offset = 0;
  while (true) {
    const start = html.indexOf(ENQUEUE, offset);
    if (start < 0) return payloads;
    let cursor = start + ENQUEUE.length;
    while (/\s/.test(html[cursor] ?? '')) cursor++;
    if (html[cursor] !== '"') throw new Error('分享页中的 React Router 数据格式无法识别。');
    let escaped = false;
    let end = cursor + 1;
    for (; end < html.length; end++) {
      if (escaped) { escaped = false; continue; }
      if (html[end] === '\\') { escaped = true; continue; }
      if (html[end] === '"') break;
    }
    if (end === html.length) throw new Error('分享页数据不完整，请重新保存整个 HTML 页面。');
    payloads.push(JSON.parse(html.slice(cursor, end + 1)));
    offset = end + 1;
  }
}

export function decodeTable(table) {
  if (!Array.isArray(table)) throw new Error('分享页数据不是有效的引用表。');
  const memo = new Map();
  const special = new Map([[-1, undefined], [-2, NaN], [-3, Infinity], [-4, -Infinity], [-5, -0], [-6, undefined], [-7, undefined]]);
  function decodeRef(value) {
    if (Number.isInteger(value)) {
      if (value < 0) return special.get(value);
      return decodeIndex(value);
    }
    if (Array.isArray(value)) return value.map(decodeRef);
    if (isRecord(value)) return decodeObject(value);
    return value;
  }
  function decodeObject(value, output = Object.create(null)) {
    for (const [key, entry] of Object.entries(value)) {
      const match = /^_(\d+)$/.exec(key);
      const decodedKey = match ? decodeIndex(Number(match[1])) : key;
      if (typeof decodedKey === 'string') output[decodedKey] = decodeRef(entry);
    }
    return output;
  }
  function decodeIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= table.length) {
      throw new Error(`分享页包含无效的引用表索引：${index}`);
    }
    if (memo.has(index)) return memo.get(index);
    const value = table[index];
    if (Array.isArray(value)) {
      const result = [];
      memo.set(index, result);
      for (const entry of value) result.push(decodeRef(entry));
      return result;
    }
    if (isRecord(value)) {
      const result = Object.create(null);
      memo.set(index, result);
      return decodeObject(value, result);
    }
    return value;
  }
  return decodeIndex(0);
}

function findConversation(root) {
  const queue = [root];
  const seen = new Set();
  for (let index = 0; index < queue.length && index < 100_000; index++) {
    const value = queue[index];
    if ((!isRecord(value) && !Array.isArray(value)) || seen.has(value)) continue;
    seen.add(value);
    if (isRecord(value) && (Array.isArray(value.linear_conversation)
      || (isRecord(value.mapping) && typeof value.current_node === 'string'))) return value;
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === 'object') queue.push(child);
    }
  }
}

export function selectBranch(conversation) {
  if (isRecord(conversation.mapping) && typeof conversation.current_node === 'string') {
    const nodes = [];
    const seen = new Set();
    let id = conversation.current_node;
    while (id) {
      if (seen.has(id)) throw new Error('分享对话的分支关系包含循环。');
      seen.add(id);
      const node = conversation.mapping[id];
      if (!isRecord(node)) throw new Error(`分享对话缺少分支节点：${id}`);
      nodes.push(node);
      id = node.parent;
    }
    return nodes.reverse();
  }
  if (Array.isArray(conversation.linear_conversation)) return conversation.linear_conversation;
  throw new Error('分享页没有可导入的对话分支。');
}

function textPart(part, mediaReferences) {
  if (typeof part === 'string') return part;
  if (!isRecord(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (Array.isArray(part.parts)) return part.parts.map(value => textPart(value, mediaReferences)).filter(Boolean).join('\n\n');
  if (part.content_type?.includes('image')) {
    mediaReferences.push({type: part.content_type, reference: part.asset_pointer ?? null});
    return '[ChatGPT 图像引用]';
  }
  if (part.name || part.file_name) {
    const name = part.name ?? part.file_name;
    mediaReferences.push({type: part.content_type ?? 'file', name});
    return `[ChatGPT 文件引用：${name}]`;
  }
  if (part.content_type) {
    mediaReferences.push({type: part.content_type});
    return `[ChatGPT 媒体引用：${part.content_type}]`;
  }
  return '';
}

export function normalizeConversation(conversation) {
  const branch = selectBranch(conversation);
  const messages = [];
  const attachments = [];
  const mediaReferences = [];
  const toolHistory = [];
  const statistics = {branchNodes: branch.length, userMessages: 0, assistantMessages: 0, commentaryMessages: 0, finalAnswers: 0, sourceTextCharacters: 0, attachmentReferences: 0, mediaReferences: 0, toolRecords: 0, redactedToolOutputs: 0};
  for (const node of branch) {
    const message = node.message;
    if (!isRecord(message) || isHidden(message)) continue;
    const role = message.author?.role;
    const recipient = message.recipient ?? 'all';
    if (role === 'tool' || (role === 'assistant' && recipient !== 'all')) {
      toolHistory.push({nodeId: node.id, message});
      if (role === 'tool' && JSON.stringify(message.content).includes('The output of this plugin was redacted.')) statistics.redactedToolOutputs++;
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    const content = message.content;
    if (isRecord(content) && !['text', 'multimodal_text', 'code', 'audio_transcription'].includes(content.content_type)) continue;
    let text = typeof content === 'string' ? content : '';
    if (Array.isArray(content?.parts)) text = content.parts.map(part => textPart(part, mediaReferences)).filter(Boolean).join('\n\n');
    else if (typeof content?.text === 'string') text = content.text;
    statistics.sourceTextCharacters += text.length;
    const files = (message.metadata?.attachments ?? []).filter(isRecord).map(file => ({
      sourceMessageId: message.id ?? node.id,
      id: file.id ?? null,
      name: file.name ?? file.file_name ?? 'attachment',
      mimeType: file.mime_type ?? null,
      size: file.size ?? null,
    }));
    attachments.push(...files);
    if (files.length) text += `${text ? '\n\n' : ''}[ChatGPT 附件引用：${files.map(file => file.name).join('；')}]`;
    if (!text.trim()) continue;
    const phase = role === 'assistant' ? (message.channel === 'commentary' ? 'commentary' : 'final_answer') : null;
    messages.push({sourceId: message.id ?? node.id, sourceCreatedAt: message.create_time ?? null, role, text, phase});
    if (role === 'user') statistics.userMessages++;
    else {
      statistics.assistantMessages++;
      if (phase === 'commentary') statistics.commentaryMessages++;
      else statistics.finalAnswers++;
    }
  }
  if (!messages.length || !statistics.userMessages) throw new Error('分享页中没有可导入的用户对话。');
  statistics.attachmentReferences = attachments.length;
  statistics.mediaReferences = mediaReferences.length;
  statistics.toolRecords = toolHistory.length;
  return {title: conversation.title || 'ChatGPT 对话', messages, attachments, mediaReferences, toolHistory, statistics};
}

export function parseShare(html) {
  const payloads = extractPayloads(html);
  if (!payloads.length) throw new Error('HTML 中没有 ChatGPT 分享对话数据；请确认保存的是完整分享页，而非登录页或验证页。');
  let detail = '';
  for (const payload of payloads) {
    try {
      if (!payload.trimStart().startsWith('[')) continue;
      const conversation = findConversation(decodeTable(JSON.parse(payload)));
      if (conversation) return {conversation, ...normalizeConversation(conversation)};
    } catch (error) { detail = error.message; }
  }
  throw new Error(`无法解析分享对话。${detail}`);
}

export function buildRollout({messages, threadId, importedAt, cwd, codexVersion, modelProvider}) {
  const records = [];
  const clock = Date.parse(importedAt);
  const push = (type, payload) => records.push({timestamp: new Date(clock).toISOString(), ordinal: records.length, type, payload});
  push('session_meta', {id: threadId, session_id: threadId, timestamp: importedAt, cwd, runtime_workspace_roots: [cwd], originator: 'chatgpt-session-import', cli_version: codexVersion, source: 'cli', thread_source: 'user', model_provider: modelProvider, history_mode: 'paginated'});
  let turnId;
  let lastAnswer = null;
  let turns = 0;
  const finishTurn = () => {
    if (turnId) push('event_msg', {type: 'task_complete', turn_id: turnId, last_agent_message: lastAnswer});
  };
  for (const message of messages) {
    if (message.role === 'user' || !turnId) {
      finishTurn();
      turnId = crypto.randomUUID();
      lastAnswer = null;
      turns++;
      push('event_msg', {type: 'task_started', turn_id: turnId, collaboration_mode_kind: 'default'});
    }
    const id = `msg_${crypto.randomUUID()}`;
    const response = {type: 'message', id, role: message.role, content: [{type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text}]};
    if (message.role === 'assistant') response.phase = message.phase;
    const item = message.role === 'user'
      ? {type: 'UserMessage', id: crypto.randomUUID(), client_id: null, content: [{type: 'text', text: message.text, text_elements: []}]}
      : {type: 'AgentMessage', id, content: [{type: 'Text', text: message.text}], phase: message.phase};
    if (message.role === 'user') push('response_item', response);
    push('event_msg', {type: 'item_completed', thread_id: threadId, turn_id: turnId, item, started_at_ms: clock, completed_at_ms: clock});
    if (message.role === 'assistant') {
      push('response_item', response);
      lastAnswer = message.text;
    }
  }
  finishTurn();
  return {records, turns};
}

export const messageDigest = messages => crypto.createHash('sha256').update(JSON.stringify(messages.map(({role, text, phase}) => ({role, text, phase: phase ?? null})))).digest('hex');
