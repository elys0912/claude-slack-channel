# claude-slack-channel: セッション起動スクリプト
#
# claude.exe を探し、ビルド済みか確認し、state ディレクトリ（.env / access.json）が
# 用意されているかだけ確認したうえで（中身は読まない）、Slack channel サーバーを
# --mcp-config で読み込みつつ、ユーザー設定を一切読まない状態で claude.exe を起動する。
#
# 使い方:
#   scripts\start.ps1                  # config\projects.json の一覧から作業ディレクトリを選んで起動
#   scripts\start.ps1 -Project <path>  # 選択を飛ばして指定の作業ディレクトリで起動
#   scripts\start.ps1 -DryRun          # 実行せずコマンドラインだけ表示

param(
    [string]$Project,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# --- 1. claude.exe を決める -------------------------------------------------

function Find-ClaudeExe {
    $onPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }

    $extensionsRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
    if (-not (Test-Path $extensionsRoot)) {
        return $null
    }

    $candidates = Get-ChildItem -Path $extensionsRoot -Directory -Filter 'anthropic.claude-code-*-win32-x64' -ErrorAction SilentlyContinue |
        ForEach-Object {
            # ディレクトリ名から純粋なバージョン番号部分だけを取り出す。
            # 例: anthropic.claude-code-2.1.278-win32-x64 -> 2.1.278
            if ($_.Name -match 'anthropic\.claude-code-(\d+\.\d+\.\d+)-win32-x64$') {
                $exe = Join-Path $_.FullName 'resources\native-binary\claude.exe'
                if (Test-Path $exe) {
                    [pscustomobject]@{
                        Version = [version]$Matches[1]
                        Path    = $exe
                    }
                }
            }
        }

    if (-not $candidates -or @($candidates).Count -eq 0) {
        return $null
    }

    $best = $candidates | Sort-Object Version -Descending | Select-Object -First 1
    return $best.Path
}

$claude = Find-ClaudeExe
if (-not $claude) {
    Write-Error (
        "claude.exe が見つからない。PATH に claude が無く、" +
        "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*-win32-x64\resources\native-binary\claude.exe " +
        "も見当たらない。VS Code 拡張がインストールされているか確認して。"
    )
    exit 1
}

# --- 2. リポジトリのルートを求める（このスクリプトの親ディレクトリ） --------

$repoRoot = Split-Path -Parent $PSScriptRoot

# --- 3. dist/src/main.js が無ければビルドする -------------------------------

$mainJs = Join-Path $repoRoot 'dist\src\main.js'
if (-not (Test-Path $mainJs)) {
    Write-Host "[start] dist/src/main.js が無いので npm run build を実行する"
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Error "npm が見つからない。Node.js をインストールしてから再実行して。"
        exit 1
    }
    if (-not $DryRun) {
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
    } else {
        Write-Host "[start] (DryRun) npm run build をスキップ"
    }
}

# --- 4. state ディレクトリの .env / access.json の存在確認（中身は読まない） -

$stateDir = if ($env:SLACK_CHANNEL_STATE_DIR) {
    $env:SLACK_CHANNEL_STATE_DIR
} else {
    Join-Path $env:USERPROFILE '.claude\channels\slack'
}

$envFile = Join-Path $stateDir '.env'
$accessFile = Join-Path $stateDir 'access.json'

if (-not (Test-Path $envFile) -or -not (Test-Path $accessFile)) {
    $message = "$stateDir に .env と access.json が揃っていない。README のセットアップ手順に従って、" +
        "メモ帳で作成してから再実行して。"
    if ($DryRun) {
        # -DryRun はコマンドラインの検証用途なので、状態ファイルが無くても止めずに警告だけ出す。
        Write-Warning $message
    } else {
        Write-Error $message
        exit 1
    }
}

# --- 5. 作業ディレクトリを決める ---------------------------------------------

# -Project が無ければ config\projects.json の一覧を番号付きで表示して選ばせる。
# 空 Enter は先頭のプロジェクト、q は起動せずに終了。
function Select-Project {
    param([string]$ListFile)

    if (-not (Test-Path $ListFile)) {
        Write-Error (
            "プロジェクト一覧が無い: $ListFile。config\projects.example.json をコピーして " +
            "自分のプロジェクトを書くか、-Project で直接指定して。"
        )
        exit 1
    }
    $projects = @((Get-Content -LiteralPath $ListFile -Raw -Encoding UTF8 | ConvertFrom-Json).projects)
    if ($projects.Count -eq 0) {
        Write-Error "$ListFile の projects が空。"
        exit 1
    }

    Write-Host ""
    Write-Host "どのプロジェクトで起動する？"
    for ($i = 0; $i -lt $projects.Count; $i++) {
        $p = $projects[$i]
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
        if ([int]::TryParse($answer, [ref]$n) -and $n -ge 1 -and $n -le $projects.Count) {
            return $projects[$n - 1].path
        }
        Write-Host "1〜$($projects.Count) の番号か q を入力して。"
    }
}

if (-not $Project) {
    $Project = Select-Project -ListFile (Join-Path $repoRoot 'config\projects.json')
}

if (-not (Test-Path $Project)) {
    Write-Error "作業ディレクトリが存在しない: $Project"
    exit 1
}
$projectFull = (Resolve-Path -LiteralPath $Project).ProviderPath

# --- 6. claude.ai connectors をこのプロセス内だけ無効化する ------------------

$env:ENABLE_CLAUDEAI_MCP_SERVERS = 'false'

# --- 7. 起動コマンドを組み立てる ---------------------------------------------

# MCP 設定はリポジトリの場所に依存する（main.js の絶対パスが要る）ので、clone 先に
# 関係なく動くよう起動のたびに生成する。claude.exe が BOM 付き JSON を読めるとは
# 限らないため、BOM なし UTF-8 で書く。
$mcpConfig = Join-Path $env:TEMP 'claude-slack-channel\mcp.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $mcpConfig) -Force | Out-Null
$mcpJson = @{
    mcpServers = @{
        slackbridge = @{
            command = 'node'
            args    = @($mainJs)
        }
    }
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($mcpConfig, $mcpJson, [System.Text.UTF8Encoding]::new($false))

$settingsFile = Join-Path $repoRoot 'config\channel-settings.json'

$claudeArgs = @(
    '--mcp-config', $mcpConfig,
    '--setting-sources', 'project,local',
    '--settings', $settingsFile,
    '--permission-mode', 'default',
    '--dangerously-load-development-channels', 'server:slackbridge'
)

# --- 8. 起動前に情報を表示する ------------------------------------------------

Write-Host "claude.exe: $claude"
Write-Host "作業ディレクトリ: $projectFull"
Write-Host "状態ディレクトリ: $stateDir"
Write-Host "警告ダイアログが出たら 1（I am using this for local development）を選ぶこと"

if ($DryRun) {
    $quotedArgs = $claudeArgs | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }
    Write-Host "[DryRun] 実行されるコマンドライン:"
    Write-Host ("`"$claude`" " + ($quotedArgs -join ' '))
    exit 0
}

Push-Location $projectFull
try {
    & $claude @claudeArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
