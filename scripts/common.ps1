# start.ps1 / spike.ps1 から dot-source して使う共通関数。

# claude.exe の場所を返す。PATH を優先し、無ければ VS Code 拡張の同梱版のうち
# 最新バージョンを使う。見つからなければ $null。
function Find-ClaudeExe {
    $onPath = Get-Command claude -ErrorAction SilentlyContinue
    if ($onPath) {
        return $onPath.Source
    }

    $extensionsRoot = Join-Path $env:USERPROFILE '.vscode\extensions'
    if (-not (Test-Path $extensionsRoot)) {
        return $null
    }

    # ディレクトリ名は文字列ソートだとバージョン順にならない（"9" > "10"）ので、
    # 例: anthropic.claude-code-2.1.278-win32-x64 から 2.1.278 を取り出して [version] で比べる。
    $candidates = Get-ChildItem -Path $extensionsRoot -Directory -Filter 'anthropic.claude-code-*-win32-x64' -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match 'anthropic\.claude-code-(\d+\.\d+\.\d+)-win32-x64$') {
                $exe = Join-Path $_.FullName 'resources\native-binary\claude.exe'
                if (Test-Path $exe) {
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
        [Parameter(Mandatory)][string]$ScriptPath
    )

    $path = Join-Path $env:TEMP "claude-slack-channel\$FileName"
    New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null

    $json = @{
        mcpServers = @{
            $ServerName = @{ command = 'node'; args = @($ScriptPath) }
        }
    } | ConvertTo-Json -Depth 5
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
