# claude-slack-channel: セッション起動スクリプト
#
# Slack channel サーバーを読み込んだ claude.exe を、ユーザー設定を読まない状態で起動する。
# 起動前に、ビルド済みか・状態ディレクトリに .env / access.json があるか（中身は読まない）を確認する。
#
# 使い方:
#   scripts\start.cmd                    # config\projects.json の一覧から選んで起動
#   scripts\start.cmd my-app             # projects.json の name で指定して起動
#   scripts\start.cmd C:\path\to\app     # パスで直接指定して起動
#   scripts\start.cmd my-app -PermissionMode auto
#                                        # 実行許可のモードを変える（既定は default = 都度確認）
#   scripts\start.cmd -DryRun            # 実行せずコマンドラインだけ表示

param(
    [Parameter(Position = 0)]
    [string]$Project,
    [ValidateSet('default', 'auto', 'acceptEdits', 'plan')]
    [string]$PermissionMode = 'default',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$repoRoot = Split-Path -Parent $PSScriptRoot
$mainJs = Join-Path $repoRoot 'dist\src\main.js'
$projectList = Join-Path $repoRoot 'config\projects.json'
$settingsFile = Join-Path $repoRoot 'config\channel-settings.json'
$stateDir = if ($env:SLACK_CHANNEL_STATE_DIR) {
    $env:SLACK_CHANNEL_STATE_DIR
} else {
    Join-Path $env:USERPROFILE '.claude\channels\slack'
}

# --- 起動前の確認 -------------------------------------------------------------

# dist が無ければビルドする（clone 直後に start.cmd だけ叩いても動くように）
function Confirm-Built {
    if (Test-Path $mainJs) { return }

    Write-Host "[start] dist/src/main.js が無いので npm run build を実行する"
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm が見つからない。Node.js をインストールしてから再実行して。"
        exit 1
    }
    if ($DryRun) {
        Write-Host "[start] (DryRun) npm run build をスキップ"
        return
    }

    Push-Location $repoRoot
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) {
            Write-Error "npm run build が失敗した（exit code $LASTEXITCODE）"
            exit 1
        }
    } finally {
        Pop-Location
    }
}

# .env と access.json が揃っているかだけ見る（トークンを扱わないよう、中身は読まない）
function Confirm-StateFiles {
    $missing = @('.env', 'access.json') | Where-Object { -not (Test-Path (Join-Path $stateDir $_)) }
    if (-not $missing) { return }

    $message = "$stateDir に $($missing -join ' と ') が無い。README のセットアップ手順に従って、" +
        "メモ帳で作成してから再実行して。"
    if ($DryRun) {
        # -DryRun はコマンドラインの確認用なので、止めずに警告だけ出す
        Write-Warning $message
    } else {
        Write-Error $message
        exit 1
    }
}

# --- 作業ディレクトリを決める -----------------------------------------------------

function Read-ProjectList {
    if (-not (Test-Path $projectList)) {
        return @()
    }
    return @((Get-Content -LiteralPath $projectList -Raw -Encoding UTF8 | ConvertFrom-Json).projects)
}

# 一覧を番号付きで表示して選ばせる。空 Enter は先頭、q は起動せずに終了。
function Select-Project {
    param([object[]]$Projects)

    if ($Projects.Count -eq 0) {
        Write-Error (
            "プロジェクト一覧が無いか空: $projectList。config\projects.example.json をコピーして " +
            "自分のプロジェクトを書くか、起動時にパスを直接指定して。"
        )
        exit 1
    }

    Write-Host ""
    Write-Host "どのプロジェクトで起動する？"
    for ($i = 0; $i -lt $Projects.Count; $i++) {
        $p = $Projects[$i]
        $mark = if (Test-Path -LiteralPath $p.path) { '' } else { '  (見つからない)' }
        Write-Host ("  [{0}] {1}  {2}{3}" -f ($i + 1), $p.name, $p.path, $mark)
    }
    Write-Host ""

    while ($true) {
        $answer = (Read-Host "番号を入力（Enter で 1、q で中止）").Trim()
        if ($answer -eq '') { $answer = '1' }
        if ($answer -eq 'q') {
            Write-Host "中止した。"
            exit 0
        }
        $n = 0
        if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $Projects.Count) {
            return $Projects[$n - 1].path
        }
        Write-Host "1〜$($Projects.Count) の番号か q を入力して。"
    }
}

# -Project はパスでも projects.json の name でもよい。省略時は一覧から選ぶ。
function Resolve-ProjectDir {
    if (-not $Project) {
        $dir = Select-Project -Projects (Read-ProjectList)
    } elseif (Test-Path -LiteralPath $Project) {
        $dir = $Project
    } else {
        $match = Read-ProjectList | Where-Object { $_.name -eq $Project } | Select-Object -First 1
        if (-not $match) {
            Write-Error "パスとしても projects.json の name としても見つからない: $Project"
            exit 1
        }
        $dir = $match.path
    }

    if (-not (Test-Path -LiteralPath $dir)) {
        Write-Error "作業ディレクトリが存在しない: $dir"
        exit 1
    }
    return (Resolve-Path -LiteralPath $dir).ProviderPath
}

# --- 本体 ---------------------------------------------------------------------

$claude = Get-ClaudeExeOrExit
Confirm-Built
Confirm-StateFiles
$projectDir = Resolve-ProjectDir

# claude.ai の connectors は、このプロセスから起動する claude.exe でだけ無効にする
$env:ENABLE_CLAUDEAI_MCP_SERVERS = 'false'

# Claude Code のセッション内（VS Code 拡張など）からこのスクリプトを実行すると、親セッションの
# 目印の環境変数が引き継がれ、子セッション扱い（会話の保存なし）や MCP の非同期接続になって、
# slackbridge の reply ツールが使えないことがある。独立したセッションとして起動するため消しておく
@(
    'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_AGENT_SDK_VERSION', 'MCP_CONNECTION_NONBLOCKING',
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_ENABLE_TASKS'
) | ForEach-Object { Remove-Item -Path "Env:$_" -ErrorAction SilentlyContinue }

$mcpConfig = Write-McpConfig -FileName 'mcp.json' -ServerName 'slackbridge' -ScriptPath $mainJs

# Slack の「今後も許可」で足したルール（状態ディレクトリの allow-extra.json）を channel-settings.json の allow に足し、
# %TEMP% に書き出したものを --settings に渡す。ブリッジが deny と照合してから書き込んだものだけが入っている。
# 読めなければ足さずに警告だけ出す（起動は止めない）。
function Get-EffectiveSettings {
    $allowExtra = Join-Path $stateDir 'allow-extra.json'
    if (-not (Test-Path $allowExtra)) { return $settingsFile }
    try {
        $extra = @((Get-Content -LiteralPath $allowExtra -Raw -Encoding UTF8 | ConvertFrom-Json).allow |
            Where-Object { $_ -is [string] -and $_ -ne '' })
        if ($extra.Count -eq 0) { return $settingsFile }

        $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $settings.permissions.allow = @(@($settings.permissions.allow) + $extra | Select-Object -Unique)

        $merged = Join-Path $env:TEMP 'claude-slack-channel\channel-settings.merged.json'
        New-Item -ItemType Directory -Path (Split-Path -Parent $merged) -Force | Out-Null
        $json = $settings | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($merged, $json, [System.Text.UTF8Encoding]::new($false))
        Write-Host "Slack から追加した許可ルール: $($extra.Count) 件（$allowExtra）"
        return $merged
    } catch {
        Write-Warning "allow-extra.json を読めなかったので、追加の許可ルールは使わない: $($_.Exception.Message)"
        return $settingsFile
    }
}
$effectiveSettings = Get-EffectiveSettings

# 各フラグの意味は README の「権限の設計」を参照
$claudeArgs = @(
    '--mcp-config', $mcpConfig,
    '--strict-mcp-config',
    '--no-chrome',
    '--setting-sources', 'project,local',
    '--settings', $effectiveSettings,
    '--permission-mode', $PermissionMode,
    # 他のフラグより後ろ、最後に置く
    '--dangerously-load-development-channels', 'server:slackbridge'
)

Write-Host "claude.exe: $claude"
Write-Host "作業ディレクトリ: $projectDir"
Write-Host "状態ディレクトリ: $stateDir"
Write-Host "警告ダイアログが出たら 1（I am using this for local development）を選ぶこと"

if ($DryRun) {
    Write-Host "[DryRun] 実行されるコマンドライン:"
    Write-Host (Format-CommandLine -Exe $claude -Arguments $claudeArgs)
    exit 0
}

Push-Location $projectDir
try {
    & $claude @claudeArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
