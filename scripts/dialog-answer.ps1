# claude-slack-channel: 起動時の experimental channels の警告ダイアログに、画面を見張って 1（Enter）で答える
#
# Slack からの !restart で claude.exe を起動し直すとき、手元に人がいなくてもダイアログを抜けられるようにする。
# start.ps1 が claude.exe の起動直前に、同じコンソールで（-NoNewWindow）このスクリプトを別プロセスとして起動する。
# 画面に Pattern が出たら Digit1 と Enter を送って終わる。TimeoutSec の間に出なければ何もせず終わる。
# 画面の読み取りとキー送信は console.ps1 を子プロセスで呼ぶ。
#
# 使い方:
#   dialog-answer.ps1 -Pattern 'development channel' -TimeoutSec 90 [-LogFile <path>]
#
# 結果（答えた・キーを送れなかった・時間切れ）は -LogFile にだけ書く。同じコンソールで動くので、画面には何も書かない

param(
    [Parameter(Mandatory)][string]$Pattern,
    [int]$TimeoutSec = 90,
    [int]$IntervalMs = 500,
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'
$consoleScript = Join-Path $PSScriptRoot 'console.ps1'
# console.ps1 は画面を UTF-8 で書き出す。子プロセスの出力は [Console]::OutputEncoding で読まれるので合わせる
# （既定の cp932 のままだと日本語が化けて、日本語の Pattern が一致しない）。
# このコンソールの出力コードページは console.ps1 も同じ値にするので、claude.exe の表示への影響は増えない。
# 1 周は console.ps1 の起動込みで約 0.4 秒 + IntervalMs（2026-10-03 計測）。ダイアログを待つには十分なので、毎周起動のままにする
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Invoke-Console {
    param([string[]]$Arguments)
    return (& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $consoleScript @Arguments)
}

function Write-Log {
    param([string]$Message)
    if (-not $LogFile) { return }
    try {
        New-Item -ItemType Directory -Path (Split-Path -Parent $LogFile) -Force | Out-Null
        $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    } catch {
        # ログが書けなくてもダイアログへの応答は止めない
    }
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
        $output = Invoke-Console @('-Mode', 'keys', '-Keys', 'Digit1,Enter') 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Log "警告ダイアログに答えた（Digit1, Enter）"
        } else {
            Write-Log "警告ダイアログにキーを送れなかった exit=$LASTEXITCODE $(($output | Out-String).Trim())"
        }
        exit 0
    }
}
Write-Log "$TimeoutSec 秒待っても警告ダイアログ（$Pattern）が出なかった"
exit 0
