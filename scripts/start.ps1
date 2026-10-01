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

# MCP サーバーの名前（src/mcp.ts の SERVER_NAME と config/channel-settings.json の mcp__slackbridge__* と同じ値にすること）
$ServerName = 'slackbridge'
# 状態ディレクトリの既定の場所（%USERPROFILE% からの相対。src/config.ts の DEFAULT_STATE_DIR_RELATIVE と同じ値にすること）
$DefaultStateDirRelative = '.claude\channels\slack'
# Slack の !restart が置く印（src/session-control.ts の RESTART_FLAG_FILE と同じ名前にすること）
$RestartFlagName = 'restart.flag'
# 起動し直すとき、experimental channels の警告ダイアログを自動で抜けるために画面で探す文字列（正規表現）。
# ダイアログの文言が変わって抜けられなくなったら、ここを直す（start.ps1 自身が表示する文には含めないこと）
$DevChannelDialogPattern = 'development channel'
# ダイアログを待つ最大秒数
$DevChannelDialogTimeoutSec = 90

$repoRoot = Split-Path -Parent $PSScriptRoot
$mainJs = Join-Path $repoRoot 'dist\src\main.js'
$projectList = Join-Path $repoRoot 'config\projects.json'
$settingsFile = Join-Path $repoRoot 'config\channel-settings.json'
$stateDir = if ($env:SLACK_CHANNEL_STATE_DIR) {
    $env:SLACK_CHANNEL_STATE_DIR
} else {
    Join-Path $env:USERPROFILE $DefaultStateDirRelative
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

# --- MCP サーバーと許可ルールの設定を組み立てる ---------------------------------------

# --strict-mcp-config で他の MCP サーバーは読み込まれないので、Slack セッションでも使うものは
# config\extra-mcp.json（git 管理外。ひな形は extra-mcp.example.json）に書いて一緒に渡す。読めなければ警告だけ出す
function Read-ExtraMcpServers {
    $file = Join-Path $repoRoot 'config\extra-mcp.json'
    $servers = @{}
    if (-not (Test-Path -LiteralPath $file)) { return $servers }
    try {
        $parsed = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $parsed.mcpServers.PSObject.Properties) { $servers[$p.Name] = $p.Value }
        if ($servers.Count -gt 0) { Write-Host "追加の MCP サーバー: $(($servers.Keys | Sort-Object) -join ', ')" }
    } catch {
        Write-Warning "config\extra-mcp.json を読めなかったので、追加の MCP サーバーは使わない: $($_.Exception.Message)"
    }
    return $servers
}

# Slack の「今後も許可」で足したルール（状態ディレクトリの allow-extra.json）を読む。
# ブリッジが deny と照合してから書き込んだものだけが入っている。読めなければ警告だけ出して使わない
function Read-AllowExtra {
    $allowExtra = Join-Path $stateDir 'allow-extra.json'
    if (-not (Test-Path $allowExtra)) { return @() }
    try {
        $rules = @((Get-Content -LiteralPath $allowExtra -Raw -Encoding UTF8 | ConvertFrom-Json).allow |
            Where-Object { $_ -is [string] -and $_ -ne '' })
        if ($rules.Count -gt 0) { Write-Host "Slack から追加した許可ルール: $($rules.Count) 件（$allowExtra）" }
        return $rules
    } catch {
        Write-Warning "allow-extra.json を読めなかったので、追加の許可ルールは使わない: $($_.Exception.Message)"
        return @()
    }
}

# Claude Code の hook から呼ぶ記録コマンド（dist/src/hook.js）の設定。
# セッションの開始・終了、応答の終了と失敗、通知（ターミナル側の入力待ち・使用量の上限）、圧縮を
# 状態ディレクトリの hooks.jsonl に書き、ブリッジが Slack に知らせる。node が見つからなければ空
function Get-HookSettings {
    $hookJs = Join-Path $repoRoot 'dist\src\hook.js'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Warning "node が見つからないので hook の通知は使わない"
        return @{}
    }
    $hooks = @{}
    foreach ($event in @('SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'Notification', 'PostCompact')) {
        # exec 形式（command + args）でシェルを挟まず起動する（パスの引用符の問題を避ける）
        $hooks[$event] = @(@{ hooks = @(@{ type = 'command'; command = $node.Source; args = @($hookJs); timeout = 5 }) })
    }
    return $hooks
}

# channel-settings.json に次を足し、%TEMP% に書き出したものを --settings に渡す。
# - permissions.allow: extra-mcp.json に登録した MCP サーバーのツール全部（mcp__<サーバー名>。使う人が承知して入れたものなので確認を挟まない）と、
#   Slack の「今後も許可」で足したルール
# - hooks: Get-HookSettings
# deny は channel-settings.json のまま（allow より優先される）。作れなければ channel-settings.json をそのまま渡す
function Get-EffectiveSettings {
    param([hashtable]$ExtraServers)

    $extra = @(@($ExtraServers.Keys | Sort-Object | ForEach-Object { "mcp__$_" }) + @(Read-AllowExtra))
    try {
        $settings = Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($extra.Count -gt 0) {
            $settings.permissions.allow = @(@($settings.permissions.allow) + $extra | Select-Object -Unique)
        }
        $hooks = Get-HookSettings
        if ($hooks.Count -gt 0) {
            $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue $hooks -Force
        }

        $merged = Join-Path (Get-TempDir) 'channel-settings.merged.json'
        $json = $settings | ConvertTo-Json -Depth 10
        [System.IO.File]::WriteAllText($merged, $json, [System.Text.UTF8Encoding]::new($false))
        return $merged
    } catch {
        Write-Warning "許可ルールと hook を足した設定を作れなかったので、channel-settings.json をそのまま使う: $($_.Exception.Message)"
        return $settingsFile
    }
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

$extraServers = Read-ExtraMcpServers
$mcpConfig = Write-McpConfig -FileName 'mcp.json' -ServerName $ServerName -ScriptPath $mainJs -ExtraServers $extraServers
$effectiveSettings = Get-EffectiveSettings -ExtraServers $extraServers

# 各フラグの意味は README の「権限の設計」を参照
$claudeArgs = @(
    '--mcp-config', $mcpConfig,
    '--strict-mcp-config',
    '--no-chrome',
    '--setting-sources', 'project,local',
    '--settings', $effectiveSettings,
    '--permission-mode', $PermissionMode,
    # 他のフラグより後ろ、最後に置く
    '--dangerously-load-development-channels', "server:$ServerName"
)

Write-Host "claude.exe: $claude"
Write-Host "作業ディレクトリ: $projectDir"
Write-Host "状態ディレクトリ: $stateDir"
Write-Host "警告ダイアログが出たら 1（I am using this for local development）を選ぶこと"

$restartFlag = Join-Path $stateDir $RestartFlagName

if ($DryRun) {
    Write-Host "[DryRun] 実行されるコマンドライン:"
    Write-Host (Format-CommandLine -Exe $claude -Arguments $claudeArgs)
    Write-Host "[DryRun] 終了時に $restartFlag があれば、--continue を付けて起動し直す（ダイアログは scripts\dialog-answer.ps1 が答える）"
    exit 0
}

# --- 起動（Slack の !restart で印が置かれていたら --continue で起動し直す） ------------------

# 前回の残り（起動し直す前に手で止めた等）は捨てる
Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue

$resume = $false
Push-Location $projectDir
try {
    do {
        $args = if ($resume) { @('--continue') + $claudeArgs } else { $claudeArgs }
        if ($resume) {
            # 手元に人がいない前提なので、警告ダイアログは画面を見張って自動で答える
            Start-Process -FilePath 'powershell.exe' -NoNewWindow -ArgumentList @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-File', (Join-Path $PSScriptRoot 'dialog-answer.ps1'),
                '-Pattern', $DevChannelDialogPattern, '-TimeoutSec', $DevChannelDialogTimeoutSec
            ) | Out-Null
        }
        & $claude @args
        $code = $LASTEXITCODE
        $again = Test-Path -LiteralPath $restartFlag
        if ($again) {
            Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue
            $resume = $true
            Write-Host ""
            Write-Host "[start] Slack からの指示で起動し直す（--continue で会話を引き継ぐ）"
        }
    } while ($again)
    exit $code
} finally {
    Pop-Location
}
