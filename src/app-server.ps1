#requires -Version 7.0
param([Parameter(Mandatory)][string]$CodexCommand)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
& $CodexCommand app-server --stdio
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
