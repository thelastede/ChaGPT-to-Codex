import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseShare, buildRollout} from './share.mjs';
import {CodexServer, registerAndVerify, verifySession} from './codex.mjs';

const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const quotePowerShell = value => "'" + value.replaceAll("'", "''") + "'";

function report(manifest) {
  console.log(JSON.stringify({title: manifest.title, threadId: manifest.threadId, resumeCommand: manifest.resumeCommand, archiveDirectory: manifest.archiveDirectory, rolloutPath: manifest.rolloutPath, statistics: manifest.statistics, verification: manifest.verification}, null, 2));
}

function writeArchive(directory, parsed, options, manifest) {
  fs.copyFileSync(options.htmlPath, path.join(directory, 'share.html'), fs.constants.COPYFILE_EXCL);
  writeJson(path.join(directory, 'conversation.json'), parsed.conversation);
  writeJson(path.join(directory, 'messages.json'), parsed.messages);
  writeJson(path.join(directory, 'attachments.json'), {files: parsed.attachments, media: parsed.mediaReferences});
  fs.writeFileSync(path.join(directory, 'tool-history.jsonl'), parsed.toolHistory.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  const transcript = [`# ${manifest.title}`, '', `来源：${manifest.shareUrl}`, ''];
  for (const message of parsed.messages) {
    transcript.push(`## ${message.role === 'user' ? '用户' : message.phase === 'commentary' ? '助手 · 进度' : '助手'}`, '', message.text, '');
  }
  fs.writeFileSync(path.join(directory, 'conversation.md'), transcript.join('\n'), 'utf8');
  fs.writeFileSync(path.join(directory, 'resume.ps1'), `$ErrorActionPreference = 'Stop'\n${manifest.resumeCommand}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'README.md'), `# ${manifest.title}\n\n来源：[ChatGPT 分享页](${manifest.shareUrl})\n\n本地会话：\`${manifest.threadId}\`\n\n在 PowerShell 7 中继续：\n\n\`\`\`powershell\n${manifest.resumeCommand}\n\`\`\`\n\n工作目录：\`${manifest.workspace}\`\n\n会话包含 ${parsed.statistics.userMessages} 条用户消息和 ${parsed.statistics.assistantMessages} 条助手正文，保留进度消息及最终答复的区分。附件名称以引用文本保留。\n\n- \`conversation.md\`：可阅读的对话记录。\n- \`messages.json\`：导入消息及来源标识。\n- \`share.html\`、\`conversation.json\`：来源页面与结构化数据。\n- \`tool-history.jsonl\`：分享页提供的历史工具记录。\n- \`attachments.json\`：附件和媒体引用清单。\n- \`manifest.json\`：会话路径、来源摘要和完整性校验结果。\n\n继续处理文件时，请将原 ChatGPT 会话中的附件及生成文件保存到工作目录。Codex 使用本机环境执行后续操作。\n`, 'utf8');
}

async function importSession(options) {
  const html = fs.readFileSync(options.htmlPath, 'utf8');
  const parsed = parseShare(html);
  parsed.title = String(parsed.title).replace(/[\r\n\x00-\x1f]+/g, ' ').trim().slice(0, 200) || 'ChatGPT 对话';
  if (options.dryRun) {
    console.log(JSON.stringify({dryRun: true, title: parsed.title, statistics: parsed.statistics}, null, 2));
    return;
  }

  const server = new CodexServer(options);
  let manifest;
  try {
    await server.initialize();
    const effective = await server.call('config/read', {cwd: options.workspace, includeLayers: false});
    const modelProvider = effective.config.model_provider ?? 'openai';
    const threadId = crypto.randomUUID();
    const importedAt = new Date().toISOString();
    const shareId = new URL(options.shareUrl).pathname.split('/').filter(Boolean).at(-1);
    const archiveDirectory = path.join(options.archiveRoot, `${shareId}-${threadId}`);
    fs.mkdirSync(options.archiveRoot, {recursive: true});
    fs.mkdirSync(archiveDirectory);
    const sessionDirectory = path.join(options.sessionHome, 'sessions', importedAt.slice(0, 4), importedAt.slice(5, 7), importedAt.slice(8, 10));
    const rolloutPath = path.join(sessionDirectory, `rollout-${importedAt.slice(0, 19).replaceAll(':', '-')}-${threadId}.jsonl`);
    const built = buildRollout({messages: parsed.messages, threadId, importedAt, cwd: options.workspace, codexVersion: options.codexVersion, modelProvider});
    manifest = {
      formatVersion: 1,
      toolVersion: '1.0.0',
      title: parsed.title,
      threadId,
      shareUrl: options.shareUrl,
      sourceSha256: crypto.createHash('sha256').update(html).digest('hex'),
      sourceConversationId: parsed.conversation.conversation_id ?? null,
      sourceCreatedAt: parsed.conversation.create_time ?? null,
      importedAt,
      codexVersion: options.codexVersion,
      sessionHome: options.sessionHome,
      workspace: options.workspace,
      modelProvider,
      model: effective.config.model ?? null,
      historyMode: 'paginated',
      archiveDirectory,
      rolloutPath,
      resumeCommand: `codex resume ${threadId} -C ${quotePowerShell(options.workspace)}`,
      statistics: parsed.statistics,
      verification: {status: 'pending'},
    };
    writeArchive(archiveDirectory, parsed, options, manifest);
    writeJson(path.join(archiveDirectory, 'manifest.json'), manifest);
    fs.mkdirSync(sessionDirectory, {recursive: true});
    fs.writeFileSync(rolloutPath, built.records.map(record => JSON.stringify(record)).join('\n') + '\n', {encoding: 'utf8', flag: 'wx'});
    manifest.verification = await registerAndVerify(options, manifest, parsed.messages, server);
    writeJson(path.join(archiveDirectory, 'manifest.json'), manifest);
    report(manifest);
  } catch (error) {
    if (manifest) {
      manifest.verification = {status: 'failed', error: error.message};
      writeJson(path.join(manifest.archiveDirectory, 'manifest.json'), manifest);
      error.message += `\n导入记录：${path.join(manifest.archiveDirectory, 'manifest.json')}`;
    }
    throw error;
  } finally { await server.close(); }
}

async function verifyImport(options) {
  const manifest = JSON.parse(fs.readFileSync(options.verifyManifest, 'utf8'));
  const messages = JSON.parse(fs.readFileSync(path.join(path.dirname(options.verifyManifest), 'messages.json'), 'utf8'));
  const server = new CodexServer({...options, sessionHome: manifest.sessionHome, workspace: manifest.workspace});
  try {
    await server.initialize();
    await server.call('thread/resume', {threadId: manifest.threadId, cwd: manifest.workspace, excludeTurns: true});
    manifest.verification = {...await verifySession(server, manifest, messages), restartVerified: true};
    writeJson(options.verifyManifest, manifest);
    report(manifest);
  } finally { await server.close(); }
}

try {
  if (!process.argv[2]) throw new Error('请通过 Import-ChatGPTSession.ps1 运行此工具。');
  const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (options.verifyManifest) await verifyImport(options);
  else await importSession(options);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
