# claude-slack-channel

Slack のメッセージを、手元の PC で動いている Claude Code のセッションに中継する MCP channel サーバー（以下、ブリッジ）。
Claude の返信やリアクションを受け取るのも、実行許可に答えるのも、Slack の中で済む。Windows 専用。

初めて使うときは、「必要なもの」から「起動」までを順に進めれば動かせる。その先は、必要になったときに [ドキュメント](#ドキュメント) の該当するファイルを開く。動かないときは [トラブルシューティング](docs/reference.md#トラブルシューティング) を見る。

## 概要

```
Slack (DM / 許可したチャンネル)
   │  Socket Mode（サーバー側から WebSocket を張るので、ポート開放やトンネルは不要）
   ▼
claude-slack-channel（dist/src/main.js。node で動く）
   │  MCP（標準入出力、experimental の channels 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- 許可したユーザーからの DM と、指定したチャンネルでボットにメンションした発言が、Claude のセッションにそのまま届く。
- Claude は `reply` / `react` / `edit_message` の3つのツールで Slack に返信する。`.env` に `DOWNLOAD_DIR` を書けば、添付を保存する `download_file` も使える。
- ファイルの書き込みなどの実行許可には、Slack のボタンか `yes xxxxx` / `no xxxxx` の返信で答える。
- 起動スクリプトは PowerShell で書いてある。

## 必要なもの

- Windows と Windows Terminal。VS Code の統合ターミナルは、動作を確かめていないので対象外。
- Node.js 22.12 以上。Claude Code が `node` コマンドでこのサーバーを起動するので、`node` と `npm` に **PATH を通しておく**。
- Claude Code。channels 機能と、channel 経由の実行許可の確認に対応した版が要る（最低バージョンは確かめていない）。`claude.exe` は次の順に探す。
  1. PATH 上の `claude`
  2. VS Code 拡張に同梱の `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<版>-win32-x64\resources\native-binary\claude.exe`（複数あればバージョン番号が最大のもの）
- Claude のサブスクリプション（必要なプランは確かめていない）。
- Slack ワークスペースの管理権限。アプリのインストールに要る。

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

1. **Create New App** → **From an app manifest** でワークスペースを選び、[slack-app-manifest.yaml](slack-app-manifest.yaml) の中身を貼り付けて作る。
   DM とチャンネルに対応し、Socket Mode が有効で、必要最小限のスコープを持つアプリになる。
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** で、スコープ `connections:write` のトークンを発行する。
   この `xapp-` で始まるトークンが **`SLACK_APP_TOKEN`** になる。
3. **OAuth & Permissions** → **Install to Workspace** でインストールする。
   発行される `xoxb-` で始まるトークンが **`SLACK_BOT_TOKEN`** になる。
   **Scopes** に次の7つがあるか確かめる。添付を保存するなら `files:read` も足して8つにする。既存のアプリにスコープを足したら、**Reinstall to Workspace** で入れ直す。

   | スコープ | 用途 |
   |---|---|
   | `chat:write` | 返信と実行許可のメッセージの投稿 |
   | `im:history` | DM（`message.im`）の受信 |
   | `im:write` | 許可ユーザーとの DM を開く（`conversations.open`） |
   | `channels:history` | 公開チャンネル（`message.channels`）の受信 |
   | `groups:history` | 非公開チャンネル（`message.groups`）の受信 |
   | `reactions:write` | 受信と判定のリアクション |
   | `users:read` | `npm run check` で表示名を確かめる |
   | `files:read` | `download_file` で添付を保存する（`.env` に `DOWNLOAD_DIR` を書くときだけ） |

4. Slack で自分のプロフィールを開き、**その他** → **メンバーIDをコピー** で自分のユーザー ID（`U` で始まる）を控える。

### 2. `.env` と `access.json` を作る

トークンと許可リストは、**状態ディレクトリ**（既定は `%USERPROFILE%\.claude\channels\slack`。ブリッジの設定・ログ・ロックを置く場所）に置く。
次の2つのファイルをメモ帳で作り、**BOM なしの UTF-8**（メモ帳の「UTF-8」）で保存する。BOM 付きでも読めるが、勧めない。
場所を変えたいときは [環境変数](docs/reference.md#環境変数) を参照。

`.env`（ひな形: [config/env.example](config/env.example)）:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# 任意。書くと download_file ツールが使える（絶対パス）
# DOWNLOAD_DIR=C:\Users\<ユーザー名>\Downloads
```

書式は `KEY=VALUE`。`export ` の接頭辞、`"..."` / `'...'` の引用符、CRLF の改行も使える。`#` で始まる行はコメントになる。
値の後ろにもコメントを書ける。コメントとして無視されるのは、次の部分。

- 引用符なしの値: 空白に続く `#` 以降。`a#b` のように前に空白の無い `#` は、値の一部になる。
- 引用符付きの値: 閉じ引用符より後ろの `#` 以降。

`access.json`（ひな形: [config/access.example.json](config/access.example.json)）:

```json
{
  "teamId": "T00000000",
  "allowFrom": ["U00000000"],
  "channels": ["C00000000"]
}
```

- `teamId`: ワークスペースの ID（`T` で始まる）。次の `npm run check` で確かめられる。
- `allowFrom`: DM を受け付けるユーザー ID（`U` で始まる）。1件以上書き、重複は許さない。ここに無い相手からの DM とボタン操作は無視する。
- `channels`（省略可）: DM のほかに使うチャンネルの ID（`C` で始まる。古い非公開チャンネルは `G`）。重複は許さない。
  ID はチャンネル名を右クリック → **リンクをコピー** で得られる URL の末尾にある。使う前に、そのチャンネルで `/invite @<ボット名>` としてボットを招待しておく。
  チャンネルで Claude に届くのは、ボットへのメンション（`@<ボット名>`）付きの発言と、ボットが関わっているスレッドへの返信だけ。詳しくは [メッセージ](docs/usage.md#メッセージ) を参照。

この2つは Claude に作らせず、手で作る。トークンと許可リストそのものなので、Claude に扱わせるとログや会話履歴に混ざる経路が増える。起動スクリプトも、ファイルがあるかを確かめるだけで中身は読まない。

### 3. 疎通を確かめる

```powershell
npm run check
```

ビルド（`precheck`）のあと、次を表示する。トークンそのものは出さず、`xoxb-***` のように接頭辞だけを出す。

- 状態ディレクトリの場所
- ワークスペース名・`team_id`・ボットのユーザー ID
- `access.json` の `teamId` が実際の `team_id` と違うときの警告
- `allowFrom` に書いた ID の表示名

`access.json` がまだ無いか読めないときは、その旨を表示して先へ進む。`teamId` の突き合わせと表示名の確認だけを省く。

### 4. 起動するプロジェクトを登録する

[config/projects.example.json](config/projects.example.json) を `config\projects.json` にコピーし、Claude Code を起動したいプロジェクトを並べる。`projects.json` は git の管理外。

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
| `scripts\start.cmd` | `projects.json` の一覧から番号で選んで起動する（Enter で先頭、`q` で中止） |
| `scripts\start.cmd my-app` | `projects.json` の name で指定して起動する |
| `scripts\start.cmd C:\path\to\app` | パスで直接指定して起動する |
| `scripts\start.cmd my-app -PermissionMode auto` | 実行許可のモードを変える（[権限の設計](docs/security.md#権限の設計)） |
| `scripts\start.cmd -DryRun` | 起動せずに、実行するコマンドラインだけを表示する。ビルドは省き、`.env` / `access.json` が無くても警告だけ出す |
| `scripts\start.cmd C:\path\to\app -StateDir <dir> -SettingsFile <file>` | 別の Slack アプリと設定で、もう1つのセッションを起動する（[セッションを並べる](docs/usage.md#セッションを並べる)） |

- 起動すると experimental channels の警告ダイアログが出る。起動スクリプトが画面を見張って、**「1」（I am using this for local development）** を自動で選ぶ。90秒たってもダイアログが残っていたら、手で「1」を選ぶ。
- `dist` が無いときだけ自動でビルドする。`git pull` で更新したら、古い `dist` のまま起動しないよう、**`npm run build` を手で実行する**。
- 起動したら、Slack でボットに DM を送るか、`channels` に書いたチャンネルでボットにメンションして話しかける。

## 使い方の要点

詳しい挙動は [docs/usage.md](docs/usage.md) にまとめてある。

- ボットに話しかけるとメッセージが手元のセッションに届き、届いた印に :eyes: が付く。Claude は元のメッセージのスレッドに返信する。
- Slack 側の会話はすべて1つのセッションの同じ文脈を共有する。
- 添付ファイルの中身は渡さない。Claude に届くのはファイル名・種類・サイズの要約とファイル ID だけで、中身が要るときは Claude が `download_file` で取りに行く。
- 許可リストに無い操作を Claude が実行しようとすると、スレッドに確認のメッセージが届く。**Allow / Deny** のボタンか `yes xxxxx` / `no xxxxx` の返信で答える。30分答えなければ自動で拒否する。
- 確認のメッセージの **♾ 今後も許可** を押すと、同じ種類の操作を次回の起動から確認なしで通せる。
- 5分たっても Claude から何も返ってこないと、スレッドに警告が出る。
- `/` で始まる文は Slack のコマンドとして扱われ、Claude Code には届かない。代わりに `!` で始まる次のコマンドを使う。これらは Claude に渡さず、ブリッジ自身が処理する。

| コマンド | 動作 |
|---|---|
| `!help` | コマンドの一覧を返す |
| `!status` | ブリッジの状態（接続、返事待ち、回答待ちの実行許可、直近の hook）を返す |
| `!screen` | ターミナルの画面を見る。選択画面なら、ボタンで選択肢を選べる |
| `!rules` | 「今後も許可」で足したルールを一覧し、ボタンで消せる |
| `!compact` | `/compact` を送り、会話を要約して縮める |
| `!clear` | `/clear` を送り、会話を捨てて新しい会話にする |
| `!restart` | `/exit` を送り、同じ会話のまま再起動する。警告ダイアログには自動で答える |
| `!restart force` | Claude Code を強制終了してから再起動する（応答しないとき用） |
| `!lock` | 「このセッション中は全部許可」を解除する（有効にしたボットだけ） |

Claude Code 側の出来事（使用量の上限、ターミナル側の入力待ち、セッションの開始と終了など）は、hook を通して Slack に通知する。

## セキュリティの要点

Slack から手元の PC を操作する以上、何をどこまで許すかが一番の注意点になる。詳しくは [docs/security.md](docs/security.md) を参照。

- 送信者は Slack のユーザー ID（`allowFrom`）とワークスペース ID（`teamId`）で判定する。表示名やメールアドレスは使わない。
- Slack のセッションは、ユーザー設定（`~/.claude/settings.json`）を読まない設定で起動する。普段使いのために入れた緩い許可を、Slack からの指示に効かせないため。権限は [config/channel-settings.json](config/channel-settings.json) で絞る。
- 主に次のリスクが残る（すべては [残るリスク](docs/security.md#残るリスク) にある）。
  - 許可ユーザーの Slack アカウントが乗っ取られると、手元の Claude をそのまま操作される。
  - 確認で許可した操作は、その内容どおりに実行される。確認の中身はよく読む。
  - Slack のメッセージ・リポジトリの中身・Web ページに仕込まれた指示（プロンプトインジェクション）を、Claude が実行しようとすることがある。最後の防御は確認での拒否になる。
- トークンが漏れたら、まず App-Level Token を Revoke する。手順は [トークンが漏れたとき](docs/security.md#トークンが漏れたとき) にある。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/usage.md](docs/usage.md) | 各機能が Slack でどう動くかを知りたいとき（実行許可、今後も許可、画面の確認、再起動、hook の通知、セッションを並べる など） |
| [docs/security.md](docs/security.md) | Slack から実行できる範囲を変える前と、トークンが漏れたとき |
| [docs/reference.md](docs/reference.md) | 期限や上限などの値、設定ファイルと環境変数を調べるとき。動かないときのトラブルシューティング |
| [docs/development.md](docs/development.md) | このリポジトリに手を入れるとき（コマンド、テスト、ファイル構成） |

ドキュメントで解決しないときは、GitHub の Issues に書いてほしい。

## ライセンス

[MIT](LICENSE)
