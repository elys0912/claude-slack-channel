# start.ps1 から dot-source して使う共通関数。

# 起動のたびに生成するファイル（--mcp-config / --settings）の置き場所。無ければ作る
function Get-TempDir {
    $dir = Join-Path $env:TEMP 'claude-slack-channel'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

# claude.exe の場所を返す。PATH を優先し、無ければ VS Code 拡張の同梱版のうち
# 最新バージョンを使う。見つからなければ $null。
function Find-ClaudeExe {
    $onPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }

    $extensionsRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
    if (-not (Test-Path -LiteralPath $extensionsRoot)) {
        return $null
    }

    # ディレクトリ名は文字列ソートだとバージョン順にならない（"9" > "10"）ので、
    # 例: anthropic.claude-code-2.1.278-win32-x64 から 2.1.278 を取り出して [version] で比べる。
    $candidates = Get-ChildItem -LiteralPath $extensionsRoot -Directory -Filter 'anthropic.claude-code-*-win32-x64' -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match 'anthropic\.claude-code-(\d+\.\d+\.\d+)-win32-x64$') {
                $exe = Join-Path $_.FullName 'resources\native-binary\claude.exe'
                if (Test-Path -LiteralPath $exe) {
                    [pscustomobject]@{ Version = [version]$Matches[1]; Path = $exe }
                }
            }
        }

    $best = @($candidates) | Sort-Object Version -Descending | Select-Object -First 1
    if ($best) { return $best.Path }
    return $null
}

# Find-ClaudeExe の結果を返す。見つからなければエラーで終了する。
function Get-ClaudeExeOrExit {
    $claude = Find-ClaudeExe
    if (-not $claude) {
        Write-Error (
            "claude.exe が見つからない。PATH に claude が無く、" +
            "$env:USERPROFILE\.vscode\extensions\anthropic.claude-code-*-win32-x64\resources\native-binary\claude.exe " +
            "も見当たらない。VS Code 拡張がインストールされているか確認して。"
        )
        exit 1
    }
    return $claude
}

# node で動く MCP サーバー1つだけを定義した --mcp-config 用 JSON を書き出し、そのパスを返す。
# サーバーのスクリプトは clone 先の絶対パスになるので、リポジトリには置かず起動のたびに
# %TEMP%\claude-slack-channel\ へ生成する。claude.exe が BOM 付き JSON を読めるとは
# 限らないため、BOM なし UTF-8 で書く。
function Write-McpConfig {
    param(
        [Parameter(Mandatory)][string]$FileName,
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][string]$ScriptPath,
        # 一緒に読み込ませる MCP サーバー（名前 → 定義）。$ServerName と同名のものは無視する
        [hashtable]$ExtraServers = @{},
        # $ServerName のサーバーに渡す環境変数
        [hashtable]$Env = @{},
        # $ServerName のサーバーを起動する node。claude.exe は作業フォルダーで MCP サーバーを起動するので、
        # 作業フォルダーの node.exe を拾わないよう絶対パスを渡す（start.ps1 は Get-Command node の場所を渡す）
        [string]$NodePath = 'node'
    )

    $path = Join-Path (Get-TempDir) $FileName
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null

    $main = @{ command = $NodePath; args = @($ScriptPath) }
    if ($Env.Count -gt 0) { $main.env = $Env }
    $servers = @{ $ServerName = $main }
    foreach ($name in $ExtraServers.Keys) {
        if ($name -ne $ServerName) { $servers[$name] = $ExtraServers[$name] }
    }
    $json = @{ mcpServers = $servers } | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))

    return $path
}

# コマンドラインをコピペできる形で表示する（-DryRun 用）。
function Format-CommandLine {
    param([string]$Exe, [string[]]$Arguments)

    $quoted = $Arguments | ForEach-Object {
        if ($_ -match '\s') { "`"$_`"" } else { $_ }
    }
    return "`"$Exe`" " + ($quoted -join ' ')
}

# Slack の !restart が置いた印（restart.flag の JSON）から、会話の session_id を読む。
# UUID の形でなければ（古い印・壊れた印・id が分からなかった）$null を返し、呼び出し側は新しい会話で起動する
function Read-RestartSessionId {
    param([string]$Path)

    try {
        $flag = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        return $null
    }
    $id = [string]$flag.sessionId
    if ($id -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { return $id }
    return $null
}

# session_id の会話の記録（<設定フォルダー>\projects\<フォルダー>\<id>.jsonl）があるか。
# 起動してから一度もやりとりしていない会話は保存されないので、--resume しても「見つからない」で終わる
function Test-SessionTranscript {
    param([string]$SessionId, [string]$ConfigDir = $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }))

    $projects = Join-Path $ConfigDir 'projects'
    if (-not (Test-Path -LiteralPath $projects)) { return $false }
    $found = Get-ChildItem -LiteralPath $projects -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "$SessionId.jsonl") } |
        Select-Object -First 1
    return [bool]$found
}

# 起動し直すときに claude.exe の引数の先頭に付ける引数。session_id が分かり、その会話の記録があれば --resume <id>、無ければ空。
# 記録が無い（起動してから一度もやりとりしていない会話は保存されない）のに --resume すると「見つからない」で終わるため。
# 呼び出し側は @() で包んで受け取る
function Get-ResumeArgs {
    param([string]$SessionId, [string]$ConfigDir)

    if (-not $SessionId) { return @() }
    $transcriptArgs = @{ SessionId = $SessionId }
    if ($ConfigDir) { $transcriptArgs.ConfigDir = $ConfigDir }
    if (Test-SessionTranscript @transcriptArgs) { return @('--resume', $SessionId) }
    return @()
}

# claude.exe に渡す引数。ResumeArgs を先頭に置き、ClaudeArgs（最後が --dangerously-load-development-channels）はその後ろに続ける。
# 要素が 1 つでも配列のまま返す（呼び出し側の変数が文字列になり、+ が文字列の連結になるのを防ぐ）
function Get-LaunchArgs {
    param([object[]]$ResumeArgs = @(), [object[]]$ClaudeArgs = @())

    return , @(@($ResumeArgs) + @($ClaudeArgs))
}

# 一時ファイル（mcp.json・合成した設定）を置くフォルダーの名前。状態ディレクトリの末尾の名前に、フルパスのハッシュの先頭 8 桁を足す
# （例: 末尾が bridge なら bridge-1a2b3c4d）。末尾の名前が同じ別の状態ディレクトリ（C:\a\bridge と C:\b\bridge など）で上書きし合わない。
# DryRun は起動中のセッションのファイルを上書きしないよう、末尾に -dryrun を付けた別のフォルダーにする
function Get-SessionDirName {
    param([Parameter(Mandatory)][string]$StateDir, [switch]$DryRun)

    $fullPath = [System.IO.Path]::GetFullPath($StateDir).TrimEnd('\', '/')
    # Windows のパスは大文字小文字を区別しないので、小文字にしてからハッシュにする
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($fullPath.ToLowerInvariant()))
    } finally {
        $sha.Dispose()
    }
    $hex = -join ($hash[0..3] | ForEach-Object { $_.ToString('x2') })
    $name = '{0}-{1}' -f (Split-Path -Leaf $fullPath), $hex
    if ($DryRun) { $name += '-dryrun' }
    return $name
}

# Claude Code の利用者ごとの設定ファイル（local スコープの MCP サーバーもここに入る）
function Get-ClaudeUserConfigPath {
    if ($env:CLAUDE_CONFIG_DIR) { return Join-Path $env:CLAUDE_CONFIG_DIR '.claude.json' }
    return Join-Path $env:USERPROFILE '.claude.json'
}

# 作業フォルダーの local スコープに、待つだけの slackbridge（環境変数 SLACK_CHANNEL_PLACEHOLDER=1 で
# ScriptPath を起動するもの）が登録済みか。Claude Code 2.1.289 から、開発用チャンネルのサーバーは設定ファイルに
# 登録されていないと受け付けられない（詳しくは src/placeholder.ts）。
# 設定ファイルが無い・読めないときも $false を返し、呼び出し側は登録し直す
function Test-PlaceholderServer {
    param(
        [Parameter(Mandatory)][string]$ConfigPath,
        [Parameter(Mandatory)][string]$ProjectDir,
        [Parameter(Mandatory)][string]$ServerName,
        [Parameter(Mandatory)][string]$ScriptPath
    )

    try {
        $config = [System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    } catch {
        return $false
    }
    if ($null -eq $config.projects) { return $false }
    # キーは作業フォルダーのパスを / 区切りにしたもの。ドライブ文字の大文字・小文字は揃っていない
    $key = $ProjectDir.Replace('\', '/').TrimEnd('/')
    $project = $config.projects.PSObject.Properties | Where-Object { $_.Name -ieq $key } | Select-Object -First 1
    if ($null -eq $project -or $null -eq $project.Value.mcpServers) { return $false }
    $server = $project.Value.mcpServers.PSObject.Properties | Where-Object { $_.Name -eq $ServerName } | Select-Object -First 1
    if ($null -eq $server) { return $false }
    $entry = $server.Value
    $entryArgs = @($entry.args)
    return ($entry.command -eq 'node' -and $entryArgs.Count -eq 1 -and $entryArgs[0] -ieq $ScriptPath -and
        [string]$entry.env.SLACK_CHANNEL_PLACEHOLDER -eq '1')
}

# 「今後も許可」で足したルール（状態ディレクトリの allow-extra.json）のうち、今の方式で作れるものだけを返す。
# 判定はブリッジと同じ CheckerScript（dist/src/allow-extra-check.js）に任せ、作れないもの（前の方式で足したもの）は返さずに
# 警告で一覧を出す。allow-extra.json は書き換えない。ファイルが無ければ空。判定できない（node が無い・ファイルが壊れている）
# ときは、警告だけ出して空を返す（確かめられないルールは allow に入れない）
function Read-AllowExtra {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$CheckerScript
    )

    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    # 結果は stdout の JSON で受け取る。node の stderr やコマンドが無いときのエラーで止まらないようにする
    $ErrorActionPreference = 'Continue'
    $result = $null
    try {
        $result = (& node $CheckerScript $Path 2>$null | Out-String) | ConvertFrom-Json
    } catch {
        $result = $null
    }
    if ($null -eq $result -or $null -ne $result.error) {
        $reason = if ($null -ne $result) { $result.error } else { "node $CheckerScript で確かめられなかった" }
        Write-Warning "allow-extra.json を読めなかったので、追加の許可ルールは使わない: $reason"
        return @()
    }
    $rejected = @($result.rejected)
    if ($rejected.Count -gt 0) {
        Write-Warning ("allow-extra.json に、今の「今後も許可」の方式では作れないルールが $($rejected.Count) 件ある。" +
            "allow には入れない（ファイルはそのまま。要らなければ !rules から消す）: $($rejected -join ', ')")
    }
    return @($result.usable)
}

# SettingsFile（channel-settings.json）の permissions.allow に ExtraAllow を足し、Hooks があれば hooks に入れた設定を、
# OutFile（channel-settings.merged.json）に BOM なし UTF-8 で書く。deny と ask は SettingsFile のまま。読めない・書けないときは投げる
function Write-EffectiveSettings {
    param(
        [Parameter(Mandatory)][string]$SettingsFile,
        [Parameter(Mandatory)][string]$OutFile,
        [string[]]$ExtraAllow = @(),
        [hashtable]$Hooks = @{}
    )

    $settings = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($ExtraAllow.Count -gt 0) {
        $settings.permissions.allow = @(@($settings.permissions.allow) + $ExtraAllow | Select-Object -Unique)
    }
    if ($Hooks.Count -gt 0) {
        $settings | Add-Member -NotePropertyName 'hooks' -NotePropertyValue $Hooks -Force
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $OutFile) -Force | Out-Null
    $json = $settings | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
}
