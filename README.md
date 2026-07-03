# claude-slack-channel

Slack の DM を、手元で動いている Claude Code のセッションへ中継する MCP channel サーバー。
Slack から話しかけると手元の `claude.exe` が応答し、返信・リアクション・実行許可の確認まで
Slack 側だけで完結する。

## 概要

```
Slack (DM)
   │  Socket Mode（サーバー側から WebSocket を張るので、ポート開放やトンネルは不要）
   ▼
claude-slack-channel（dist/src/main.js、node で動く）
   │  MCP（標準入出力、experimental の channels 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- 許可したユーザーからの DM が、Claude のセッションへそのまま届く。
- Claude は `reply` / `react` / `edit_message` の3ツールで Slack に返信する。
- ファイル書き込みなどの実行許可は、Slack のボタンか `yes xxxxx` / `no xxxxx` の返信で答えられる。
- 対象は Windows。起動スクリプトは PowerShell で書かれている。

## 必要なもの

- Windows と Windows Terminal（VS Code の統合ターミナルは動作確認していないので対象外）
- Node.js 22.12 以上。`node` と `npm` に **PATH が通っていること**（Claude Code は `node` コマンドでこのサーバーを起動する）
- Claude Code v2.1.234 以上（Slack 側での実行許可承認に必要）。`claude.exe` は次の順に探す
  1. PATH 上の `claude`
  2. VS Code 拡張の同梱版 `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<版>-win32-x64\resources\native-binary\claude.exe`（複数あれば最新版）
- Claude の Pro 以上のサブスクリプション
- Slack ワークスペースの管理権限（アプリのインストールに必要）

## セットアップ

### 0. clone してビルドする

```powershell
git clone https://github.com/elys0912/claude-slack-channel.git
cd claude-slack-channel
npm install
npm run build
```

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
   **Scopes** に次の5つがあるか確認する。

   | スコープ | 用途 |
   |---|---|
   | `chat:write` | 返信と実行許可メッセージの投稿 |
   | `im:history` | DM（`message.im`）の受信 |
   | `im:write` | 許可ユーザーとの DM を開く（`conversations.open`） |
   | `reactions:write` | 受信・判定のリアクション |
   | `users:read` | `npm run check` での表示名の確認 |

4. Slack で自分のプロフィールを開き、**その他** → **メンバーIDをコピー** で自分の ID
   （`U` で始まる）を控える。

### 2. 状態ファイル（`.env` と `access.json`）を作る

状態ディレクトリ `%USERPROFILE%\.claude\channels\slack` に、メモ帳で次の2ファイルを作る。
文字コードは **BOM なしの UTF-8**（メモ帳の「UTF-8」）で保存する（BOM 付きでも読めるが推奨しない）。
場所を変えるときは [環境変数](#環境変数) を参照。

`.env`（ひな形: [config/env.example](config/env.example)）:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

`KEY=VALUE` 形式。`#` で始まる行と、引用符の外の ` #` 以降はコメントとして無視される。

`access.json`（ひな形: [config/access.example.json](config/access.example.json)）:

```json
{
  "teamId": "T00000000",
  "allowFrom": ["U00000000"]
}
```

- `teamId`: ワークスペースの ID（`T` で始まる）。次の `npm run check` で確認できる。
- `allowFrom`: DM を受け付けるユーザー ID（`U` で始まる）。1件以上、重複不可。
  ここに無い相手からの DM とボタン操作は無視される。

> **Claude に作らせない理由**: この2ファイルはトークンと許可リストそのもの。Claude に扱わせると、
> ログや会話履歴に混入する経路が増える。手で作ること。起動スクリプトも存在を確認するだけで中身は読まない。

### 3. 疎通を確認する

```powershell
npm run check
```

ビルドしてから、次を表示する。トークンそのものは出ない（`xoxb-***` のように接頭辞だけ）。

- 状態ディレクトリの場所
- ワークスペース名・`team_id`・ボットの user ID
- `access.json` の `teamId` が実際の `team_id` と食い違っていれば警告
- `allowFrom` に書いた ID の表示名

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

Windows Terminal から実行する。

| コマンド | 動作 |
|---|---|
| `scripts\start.cmd` | `projects.json` の一覧から番号で選んで起動（Enter で先頭、`q` で中止） |
| `scripts\start.cmd my-app` | `projects.json` の name で指定して起動 |
| `scripts\start.cmd C:\path\to\app` | パスで直接指定して起動 |
| `scripts\start.cmd my-app -PermissionMode auto` | 実行許可のモードを変える（[権限の設計](#権限の設計)） |
| `scripts\start.cmd -DryRun` | 起動せず、実行されるコマンドラインだけ表示 |

- 起動のたびに experimental channels の警告ダイアログが出るので、**「1」（I am using this for local development）** を選ぶ。
- `dist` が無いときだけ自動でビルドする。**`git pull` で更新したあとは `npm run build` を手で実行する**（古い `dist` のまま起動してしまうため）。
- 起動後は Slack でこのボットに DM を送ればよい。

## 使い方

### メッセージ

- ボットに DM を送ると手元のセッションに届き、届いた印に :eyes: が付く。Claude の返信は元のメッセージのスレッドに返る。
- 受け付けるのは **ボットとの DM だけ**。チャンネルやグループ DM、編集・削除などのイベントは無視する。
- **添付ファイルは中身を渡さない**。ファイル名・種類・サイズの要約だけが Claude に届く（本文が無ければ `(attachment)`）。
- 受信したメッセージは届いた順に1件ずつ処理する。
- 長い返信は自動で複数のメッセージに分割される。途中で送信に失敗した場合、Claude には何件目まで送れたか（`sent=N`）付きのエラーが返る。
- 投稿したリンクのプレビュー（unfurl）は展開しない。
- セッションは1つだけで、Slack 側の会話はすべて同じ文脈を共有する。
- **Slack からは `/clear` できない**（ローカルのターミナルで操作する）。

### 実行許可

許可リストに無い操作を Claude が行おうとすると、ボタン付きのメッセージが届く
（直前に会話していたスレッドがあればそこに、無ければ DM のトップレベルに出る）。

- **Allow / Deny** ボタンで答えるか、`yes xxxxx` / `no xxxxx` と返信する。
  `xxxxx` はメッセージに表示された5文字の ID。`y` / `n` でもよく、大文字小文字は問わない。
- 答えると、メッセージは `Allowed` / `Denied` と回答者の表示に書き換わる。テキストで答えた場合は、
  その返信に :white_check_mark: / :x: が付く。
- 保留中でない ID への `yes xxxxx` は回答として扱わず、通常のメッセージとして Claude に届く。
- 有効期限は **30分**。期限切れのボタンを押すと、メッセージが期限切れ表示に変わるだけで Claude には送らない。
- 入力内容（コマンドや差分）が長いときは先頭と末尾だけを表示し、省略した旨を示す。
  **See more** ボタンで全文をスレッドに送る（長ければ複数メッセージに分割）。
- 文字の向きを変える制御文字やゼロ幅文字は、見えない形で紛れ込まないよう記号に置き換えて表示する。
- ターミナル側でも同じ確認が出ている。どちらで答えてもよい。

## 権限の設計

起動スクリプトは `claude.exe` を次のフラグで起動する。

| フラグ | 目的 |
|---|---|
| `--mcp-config %TEMP%\claude-slack-channel\mcp.json` | `slackbridge` サーバーを読み込む。clone 先の絶対パスを含むので、起動のたびに生成する |
| `--strict-mcp-config` | `--mcp-config` 以外の MCP サーバー（ユーザー設定やプロジェクトの `.mcp.json`）を読み込まない |
| `--setting-sources project,local` | ユーザー設定（`~/.claude/settings.json`）を読まない。便利さのために入れた緩い許可（`Bash(*)` など）に乗って、Slack からの指示が無確認で実行されるのを防ぐ |
| `--settings config\channel-settings.json` | channel セッション専用の設定を重ねる。managed（組織の管理設定）を除き、どの設定よりも上位 |
| `--permission-mode default` | 許可リストに無い操作は毎回確認する（`-PermissionMode` で変更可、下記） |
| `--dangerously-load-development-channels server:slackbridge` | experimental の channels 機能を有効にする |

また、起動する `claude.exe` にだけ環境変数 `ENABLE_CLAUDEAI_MCP_SERVERS=false` を渡し、claude.ai 側の connector を読み込まない。

**プロジェクト側の設定は効く**: `--setting-sources project,local` なので、作業ディレクトリの
`.claude/settings.json` / `.claude/settings.local.json` の allow はそのまま有効になる。
緩い allow が入ったプロジェクトで起動しないこと。Claude 自身が `.claude/` 以下を書き換えて許可を広げることは deny で禁止している。

### `-PermissionMode`

| 値 | 動作 |
|---|---|
| `default`（既定） | 許可リストに無い操作は毎回確認する |
| `auto` | 分類器が安全と判断した操作は確認なしで通す |
| `acceptEdits` | 作業ディレクトリ内のファイル編集を**確認なしで**通す。Slack からの指示だけでファイルが書き換わるので、使うなら信頼できる相手とだけ |
| `plan` | 読み取りと計画だけで、変更はしない |

どのモードでも deny ルールは効く。`bypassPermissions` への切り替えは `channel-settings.json` で禁止している。

### [config/channel-settings.json](config/channel-settings.json)

- **allow**: プロジェクト内の読み取り（`Read(./**)`）、`Glob` / `Grep`、このサーバーの3ツール。
  git コマンドは allow に入れていない（`git diff --no-index` などでプロジェクト外のファイルを読めるため）。
- **deny**（読み取り・書き込みを禁止）:
  - Claude Code の設定と状態: `~/.claude/**`（状態ディレクトリを含む）、`~/.claude.json`、プロジェクトの `.claude/**` の編集
  - 認証情報: `~/.ssh/**`、`~/.git-credentials`、`~/.aws/**`、`~/.config/gh/**`、`~/.npmrc`、`~/.docker/**`
  - 秘密ファイル: どこにあっても `.env*`、`*.pem`、`*.key`
  - 破壊的な git 操作: `git push --force` / `-f`、`git reset --hard`（Bash・PowerShell の両方）
- **`disableBypassPermissionsMode`**: `bypassPermissions` モードへの切り替えを禁止
- **`disableClaudeAiConnectors`**: claude.ai 側の connector を読み込まない

deny は allow より必ず優先される（評価順は deny → ask → allow）。

> **状態ディレクトリを移したとき**: 既定の場所は `Read(~/.claude/**)` で守られているが、
> `SLACK_CHANNEL_STATE_DIR` で別の場所にした場合は、そのパスの `Read(...)` / `Edit(...)` を deny に自分で追加する。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような
> 間接呼び出しまでは塞がない（Claude Code のパターンマッチの既知の制限）。`sh -c` 自体は確認待ちになるが、
> 確認で許可すれば実行される。

## セキュリティ

- 送信者は Slack のユーザー ID（`allowFrom`）とワークスペース ID（`teamId`）で判定する。表示名やメールアドレスでは判定しない。
- トークンは状態ディレクトリの `.env` だけに置く。環境変数からは読まず、MCP 設定ファイルにも書かない。
- ログに出るトークン（`xox?-` / `xapp-` / `Bearer`）は伏せ字にする。
- 送信するテキストの `@channel` / `@here` / `@everyone` / ユーザーグループへのメンションは無効化する。
- Slack から届くメッセージは信頼できない入力として扱い、上記の権限設計で実行できる範囲を絞っている。

### 複数ユーザーで使うとき

`allowFrom` の全員が同じセッションを共有する。実行許可のメッセージは全員の DM に届き、
**誰か1人が答えればそれで決まる**（他の人のメッセージも結果表示に書き換わる）。

### 残るリスク

- 許可ユーザーの Slack アカウントが乗っ取られると、そのまま手元の Claude を操作される。
- 確認で許可した操作は、その内容どおりに実行される。確認内容をよく読むこと。
- Slack のメッセージ・リポジトリの中身・Web ページに仕込まれた指示（プロンプトインジェクション）を Claude が実行しようとする可能性がある。確認で止めるのが最後の防御になる。
- `Read(./**)` により、deny に当たらないプロジェクト内のファイルは確認なしで読まれ、その内容が Slack に返信されうる。
- 会話の内容（コードやログを含む）は Slack 側に保存される。
- プロジェクト側の `.claude/settings*.json` の allow は有効なまま。
- `.env` のトークンは平文で保存される。

### トークンが漏れたとき

1. **まず App-Level Token を即 Revoke する**: [api.slack.com/apps](https://api.slack.com/apps) → **Basic Information** → **App-Level Tokens**。これで Socket Mode の接続（DM の受信）を止められる。
2. **OAuth & Permissions** でボットトークンを失効させる（またはアプリを再インストールして新しいトークンを発行する）。
3. `.env` を新しいトークンで書き直す。
4. `npm run check` で疎通を確認してから、`scripts\start.cmd` で再起動する。

### 許可リストから外すとき

`access.json` の `allowFrom` から該当の ID を消して保存し、セッションを再起動する
（起動中のサーバーは `access.json` を読み直さない）。

## 設定リファレンス

### ファイル

| ファイル | 場所 | 内容 |
|---|---|---|
| `.env` | 状態ディレクトリ | `SLACK_BOT_TOKEN`（`xoxb-`）、`SLACK_APP_TOKEN`（`xapp-`） |
| `access.json` | 状態ディレクトリ | `teamId`（`T...`）、`allowFrom`（`U...` の配列）。これ以外のキーはエラー |
| `projects.json` | `config\` | `projects`: `{ name, path }` の配列。起動時の選択肢 |
| `channel-settings.json` | `config\` | channel セッション専用の Claude Code 設定 |
| `logs\bridge.log` | 状態ディレクトリ | ログ（下記） |
| `instance.lock` | 状態ディレクトリ | 多重起動防止のロック（自動で作られ、終了時に消える） |
| `mcp.json` | `%TEMP%\claude-slack-channel\` | 起動スクリプトが毎回生成する MCP 設定 |

### 環境変数

| 変数 | 用途 |
|---|---|
| `SLACK_CHANNEL_STATE_DIR` | 状態ディレクトリを変える（既定 `%USERPROFILE%\.claude\channels\slack`）。**絶対パスで指定する**（相対パスはサーバーの作業ディレクトリ＝プロジェクト基準で解決される）。変えたら deny も書き換える |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | 起動スクリプトが `false` を設定する（手で設定する必要はない） |

トークンは環境変数からは読まない。

### ログ

- 出力先は `logs\bridge.log` と stderr（Claude Code の `/mcp` から見える）。
- レベルは info 固定（変更する設定は無い）。
- 5MB を超えると `bridge.log.1` に退避する（1世代だけ保持し、古い `.1` は上書き）。

### 固定値

| 項目 | 値 |
|---|---|
| 実行許可の有効期限 | 30分 |
| ロックのハートビート / 失効 | 10秒ごとに更新 / 30秒更新が無ければ失効 |
| 再接続の待ち時間 | 1秒から倍々で最大60秒 |

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 何が起きたか知りたい | `logs\bridge.log` を見る（トークンはマスク済み） |
| 接続状態を知りたい | セッション内で `/mcp` を実行し、`slackbridge` の状態を見る |
| 起動スクリプトが `claude.exe が見つからない` | PATH に `claude` を通すか、VS Code の Claude Code 拡張を入れる |
| `/mcp` で `slackbridge` が failed | `node` に PATH が通っているか、`npm run build` 済みかを確認。理由は stderr とログに出る |
| `.env が見つからない` / `access.json の検証に失敗` | 状態ディレクトリの場所とファイル名（`.env.txt` になっていないか）、JSON の形式、ID の先頭文字（`T` / `U`）を確認 |
| `auth.test の team_id が access.json と一致しない` | `npm run check` で `team_id` を確認して `teamId` を直す |
| `許可ユーザーの DM チャンネルを 1 件も開けなかった` | `allowFrom` の ID と `im:write` スコープを確認 |
| `invalid_auth` | `SLACK_BOT_TOKEN` が無効。`npm run check` で確認し、トークンを取り直す |
| `missing_scope` | **OAuth & Permissions** で5スコープが揃っているか確認し、足りなければ再インストール |
| ツールが「別のインスタンスが動いている」エラーを返す | 別のセッションが Slack ブリッジを使用中。2つ目以降は Slack に接続しない縮退モードで動き、ツールはすべてエラー、実行許可は Slack に出ない（ターミナルで答える）。先のセッションを終了してから起動し直す |
| 直前のセッションを落とした直後に起動したら縮退モードになった | 前のプロセスのロックが残っている。30秒待ってから起動し直す |
| DM を送っても :eyes: が付かない | `allowFrom` に自分の ID があるか、DM の相手がこのボットかを確認。ログの `受信を破棄 reason=...` は debug なので出ない。起動時に DM を開けなかったユーザーは、そのユーザーから DM が届いた時点で送信先に加わる |
| 実行許可のメッセージが Slack に来ない | 縮退モードでないか確認。ターミナル側の確認は常に出ている |
| スリープ復帰後に反応しない | 自動で再接続する（最大60秒間隔で繰り返す）。しばらく経っても駄目ならログを確認して起動し直す |
| 更新したのに挙動が変わらない | `npm run build` を実行してから起動し直す |

## 開発

```powershell
npm test             # vitest
npm run typecheck    # tsc --noEmit（本体とテストの両方）
npm run build        # dist へ出力
```

### ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。ロガー・ロック・設定の読み込み、終了処理 |
| `src/app.ts` | Slack・MCP・permission リレーの配線（通常モードと縮退モード） |
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
| `scripts/common.ps1` | 起動スクリプトの共通関数（claude.exe の探索、mcp.json の生成） |
| `config/channel-settings.json` | channel セッション専用の権限設定 |
| `config/*.example*` | `projects.json` / `access.json` / `.env` のひな形 |
| `slack-app-manifest.yaml` | Slack アプリの manifest |
| `test/` | vitest のテスト |

## ライセンス

[MIT](LICENSE)
