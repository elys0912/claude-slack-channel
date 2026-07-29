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
#   scripts\start.cmd C:\path\to\app -StateDir %USERPROFILE%\.claude\channels\slack-app2 -SettingsFile config\channel-settings.relaxed.json
#                                        # 別の Slack アプリ（状態ディレクトリ）と設定で、もう1つセッションを起動する

param(
    [Parameter(Position = 0)]
    [string]$Project,
    [ValidateSet('default', 'auto', 'acceptEdits', 'plan')]
    [string]$PermissionMode = 'default',
    # 状態ディレクトリ（.env / access.json の場所）。省略時は SLACK_CHANNEL_STATE_DIR、それも無ければ既定の場所
    [string]$StateDir,
    # channel セッションの設定ファイル。省略時は config\channel-settings.json。相対パスはリポジトリ基準
    [string]$SettingsFile,
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
# experimental channels の警告ダイアログを自動で抜けるために画面で探す文字列（正規表現）。初回の起動でも起動し直しでも使う。
# ダイアログの文言が変わって抜けられなくなったら、ここを直す（start.ps1 自身が表示する文には含めないこと）
$DevChannelDialogPattern = 'development channel'
# 同じダイアログの選択肢「1」の文言（の一部）。Pattern と両方が画面にあるときだけ答える（発言などに Pattern が出ても誤爆しない）
$DevChannelChoicePattern = 'local development'
# --resume で起動してからこの秒数以内に失敗で終わったら、引き継ぎに失敗したとみなして新しい会話で起動し直す
$ResumeFailureSec = 30
# ダイアログを待つ最大秒数
$DevChannelDialogTimeoutSec = 90
# claude.exe が想定外に終了（exit code が 0 以外）したときに起動し直す上限。AutoRestartWindowMin 分の間に AutoRestartMax 回まで
$AutoRestartMax = 3
$AutoRestartWindowMin = 10
# 想定外の終了から起動し直したときに置く印（src/crash-notice.ts の CRASH_FILE と同じ名前にすること）
$CrashFileName = 'crash.json'
# hook の記録（src/hook-event.ts の HOOK_LOG_FILE と同じ名前にすること）
$HookLogFileName = 'hooks.jsonl'
# Slack の「今後も許可」で足したルール（src/main.ts の allowExtraFile と同じ名前にすること）
$AllowExtraFileName = 'allow-extra.json'
# トークンなどを書く設定（src/config.ts の loadTokens が読むものと同じ名前にすること）
$EnvFileName = '.env'
# local スコープに登録する slackbridge を、待つだけにする環境変数（src/placeholder.ts の PLACEHOLDER_ENV と値 1。common.ps1 の Test-PlaceholderServer も同じ）
$PlaceholderEnvAssignment = 'SLACK_CHANNEL_PLACEHOLDER=1'

$repoRoot = Split-Path -Parent $PSScriptRoot
$mainJs = Join-Path $repoRoot 'dist\src\main.js'
$allowExtraCheckJs = Join-Path $repoRoot 'dist\src\allow-extra-check.js'
$projectList = Join-Path $repoRoot 'config\projects.json'
$resolvedSettingsFile = if (-not $SettingsFile) {
    Join-Path $repoRoot 'config\channel-settings.json'
} elseif ([System.IO.Path]::IsPathRooted($SettingsFile)) {
    $SettingsFile
} else {
    Join-Path $repoRoot $SettingsFile
}
if (-not (Test-Path -LiteralPath $resolvedSettingsFile)) {
    Write-Error "設定ファイルが見つからない: $resolvedSettingsFile"
    exit 1
}
$resolvedStateDir = if ($StateDir) {
    [System.IO.Path]::GetFullPath($StateDir)
} elseif ($env:SLACK_CHANNEL_STATE_DIR) {
    $env:SLACK_CHANNEL_STATE_DIR
} else {
    Join-Path $env:USERPROFILE $DefaultStateDirRelative
}
# 一時ファイル（mcp.json・合成した設定）は状態ディレクトリごとに分ける。複数のセッションを並べても上書きし合わず、
# claude.exe のコマンドラインのパスでどのセッションか見分けられる（例: %TEMP%\claude-slack-channel\slack-1a2b3c4d\mcp.json）。
# -DryRun は動いているセッションのファイルを上書きしないよう、別のフォルダー（末尾が -dryrun）に書く
$sessionName = Get-SessionDirName -StateDir $resolvedStateDir -DryRun:$DryRun

# --- 起動前の確認 -------------------------------------------------------------

# dist が無ければビルドする（clone 直後に start.cmd だけ叩いても動くように）
function Confirm-Built {
    if ((Test-Path -LiteralPath $mainJs) -and (Test-Path -LiteralPath $allowExtraCheckJs)) { return }

    Write-Host "[start] dist/src/main.js か dist/src/allow-extra-check.js が無いので npm run build を実行する"
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "npm が見つからない。Node.js をインストールしてから再実行して。"
        exit 1
    }
    if ($DryRun) {
        Write-Host "[start] (DryRun) npm run build をスキップ"
        return
    }

    Push-Location -LiteralPath $repoRoot
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
    $missing = @($EnvFileName, 'access.json') | Where-Object { -not (Test-Path -LiteralPath (Join-Path $resolvedStateDir $_)) }
    if (-not $missing) { return }

    $message = "$resolvedStateDir に $($missing -join ' と ') が無い。README のセットアップ手順に従って、" +
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
    if (-not (Test-Path -LiteralPath $projectList)) {
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

# -Project は projects.json の name でもパスでもよい。省略時は一覧から選ぶ。
# name を先に照合する（カレントディレクトリに同じ名前のフォルダーがあっても、projects.json に登録したフォルダーで起動する）
function Resolve-ProjectDir {
    if (-not $Project) {
        $dir = Select-Project -Projects (Read-ProjectList)
    } else {
        $match = Read-ProjectList | Where-Object { $_.name -eq $Project } | Select-Object -First 1
        if ($match) {
            $dir = $match.path
        } elseif (Test-Path -LiteralPath $Project) {
            $dir = $Project
        } else {
            Write-Error "projects.json の name としてもパスとしても見つからない: $Project"
            exit 1
        }
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
# ブリッジが deny と照合してから書き込んだもののうち、今の方式で作れるものだけを使う（common.ps1 の Read-AllowExtra）
function Get-AllowExtraRules {
    $allowExtra = Join-Path $resolvedStateDir $AllowExtraFileName
    $rules = @(Read-AllowExtra -Path $allowExtra -CheckerScript $allowExtraCheckJs)
    if ($rules.Count -gt 0) { Write-Host "Slack から追加した許可ルール: $($rules.Count) 件（$allowExtra）" }
    return $rules
}

# PATH で見つけた node の実行ファイルの絶対パス。見つからなければ $null
function Find-NodeExe {
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($node) { return $node.Source }
    return $null
}

# MCP サーバー（ブリッジ）を起動する node の絶対パス。claude.exe は作業フォルダーで MCP サーバーを起動するので、
# 作業フォルダーにある node.exe を拾わないよう、PATH で見つけた場所を mcp.json に書く。見つからなければ node のまま
function Get-NodePath {
    $nodeExe = Find-NodeExe
    if ($nodeExe) { return $nodeExe }
    return 'node'
}

# Claude Code の statusline から呼ぶ記録コマンド（dist/src/statusline.js）の設定。
# コンテキストの使用率と使用量（5 時間枠・7 日枠）を状態ディレクトリの usage.json に書き、ブリッジが見張る。
# refreshInterval は、待機中も枠のリセットを反映するため。node が見つからなければ $null（statusline を使わない）
function Get-StatusLineSettings {
    $statusLineJs = Join-Path $repoRoot 'dist\src\statusline.js'
    $nodeExe = Find-NodeExe
    if (-not $nodeExe) {
        Write-Warning "node が見つからないので使用量の見張りは使わない"
        return $null
    }
    return @{ type = 'command'; command = ('"{0}" "{1}"' -f $nodeExe, $statusLineJs); refreshInterval = 60 }
}

# Claude Code の hook から呼ぶ記録コマンド（dist/src/hook.js）の設定。
# セッションの開始・終了、応答の終了と失敗、通知（ターミナル側の入力待ち・使用量の上限）、圧縮を
# 状態ディレクトリの hooks.jsonl に書き、ブリッジが Slack に知らせる。node が見つからなければ空
# node の探し方が Find-NodeExe と違う（-CommandType Application が無い）。そろえると拾う node が変わりうるので、そのままにする
function Get-HookSettings {
    $hookJs = Join-Path $repoRoot 'dist\src\hook.js'
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Warning "node が見つからないので hook の通知は使わない"
        return @{}
    }
    $hooks = @{}
    # UserPromptSubmit は、手元で入力して作業中になったことを知るため（キャッシュのつなぎ止めを作業中に送らない）
    foreach ($hookEvent in @('SessionStart', 'SessionEnd', 'Stop', 'StopFailure', 'Notification', 'PostCompact', 'UserPromptSubmit')) {
        # exec 形式（command + args）でシェルを挟まず起動する（パスの引用符の問題を避ける）
        $hooks[$hookEvent] = @(@{ hooks = @(@{ type = 'command'; command = $node.Source; args = @($hookJs); timeout = 5 }) })
    }
    return $hooks
}

# channel-settings.json に次を足し、%TEMP% に書き出したものを --settings に渡す。
# - permissions.allow: extra-mcp.json に登録した MCP サーバーのツール全部（mcp__<サーバー名>。使う人が承知して入れたものなので確認を挟まない）と、
#   Slack の「今後も許可」で足したルール
# - hooks: Get-HookSettings
# - statusLine: Get-StatusLineSettings
# deny は channel-settings.json のまま（allow より優先される）。作れなければ channel-settings.json をそのまま渡す
function Get-EffectiveSettings {
    param([hashtable]$ExtraServers)

    $extra = @(@($ExtraServers.Keys | Sort-Object | ForEach-Object { "mcp__$_" }) + @(Get-AllowExtraRules))
    try {
        $merged = Join-Path (Get-TempDir) "$sessionName\channel-settings.merged.json"
        Write-EffectiveSettings -SettingsFile $resolvedSettingsFile -OutFile $merged -ExtraAllow $extra -Hooks (Get-HookSettings) -StatusLine (Get-StatusLineSettings)
        return $merged
    } catch {
        Write-Warning "許可ルールと hook を足した設定を作れなかったので、channel-settings.json をそのまま使う: $($_.Exception.Message)"
        return $resolvedSettingsFile
    }
}

# 作業フォルダーの local スコープに、待つだけの slackbridge を登録する（登録済みなら何もしない）。
# Claude Code 2.1.289 から、--dangerously-load-development-channels の server:<名前> は設定ファイルに同じ名前の
# サーバーが無いと受け付けられず、--mcp-config で渡したものは数に入らない。channel セッションは --strict-mcp-config
# なので、実際に動くのは --mcp-config の本物のほう。普段のセッションでは、この登録は Slack にもロックにも触らない
# （src/placeholder.ts）。登録に失敗しても起動は続ける（チャンネルが無効になるだけなので、警告で知らせる）
function Register-PlaceholderServer {
    param([string]$ProjectDir)

    $configPath = Get-ClaudeUserConfigPath
    if (Test-PlaceholderServer -ConfigPath $configPath -ProjectDir $ProjectDir -ServerName $ServerName -ScriptPath $mainJs) {
        return
    }
    # claude.exe の stderr（未登録のときの remove のエラーなど）で止まらないようにする
    $ErrorActionPreference = 'Continue'
    Push-Location -LiteralPath $ProjectDir
    try {
        $null = & $claude mcp remove -s local $ServerName 2>$null
        $null = & $claude mcp add -s local $ServerName -e $PlaceholderEnvAssignment -- node $mainJs 2>$null
    } finally {
        Pop-Location
    }
    if (Test-PlaceholderServer -ConfigPath $configPath -ProjectDir $ProjectDir -ServerName $ServerName -ScriptPath $mainJs) {
        Write-Host "[start] $ProjectDir の local スコープに $ServerName を登録した（普段のセッションでは何もしない。docs/security.md の「権限の設計」）"
    } else {
        Write-Warning "$ProjectDir の local スコープに $ServerName を登録できなかった。Slack のメッセージがセッションに届かないかもしれない（claude mcp add -s local $ServerName -e $PlaceholderEnvAssignment -- node `"$mainJs`" を手で実行する）"
    }
}

# --- 起動の補助 -----------------------------------------------------------------

# Start-Process -ArgumentList に渡す値を、空白を含んでも 1 つの引数として届くよう引用符で囲む
function Quote-Arg {
    param([string]$Value)
    return '"' + $Value + '"'
}

# 警告ダイアログに自動で答える dialog-answer.ps1 を、同じコンソールで別プロセスとして起動する。
# 初回も起動し直しも使う（PC の再起動後などに手で答えなくて済むように）。
# Start-Process -ArgumentList は要素を空白でつなぐだけなので、空白を含みうる値は引用符で囲む
# （囲まないと 'development channel' が 2 つの引数に割れて、dialog-answer.ps1 が起動時に失敗する）
function Start-DialogAnswerer {
    Start-Process -FilePath $powershellExe -NoNewWindow -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', (Quote-Arg (Join-Path $PSScriptRoot 'dialog-answer.ps1')),
        '-Pattern', (Quote-Arg $DevChannelDialogPattern), '-ChoicePattern', (Quote-Arg $DevChannelChoicePattern),
        '-TimeoutSec', $DevChannelDialogTimeoutSec,
        '-LogFile', (Quote-Arg (Join-Path $resolvedStateDir 'logs\dialog-answer.log'))
    ) | Out-Null
}

# claude.exe の終了後に、もう一度起動するかと、次の起動の状態を決める。
# 戻り値は @{ Again; ResumeArgs; Relaunch; RestartTimes }。どの分岐にも当たらなければ Again が $false で、ほかは受け取った値のまま。
# 状態はループの変数に呼び出し側で戻す（関数の中の代入はループの変数に届かないため）
function Resolve-NextLaunch {
    param($ExitCode, $LaunchedAt, [object[]]$ResumeArgs = @(), [bool]$Relaunch, [object[]]$RestartTimes = @())

    $next = @{ Again = $false; ResumeArgs = $ResumeArgs; Relaunch = $Relaunch; RestartTimes = $RestartTimes }
    if (Test-Path -LiteralPath $restartFlag) {
        # 印に session_id があり、その会話の記録があれば --resume でその会話を開く。
        # 記録が無い（起動してから一度もやりとりしていない会話は保存されない）・id が分からないときは新しい会話で起動する。
        # --continue は使わない（このフォルダーで最新の会話を開くので、同じフォルダーの VS Code などの会話を開いてしまう）
        $sessionId = Read-RestartSessionId -Path $restartFlag
        Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue
        $next.Again = $true
        $next.Relaunch = $true
        # @() で包む（要素 1 つの配列を関数の結果で代入すると文字列になる）
        $next.ResumeArgs = @(Get-ResumeArgs -SessionId $sessionId)
        Write-Host ""
        if ($next.ResumeArgs.Count -gt 0) {
            Write-Host "[start] Slack からの指示で起動し直す（--resume $sessionId で会話を引き継ぐ）"
        } else {
            Write-Host "[start] Slack からの指示で起動し直す（引き継ぐ会話の記録が無いので、新しい会話で起動する）"
        }
        return $next
    }

    $isQuickResumeFailure = $ResumeArgs.Count -gt 0 -and $ExitCode -ne 0 -and ((Get-Date) - $LaunchedAt).TotalSeconds -lt $ResumeFailureSec
    if ($isQuickResumeFailure) {
        # --resume ですぐに失敗した（会話が見つからない等）。Slack から戻せなくならないよう、新しい会話で 1 回だけ起動し直す
        $next.Again = $true
        $next.ResumeArgs = @()
        Write-Host ""
        Write-Host "[start] --resume での起動に失敗した（exit=$ExitCode）。新しい会話で起動し直す"
        return $next
    }

    if ($ExitCode -ne 0 -and (Test-AutoRestartEnabled -EnvFile (Join-Path $resolvedStateDir $EnvFileName))) {
        return Resolve-CrashRestart -Next $next -ExitCode $ExitCode
    }
    return $next
}

# 想定外の終了（使用量の上限・クラッシュなど）のとき。ブリッジも一緒に止まっているので、同じ会話で起動し直して知らせる。
# 直近 AutoRestartWindowMin 分で AutoRestartMax 回に達していたら起動し直しを諦め、単発のコマンドで知らせる。
# Next（Resolve-NextLaunch の戻り値の形）を更新して返す
function Resolve-CrashRestart {
    param([hashtable]$Next, $ExitCode)

    $Next.RestartTimes = @(Select-RecentRestarts -Times $Next.RestartTimes -Now (Get-Date) -WindowMin $AutoRestartWindowMin)
    if ($Next.RestartTimes.Count -ge $AutoRestartMax) {
        $text = "🛑 Claude Code が $AutoRestartWindowMin 分で $AutoRestartMax 回、想定外に終了した（最後の exit code $ExitCode）。起動し直しを止めた。手元で確かめる"
        Write-Host ""
        Write-Host "[start] $text"
        # 関数の出力は戻り値に混ざるので、notify-cli の出力は画面に直接出す
        & (Get-NodePath) (Join-Path $repoRoot 'dist\src\notify-cli.js') $text | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Warning "Slack に知らせられなかった" }
        return $Next
    }

    $Next.RestartTimes += (Get-Date)
    $sessionId = Get-LastHookSessionId -HookLog (Join-Path $resolvedStateDir $HookLogFileName) -SessionTag $sessionTag
    $Next.ResumeArgs = @(Get-ResumeArgs -SessionId $sessionId)
    Write-CrashRecord -Path (Join-Path $resolvedStateDir $CrashFileName) -ExitCode $ExitCode -Count $Next.RestartTimes.Count `
        -Max $AutoRestartMax -WindowMin $AutoRestartWindowMin -Resumed ($Next.ResumeArgs.Count -gt 0)
    $Next.Again = $true
    $Next.Relaunch = $true
    Write-Host ""
    Write-Host "[start] 想定外の終了（exit=$ExitCode）。起動し直す（$AutoRestartWindowMin 分で $($Next.RestartTimes.Count)/$AutoRestartMax 回目）"
    return $Next
}

# --- 本体 ---------------------------------------------------------------------

$claude = Get-ClaudeExeOrExit
Confirm-Built
Confirm-StateFiles
$projectDir = Resolve-ProjectDir

# 前の画面（同じタブで前に動かした claude の画面など）が残っていると、dialog-answer.ps1 がそれに反応しうるので、初回も消す。
# 消すのはここまでの表示（ビルドの経過・プロジェクトの選択）だけで、この後の警告と案内は残す（案内の文には Pattern を含めていない）
if (-not $DryRun) { Clear-Host }

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

# hook（dist/src/hook.js）は claude.exe の環境を引き継ぐので、ここで状態ディレクトリを渡す。
# 渡さないと -StateDir のセッションの知らせが既定の状態ディレクトリ（別のボット）に書かれる
$env:SLACK_CHANNEL_STATE_DIR = $resolvedStateDir
# このスクリプトの起動ごとに一意の値。hook は hooks.jsonl の行に記録し、ブリッジは同じ値の行だけを扱う
# （同じ状態ディレクトリを使う別のセッションの終了・入力待ちを混ぜない）。起動し直しても同じ値のまま
$sessionTag = '{0}-{1}' -f (Get-Date -Format 'yyyyMMddHHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$env:SLACK_CHANNEL_SESSION_TAG = $sessionTag

# mcp.json と channel-settings.merged.json を作り、claude.exe に渡す引数を返す。
# Slack の「今後も許可」の追加・削除（allow-extra.json）と extra-mcp.json の変更を反映するため、起動し直すたびに呼ぶ
function New-ClaudeArgs {
    $extraServers = Read-ExtraMcpServers
    # ブリッジには状態ディレクトリと設定ファイルを環境変数で明示して渡す（claude.exe の環境の引き継ぎに頼らない）
    $bridgeEnv = @{
        SLACK_CHANNEL_STATE_DIR = $resolvedStateDir; SLACK_CHANNEL_SETTINGS_FILE = $resolvedSettingsFile; SLACK_CHANNEL_SESSION_TAG = $sessionTag
    }
    # ログのレベルは、このシェルで設定されていればブリッジに渡す（省略時はブリッジの既定の info）
    if ($env:SLACK_CHANNEL_LOG_LEVEL) { $bridgeEnv.SLACK_CHANNEL_LOG_LEVEL = $env:SLACK_CHANNEL_LOG_LEVEL }
    $mcpConfig = Write-McpConfig -FileName "$sessionName\mcp.json" -ServerName $ServerName -ScriptPath $mainJs `
        -NodePath (Get-NodePath) -ExtraServers $extraServers -Env $bridgeEnv
    $effectiveSettings = Get-EffectiveSettings -ExtraServers $extraServers

    # 各フラグの意味は docs/security.md の「権限の設計」を参照
    return @(
        '--mcp-config', $mcpConfig,
        '--strict-mcp-config',
        '--no-chrome',
        '--setting-sources', 'project,local',
        '--settings', $effectiveSettings,
        '--permission-mode', $PermissionMode,
        # 他のフラグより後ろ、最後に置く
        '--dangerously-load-development-channels', "server:$ServerName"
    )
}

$claudeArgs = New-ClaudeArgs

Write-Host "claude.exe: $claude"
Write-Host "作業ディレクトリ: $projectDir"
Write-Host "状態ディレクトリ: $resolvedStateDir"
Write-Host "起動時の警告ダイアログには自動で 1 を選ぶ（$DevChannelDialogTimeoutSec 秒たっても残っていたら手で 1 を選ぶ）"

$restartFlag = Join-Path $resolvedStateDir $RestartFlagName

if ($DryRun) {
    Write-Host "[DryRun] 実行されるコマンドライン（mcp.json と合成した設定は DryRun 用のフォルダーに書いた。本番の起動では末尾の -dryrun が付かない）:"
    Write-Host (Format-CommandLine -Exe $claude -Arguments $claudeArgs)
    Write-Host "[DryRun] 終了時に $restartFlag があれば、--resume <印の session_id>（会話の記録が無ければ新しい会話）で起動し直す"
    Write-Host "[DryRun] 初回も起動し直しも、警告ダイアログには scripts\dialog-answer.ps1 が答える"
    Write-Host "[DryRun] 起動前に、$projectDir の local スコープに $ServerName が無ければ登録する（DryRun では登録しない）"
    exit 0
}

Register-PlaceholderServer -ProjectDir $projectDir

# --- 起動（Slack の !restart で印が置かれていたら、同じ会話を開いて起動し直す） ------------------

# 前回の残り（起動し直す前に手で止めた等）は捨てる
Remove-Item -LiteralPath $restartFlag -Force -ErrorAction SilentlyContinue

# 起動し直すときに付ける引数（初回・引き継ぐ会話が無いときは空）
$resumeArgs = @()
# 想定外の終了で起動し直した時刻（直近 AutoRestartWindowMin 分の分だけ数える）
$restartTimes = @()
# Slack からの指示で起動し直している（前のセッションの画面を消してから起動する）
$relaunch = $false
# 作業フォルダーにある powershell.exe を拾わないよう、OS 付属のものを絶対パスで起動する
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Push-Location -LiteralPath $projectDir
try {
    do {
        if ($relaunch) {
            # 前のセッションの画面（Slack の発言など）が残っていると、dialog-answer.ps1 がそれに反応しうるので消す
            Clear-Host
            # 前の起動の後に「今後も許可」で足した・消したルールを反映するため、mcp.json と merged.json を作り直す
            $claudeArgs = New-ClaudeArgs
        }
        $launchArgs = Get-LaunchArgs -ResumeArgs $resumeArgs -ClaudeArgs $claudeArgs
        Start-DialogAnswerer
        $launchedAt = Get-Date
        & $claude @launchArgs
        $code = $LASTEXITCODE
        $next = Resolve-NextLaunch -ExitCode $code -LaunchedAt $launchedAt -ResumeArgs $resumeArgs -Relaunch $relaunch -RestartTimes $restartTimes
        $again = $next.Again
        $resumeArgs = $next.ResumeArgs
        $relaunch = $next.Relaunch
        $restartTimes = $next.RestartTimes
    } while ($again)
    exit $code
} finally {
    Pop-Location
}
