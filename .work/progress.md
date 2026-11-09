# ChatGPT to Codex importer progress

Status: Complete. User requested a reusable share-URL importer in Desktop\软件 and import of their supplied conversation.
Tool: C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\Import-ChatGPTSession.ps1
Documentation: README.md in the tool directory. Node modules in src/, focused tests in test/, MIT decoder attribution in THIRD_PARTY_LICENSES.txt.
All commands used pwsh, Stop errors, explicit UTF8 I/O. No subagents, no model-generation calls, no writes to existing session rollouts, no credential reads. Each import creates a new UUID. Codex app-server registers database state.

Delivered session:
- Title: 分支 · 实验数据源与修正
- Source: https://chatgpt.com/share/6af1bb40-3a3c-83ee-85cc-3325baa08d14
- ID: c6c10597-7413-4902-b820-448b904d7fbc
- Workspace: C:\Users\thelastede
- Codex home: C:\Users\thelastede\.codex
- Resume: codex resume c6c10597-7413-4902-b820-448b904d7fbc -C 'C:\Users\thelastede'
- Archive: C:\Users\thelastede\Desktop\软件\ChatGPT-to-Codex\archives\6af1bb40-3a3c-83ee-85cc-3325baa08d14-c6c10597-7413-4902-b820-448b904d7fbc
- Statistics: 48 user +100 assistant messages (56 commentary,44 final),48 turns;13 attachment references;1252 archived tool records;497 source-redacted tool outputs.
- Native format: history_mode paginated, sequential ordinals, response_item messages plus item_completed events and turn boundaries.

Validation:
- Codex 0.163.0, Node24.21.0, PowerShell7.
- 7 focused Node tests pass; PowerShell parser passes.
- Full real conversation first validated in isolated temp Codex home.
- Production import exercised URL-only entry and normal real Codex config (custom / gpt-6-astra).
- Native paginated display history and persisted model-context messages exactly match all148 normalized messages.
- App-server exited and restarted; UUID-only resume and state-only listing succeeded.
- Main entry prints directly usable resume command; supports offline HTML, dry-run, workspace/home/archive selection, JSON output and standalone manifest verification.

Scope: Native context holds user/assistant body text and visible progress, with attachment names represented as references. Full original HTML/structured data and available tool records are archived. Cloud attachment binaries, generated files, redacted tool output and runtime/container state require original sources; they are not present in the shared data. Source instructions are treated as data.

Research/probe artifacts: C:\Users\thelastede\AppData\Local\Temp\chatgpt-codex-import-6af1bb40, including upstream clone, generated schemas, probes, and validation-archives (moved out of the delivered tool directory after validation).
Sources inspected: official https://learn.chatgpt.com/docs/developer-commands?surface=cli and https://learn.chatgpt.com/docs/app-server; upstream vv-bogdanov/chatgpt2codex and open PRs1/2. Initial503 was fetch-layer failure; browser-UA PowerShell fetch succeeded. Installed schemas and native roundtrips establish current compatibility.
Remaining work: None. Final response should link tool/instructions, show generic usage and the delivered resume ID, briefly state cloud-file/runtime limitations.
