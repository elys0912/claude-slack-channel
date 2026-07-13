# claude-slack-channel: 起動時の experimental channels の警告ダイアログに、画面を見張って 1（Enter）で答える
#
# Slack からの !restart で claude.exe を起動し直すとき、手元に人がいなくてもダイアログを抜けられるようにする。
# start.ps1 が claude.exe の起動直前に、同じコンソールで（-NoNewWindow）このスクリプトを別プロセスとして起動する。
# 画面に Pattern が出たら Digit1 と Enter を送って終わる。TimeoutSec の間に出なければ何もせず終わる。
# 画面の読み取りとキー送信は console.ps1 を子プロセスで呼ぶ。
#
# 使い方:
#   dialog-answer.ps1 -Pattern 'development channel' -TimeoutSec 90

param(
    [Parameter(Mandatory)][string]$Pattern,
    [int]$TimeoutSec = 90,
    [int]$IntervalMs = 500
)

$ErrorActionPreference = 'Stop'
$consoleScript = Join-Path $PSScriptRoot 'console.ps1'

function Invoke-Console {
    param([string[]]$Arguments)
    return (& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $consoleScript @Arguments)
}

$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $IntervalMs
    try {
        $screen = (Invoke-Console @('-Mode', 'read')) -join "`n"
    } catch {
        continue
    }
    if ($screen -match $Pattern) {
        # TUI が描き終わるのを少し待ってから答える
        Start-Sleep -Milliseconds 500
        Invoke-Console @('-Mode', 'keys', '-Keys', 'Digit1,Enter') | Out-Null
        exit 0
    }
}
exit 0
