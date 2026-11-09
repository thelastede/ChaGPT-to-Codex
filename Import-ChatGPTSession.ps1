#requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'Import')]
param(
    [Parameter(Mandatory, Position = 0, ParameterSetName = 'Import')]
    [uri]$ShareUrl,
    [Parameter(ParameterSetName = 'Import')]
    [string]$HtmlPath,
    [Parameter(ParameterSetName = 'Import')]
    [string]$Workspace = (Get-Location).Path,
    [Parameter(ParameterSetName = 'Import')]
    [string]$ArchiveRoot = (Join-Path $PSScriptRoot 'archives'),
    [Parameter(ParameterSetName = 'Import')]
    [string]$SessionHome,
    [Parameter(ParameterSetName = 'Import')]
    [switch]$DryRun,
    [Parameter(Mandatory, ParameterSetName = 'Verify')]
    [string]$VerifyManifest,
    [switch]$AsJson
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSNativeCommandArgumentPassing = 'Standard'

$nodeCommand = (Get-Command node -ErrorAction Stop).Source
$codexCommand = (Get-Command codex -ErrorAction Stop).Source
$nodeVersion = & $nodeCommand --version
if ($LASTEXITCODE -ne 0) { throw '无法运行 Node.js。' }
if ([version]$nodeVersion.TrimStart('v') -lt [version]'22.13.0') { throw '需要 Node.js 22.13 或更新版本。' }
$versionOutput = & $codexCommand --version
if ($LASTEXITCODE -ne 0) { throw '无法运行 Codex CLI。' }
$versionMatch = [regex]::Match(($versionOutput -join ' '), 'codex-cli\s+(\d+\.\d+\.\d+)')
if (-not $versionMatch.Success) { throw '无法识别 Codex CLI 版本。' }

$taskOptionsPath = Join-Path ([System.IO.Path]::GetTempPath()) ('chatgpt-codex-options-' + [guid]::NewGuid().ToString('N') + '.json')
$taskHtmlPath = $null
try {
    $options = [ordered]@{codexCommand = $codexCommand; codexVersion = $versionMatch.Groups[1].Value}
    if ($PSCmdlet.ParameterSetName -eq 'Verify') {
        $options.verifyManifest = (Resolve-Path -LiteralPath $VerifyManifest).Path
    } else {
        if (-not $ShareUrl.IsAbsoluteUri -or $ShareUrl.Scheme -ne 'https' -or
            $ShareUrl.Host -notin @('chatgpt.com', 'www.chatgpt.com', 'chat.openai.com') -or
            -not $ShareUrl.IsDefaultPort -or $ShareUrl.UserInfo -or
            $ShareUrl.AbsolutePath -notmatch '^/share/[A-Za-z0-9_-]+/?$') {
            throw '请提供 https://chatgpt.com/share/<id> 格式的分享链接。'
        }
        $workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
        if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace 必须是已有目录。' }
        if (-not $SessionHome) {
            $SessionHome = [Environment]::GetEnvironmentVariable('CODEX_HOME')
            if (-not $SessionHome) { $SessionHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
        }
        if ($HtmlPath) {
            $resolvedHtmlPath = (Resolve-Path -LiteralPath $HtmlPath).Path
        } else {
            $taskHtmlPath = Join-Path ([System.IO.Path]::GetTempPath()) ('chatgpt-codex-share-' + [guid]::NewGuid().ToString('N') + '.html')
            $browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
            $response = $null
            for ($attempt = 1; $attempt -le 3; $attempt++) {
                try {
                    $response = Invoke-WebRequest -Uri $ShareUrl.AbsoluteUri -UserAgent $browserAgent -SkipHttpErrorCheck -TimeoutSec 30
                    if ([int]$response.StatusCode -eq 200) { break }
                    if ([int]$response.StatusCode -notin @(429, 500, 502, 503, 504) -or $attempt -eq 3) {
                        throw "获取分享页失败：HTTP $([int]$response.StatusCode)。在浏览器中将完整分享页另存为 HTML，然后使用 -HtmlPath 参数导入。"
                    }
                } catch {
                    if ($response -and [int]$response.StatusCode -notin @(429, 500, 502, 503, 504)) { throw }
                    if ($attempt -eq 3) { throw "获取分享页失败：$($_.Exception.Message) 可在浏览器中保存完整 HTML，再使用 -HtmlPath 导入。" }
                }
                Start-Sleep -Seconds $attempt
            }
            $response.Content | Set-Content -LiteralPath $taskHtmlPath -Encoding UTF8
            $resolvedHtmlPath = $taskHtmlPath
        }
        $options.shareUrl = $ShareUrl.AbsoluteUri
        $options.htmlPath = $resolvedHtmlPath
        $options.workspace = $workspacePath
        $options.archiveRoot = [System.IO.Path]::GetFullPath($ArchiveRoot)
        $options.sessionHome = [System.IO.Path]::GetFullPath($SessionHome)
        $options.dryRun = [bool]$DryRun
    }
    $options | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskOptionsPath -Encoding UTF8
    $resultLines = & $nodeCommand (Join-Path $PSScriptRoot 'src\cli.mjs') $taskOptionsPath
    if ($LASTEXITCODE -ne 0) { throw '导入或校验失败，详情见上方错误。' }
    $result = ($resultLines -join "`n") | ConvertFrom-Json
    if ($AsJson) {
        $result | ConvertTo-Json -Depth 12
    } elseif ($result.dryRun) {
        Write-Output "解析成功：$($result.title)"
        Write-Output "消息：$($result.statistics.userMessages) 条用户消息，$($result.statistics.assistantMessages) 条助手正文"
        Write-Output "附件引用：$($result.statistics.attachmentReferences)；历史工具记录：$($result.statistics.toolRecords)"
    } else {
        Write-Output "会话已就绪：$($result.title)"
        Write-Output "消息：$($result.statistics.userMessages) 条用户消息，$($result.statistics.assistantMessages) 条助手正文"
        Write-Output '校验：消息逐条一致，支持凭 ID 恢复'
        Write-Output "本地归档：$($result.archiveDirectory)"
        Write-Output "`n继续会话："
        Write-Output $result.resumeCommand
    }
} finally {
    if (Test-Path -LiteralPath $taskOptionsPath) { Remove-Item -LiteralPath $taskOptionsPath }
    if ($taskHtmlPath -and (Test-Path -LiteralPath $taskHtmlPath)) { Remove-Item -LiteralPath $taskHtmlPath }
}
