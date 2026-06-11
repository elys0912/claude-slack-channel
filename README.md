# claude-slack-channel

Slack の DM を、手元で動いている Claude Code のセッションへ中継する MCP channel サーバー。
Slack から話しかけると手元の `claude.exe` が応答し、返信・リアクション・実行許可の確認まで
Slack 側だけで完結する。

## クイックスタート

初回は先に [セットアップ](#セットアップ) を済ませておくこと。

```powershell
npm install
npm run build
npm run check                # Slack への疎通確認
scripts\start.cmd my-app     # config\projects.json の name か、パスを指定して起動
```

起動時に出る警告ダイアログでは **「1」（I am using this for local development）** を選ぶ。
あとは Slack でこのボットに DM を送ればよい。

## 仕組み

```
Slack (DM)
   │  Socket Mode（サーバー側から WebSocket を張るので、ポート開放やトンネルは不要）
   ▼
claude-slack-channel（dist/src/main.js）
   │  MCP（標準入出力、experimental の channels 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- Slack のメッセージは、Claude のセッションへ直接届く。
- Claude からは `reply` / `react` / `edit_message` の3ツールで Slack に返信する。
- ファイル書き込みなどの実行許可は、Slack のボタンか `yes xxxxx` / `no xxxxx` の返信でも答えられる。

## 必要なもの

- Node.js 22.12 以上
- Claude Code v2.1.234 以上（Slack 側での実行許可承認に必要）
- Claude の Pro 以上のサブスクリプション
- Slack ワークスペースの管理権限（アプリのインストールに必要）

## セットアップ

### 1. Slack アプリを作る

[api.slack.com/apps](https://api.slack.com/apps) で次の順に操作する。

1. **Create New App** → **From an app manifest** → ワークスペースを選び、
   [slack-app-manifest.yaml](slack-app-manifest.yaml) の中身を貼り付けて作成する。
   DM 専用・Socket Mode 有効・最小限のスコープを持つアプリができる。
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** で、
   スコープ `connections:write` のトークンを発行する。
   → `xapp-` で始まるこのトークンが **`SLACK_APP_TOKEN`**。
3. **OAuth & Permissions** → **Install to Workspace** でインストールする。
   → 発行される `xoxb-` で始まるトークンが **`SLACK_BOT_TOKEN`**。
   **Scopes** に `chat:write` / `im:history` / `im:write` / `reactions:write` の4つがあるか確認する。
4. Slack で自分のプロフィールを開き、**その他** → **メンバーIDをコピー** で自分の ID
   （`U` で始まる）を控える。

### 2. `.env` と `access.json` を作る

状態ディレクトリ `%USERPROFILE%\.claude\channels\slack` に、メモ帳で次の2ファイルを作る
（場所は環境変数 `SLACK_CHANNEL_STATE_DIR` で変えられる）。

`.env`（ひな形: [config/env.example](config/env.example)）:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

`access.json`（ひな形: [config/access.example.json](config/access.example.json)）:

```json
{
  "teamId": "T00000000",
  "allowFrom": ["U00000000"]
}
```

`allowFrom` に入っていない相手からの DM は無視される。`teamId` は次の `npm run check` で確認できる。

> **Claude に作らせない理由**: この2ファイルはトークンと許可リストそのもの。Claude に扱わせると、
> ログや会話履歴に混入する経路が増える。手で作り、Claude には存在確認（中身は読まない）だけさせる。

### 3. 疎通を確認する

```powershell
npm install
npm run build
npm run check
```

`npm run check` は次を表示する。トークンそのものは画面に出ない（`xoxb-***` のように接頭辞だけ）。

- ワークスペース名・`team_id`・ボットの user ID
- `allowFrom` に書いた ID の表示名
- `access.json` の `teamId` が実際の `team_id` と食い違っていれば警告

### 4. 起動するプロジェクトを登録する

[config/projects.example.json](config/projects.example.json) を `config\projects.json` にコピーし、
Claude Code を起動したいプロジェクトを並べる（`projects.json` は git 管理外）。

```json
{
  "projects": [
    { "name": "my-app", "path": "C:\\path\\to\\my-app" }
  ]
}
```

## 起動

**Windows Terminal から** 起動する（VS Code の統合ターミナルは動作確認していないので対象外）。

| コマンド | 動作 |
|---|---|
| `scripts\start.cmd` | `projects.json` の一覧から番号で選んで起動（Enter で先頭、`q` で中止） |
| `scripts\start.cmd my-app` | `projects.json` の name で指定して起動 |
| `scripts\start.cmd C:\path\to\app` | パスで直接指定して起動 |
| `scripts\start.cmd my-app -PermissionMode auto` | 実行許可のモードを変える（下記） |
| `scripts\start.cmd -DryRun` | 起動せず、実行されるコマンドラインだけ表示 |

`dist` が無ければ自動でビルドする。起動のたびに警告ダイアログ（experimental channels の確認）が
出るので、**「1」（I am using this for local development）** を選ぶ。

## 使い方

- このボットに DM を送ると、手元のセッションに届く。返信は元のメッセージのスレッドに返る。
- 実行許可が必要な操作は、Slack にボタン付きメッセージが届く。ボタンで答えるか、
  `yes xxxxx` / `no xxxxx` で返信する（`xxxxx` は表示された5文字の ID）。
- セッションは1つだけで、Slack 側の会話はすべて同じ文脈を共有する。
- **Slack からは `/clear` できない**（ローカルのターミナルで操作する）。

## 権限の設計

起動スクリプトは `claude.exe` を次のフラグで起動する。

| フラグ | 目的 |
|---|---|
| `--mcp-config %TEMP%\claude-slack-channel\mcp.json` | `slackbridge` サーバーを読み込む。clone 先の絶対パスを含むので、起動のたびに生成する |
| `--setting-sources project,local` | ユーザー設定（`~/.claude/settings.json`）を読まない。便利さのために入れた緩い許可（`Bash(*)` など）に乗って、Slack からの指示が無確認で実行されるのを防ぐ |
| `--settings config\channel-settings.json` | channel セッション専用の許可リストを、どの設定よりも上位に重ねる |
| `--permission-mode default` | 許可リストに無い操作は毎回確認する。確認が多すぎるなら `-PermissionMode auto`（分類器が安全と判断した操作は無確認で通す）。どのモードでも deny ルールは効く |
| `--dangerously-load-development-channels server:slackbridge` | experimental の channels 機能を有効にする |

[config/channel-settings.json](config/channel-settings.json) の中身:

- **allow**: `Read` / `Glob` / `Grep`、このサーバーの3ツール、`git status` / `git diff` / `git log`
  （Windows ではどちらのシェルツールが使われるか環境依存なので、Bash・PowerShell の両方で登録）
- **deny**: 状態ディレクトリ（`~/.claude/channels/**`）、`~/.claude.json`、`~/.ssh/**`、
  プロジェクト内の `.env` 系、`git push --force` / `-f`、`git reset --hard`
- **`disableBypassPermissionsMode`**: `bypassPermissions` モードへの切り替えを禁止
- **`disableClaudeAiConnectors`**: claude.ai 側の connector を読み込まない

deny は allow より必ず優先される（評価順は deny → ask → allow）ので、`Read` を許可していても
deny に挙げたパスは読めない。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような
> 間接呼び出しまでは塞がない（Claude Code のパターンマッチの既知の制限）。allow に `Bash(*)` が
> 無いので `sh -c` 自体は確認待ちになるが、迂回が不可能なわけではない。

## セキュリティ

- 送信者は Slack のユーザー ID（`allowFrom`）で判定する。表示名やメールアドレスでは判定しない。
- トークンは状態ディレクトリの `.env` だけに置く。環境変数にも MCP 設定ファイルにも書かない。
- Slack から届くメッセージは信頼できない入力として扱い、上記の権限設計で実行できる範囲を絞っている。

### トークンが漏れたとき

1. [api.slack.com/apps](https://api.slack.com/apps) → **Basic Information** → **App-Level Tokens** で該当トークンを **Revoke**。
2. **OAuth & Permissions** でボットトークンを失効させる（またはアプリを再インストールして新しいトークンを発行する）。
3. `.env` を新しいトークンで書き直す。
4. `npm run check` で疎通を確認してから、`scripts\start.cmd` で再起動する。

### 許可リストから外すとき

`access.json` の `allowFrom` から該当の ID を消して保存し、セッションを再起動する
（起動中のサーバーは `access.json` を読み直さない）。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 何が起きたか知りたい | ログ `%USERPROFILE%\.claude\channels\slack\logs\bridge.log` を見る（トークンはマスク済み） |
| 接続状態を知りたい | セッション内で `/mcp` を実行し、`slackbridge` の状態を見る |
| `invalid_auth` | `SLACK_BOT_TOKEN` が無効。`npm run check` で確認し、トークンを取り直す |
| `missing_scope` | **OAuth & Permissions** で4スコープが揃っているか確認し、足りなければ再インストール |
| ツールが「別のインスタンスが動いている」エラーを返す | 別のセッションが Slack ブリッジを使用中（`instance.lock`）。2つ目以降は Slack に接続しない縮退モードで動く |
| スリープ復帰後に反応しない | 自動で再接続を試みる。しばらく経っても駄目ならログを確認して起動し直す |

Slack を使わずに channels 機能そのものを確かめたいときは [docs/phase0.md](docs/phase0.md) を参照。

## 開発

```powershell
npm test             # vitest
npm run typecheck    # tsc --noEmit
```

### ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。起動と、Slack・MCP・permission リレーの配線 |
| `src/slack.ts` | Slack の Socket Mode 受信と Web API 送信 |
| `src/mcp.ts` | MCP channel サーバー（`reply` / `react` / `edit_message` ツール） |
| `src/permission-relay.ts` | 実行許可リレーの状態管理（配信・回答・結果表示への書き換え） |
| `src/permission.ts` | 実行許可メッセージのブロック組み立てと、ボタン操作の検証（純関数） |
| `src/gate.ts` | 受信メッセージを中継すべきかの判定（純関数） |
| `src/config.ts` | 状態ディレクトリ・`.env` パーサー・`access.json` の検証 |
| `src/format.ts` | 送信前のテキスト整形（`@here` 等の無害化など） |
| `src/chunk.ts` | 長文の分割 |
| `src/lock.ts` | 単一インスタンス実行のファイルロック |
| `src/log.ts` | ログ出力（トークンのマスク込み） |
| `src/errors.ts` | エラー値の文字列化 helper |
| `src/stdio-guard.ts` | stdout を MCP 専用に保つガード |
| `src/types.ts` | 共有型 |
| `scripts/check.ts` | `npm run check` の実体（Slack への疎通確認） |
| `scripts/start.cmd` / `start.ps1` | 起動スクリプト |
| `scripts/spike.ps1` | [docs/phase0.md](docs/phase0.md) の echo channel スパイク用スクリプト |
| `scripts/common.ps1` | 上記スクリプトの共通関数（claude.exe の探索、mcp.json の生成） |
| `config/channel-settings.json` | channel セッション専用の権限設定 |
| `config/*.example*` | `projects.json` / `access.json` / `.env` のひな形 |
| `slack-app-manifest.yaml` | Slack アプリの manifest |

## ライセンス

[MIT](LICENSE)
