# ChatGPT to Codex

将 ChatGPT 分享链接导入本机 Codex 会话，随后通过 `codex resume` 继续对话。

## 使用

在 PowerShell 7 中运行：

```powershell
$ErrorActionPreference = 'Stop'
& 'C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\Import-ChatGPTSession.ps1' 'https://chatgpt.com/share/你的分享ID'
```

工具自动下载分享页、转换当前分支、创建新会话，并输出可复制的 `codex resume` 命令。默认工作目录是运行命令时所在的目录。

指定后续工作的项目目录：

```powershell
$ErrorActionPreference = 'Stop'
& 'C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\Import-ChatGPTSession.ps1' 'https://chatgpt.com/share/你的分享ID' -Workspace 'D:\项目目录'
```

## 本地 HTML

若网站返回 403、503 或验证页，可在浏览器中打开分享链接，用“网页，仅 HTML”保存完整页面，再执行：

```powershell
$ErrorActionPreference = 'Stop'
& 'C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\Import-ChatGPTSession.ps1' 'https://chatgpt.com/share/你的分享ID' -HtmlPath 'D:\Downloads\conversation.html'
```

HTML 需要包含页面内嵌的对话数据。工具会在创建会话前验证文件内容。

## 参数

| 参数 | 用途 |
| --- | --- |
| `ShareUrl` | 必填，可直接作为第一个参数；接受 HTTPS `/share/` 对话链接 |
| `Workspace` | 后续 Codex 会话的工作目录，默认当前目录 |
| `HtmlPath` | 从本地完整分享页 HTML 导入 |
| `ArchiveRoot` | 原始数据归档目录，默认工具目录下的 `archives` |
| `SessionHome` | Codex 数据目录，默认环境变量 `CODEX_HOME` 或用户目录下的 `.codex` |
| `DryRun` | 下载、解析并显示消息数量 |
| `AsJson` | 输出包含会话 ID、恢复命令和校验结果的 JSON |
| `VerifyManifest` | 通过归档中的 `manifest.json` 重新校验尚未继续对话的导入会话；单独使用 |

每次导入都会创建独立的会话 ID。请使用输出的 ID 恢复对应会话。

## 数据与恢复范围

Codex 会话包含分享分支中的用户消息、助手正文和可见进度消息，保留消息顺序、代码文本及附件名称。助手消息的进度与最终答复分别记录。后续调用使用本机 Codex 配置中的模型和工具。

`archives/<分享ID>-<会话ID>/` 保存：

- `share.html`、`conversation.json`：原始页面和结构化来源。
- `conversation.md`、`messages.json`：可读对话和导入消息。
- `tool-history.jsonl`：分享页提供的历史工具记录，可供后续查阅。
- `attachments.json`：附件与媒体引用清单。
- `manifest.json`：会话信息、来源摘要和校验结果。
- `resume.ps1`：恢复该会话的 PowerShell 入口。

ChatGPT 云端的附件本体、生成文件和容器执行状态需要另行保存、迁移。部分工具输出在分享页中已被 ChatGPT 隐去，可获得的内容以来源页面为准。历史工具记录保存在归档中；模型上下文使用用户和助手的对话正文。

## 环境与校验

需要已安装并配置的 Codex CLI、PowerShell 7 和 Node.js 22.13 或更新版本。工具使用 Node.js 内置模块。

已在 Windows、Codex CLI 0.163.0、Node.js 24.21.0 上验证。会话使用带连续 ordinal 和 `item_completed` 事件的分页历史格式。Codex app-server 负责登记数据库；工具通过分页回读、消息摘要比较和重新启动后的 UUID 恢复检查完整性。校验在本地完成，不发起模型生成。

Codex 的 rollout 和实验性 app-server 字段可能随版本变化，导入以当前安装版本的实际回读校验为准。

运行自动检查：

```powershell
$ErrorActionPreference = 'Stop'
node --test 'C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\test\share.test.mjs'
if ($LASTEXITCODE -ne 0) { throw '检查失败' }
```

参考：[Codex 恢复命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[Codex app-server](https://learn.chatgpt.com/docs/app-server)。React Router 解码逻辑使用 [chatgpt2codex](https://github.com/vv-bogdanov/chatgpt2codex) 的 MIT 授权实现作为基础，许可见 `THIRD_PARTY_LICENSES.txt`。
