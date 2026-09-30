# claude-slack-channel

Slack の DM（と、指定した公開・非公開チャンネル）を、手元で動いている Claude Code のセッションへ中継する MCP channel サーバー。
Slack から話しかけると手元の `claude.exe` が応答し、返信・リアクション・実行許可の確認まで
Slack 側だけで完結する。

## 概要

```
Slack (DM / 許可したチャンネル)
   │  Socket Mode（サーバー側から WebSocket を張るので、ポート開放やトンネルは不要）
   ▼
claude-slack-channel（dist/src/main.js、node で動く）
   │  MCP（標準入出力、experimental の channels 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- 許可したユーザーからの DM（と、`access.json` の `channels` に書いたチャンネルでの発言）が、Claude のセッションへそのまま届く。
- Claude は `reply` / `react` / `edit_message` の3ツールで Slack に返信する。
- ファイル書き込みなどの実行許可は、Slack のボタンか `yes xxxxx` / `no xxxxx` の返信で答えられる。
- 対象は Windows。起動スクリプトは PowerShell で書かれている。

## 必要なもの

- Windows と Windows Terminal（VS Code の統合ターミナルは動作確認していないので対象外）
- Node.js 22.12 以上。`node` と `npm` に **PATH が通っていること**（Claude Code は `node` コマンドでこのサーバーを起動する）
- Claude Code（channels 機能と、channel 経由の実行許可確認に対応した版。必要な最低バージョンはこのリポジトリでは未確認）。`claude.exe` は次の順に探す
  1. PATH 上の `claude`
  2. VS Code 拡張の同梱版 `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<版>-win32-x64\resources\native-binary\claude.exe`（複数あればバージョン番号が最大のもの）
- Claude のサブスクリプション（必要なプランは未確認）
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
   DM とチャンネル用・Socket Mode 有効・最小限のスコープを持つアプリができる。
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** で、
   スコープ `connections:write` のトークンを発行する。
   → `xapp-` で始まるこのトークンが **`SLACK_APP_TOKEN`**。
3. **OAuth & Permissions** → **Install to Workspace** でインストールする。
   → 発行される `xoxb-` で始まるトークンが **`SLACK_BOT_TOKEN`**。
   **Scopes** に次の7つがあるか確認する。既存のアプリにスコープを足したときは **Reinstall to Workspace** で入れ直す。

   | スコープ | 用途 |
   |---|---|
   | `chat:write` | 返信と実行許可メッセージの投稿 |
   | `im:history` | DM（`message.im`）の受信 |
   | `im:write` | 許可ユーザーとの DM を開く（`conversations.open`） |
   | `channels:history` | 公開チャンネル（`message.channels`）の受信 |
   | `groups:history` | 非公開チャンネル（`message.groups`）の受信 |
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

`KEY=VALUE` 形式（`export ` 接頭辞、`"..."` / `'...'` の引用符、CRLF も可）。`#` で始まる行はコメント。
値の後ろのコメントは、引用符なしなら空白に続く `#` 以降、引用符付きなら閉じ引用符の後ろの `#` 以降が無視される
（`a#b` のように空白の無い `#` は値の一部）。

`access.json`（ひな形: [config/access.example.json](config/access.example.json)）:

```json
{
  "teamId": "T00000000",
  "allowFrom": ["U00000000"],
  "channels": ["C00000000"]
}
```

- `teamId`: ワークスペースの ID（`T` で始まる）。次の `npm run check` で確認できる。
- `allowFrom`: DM を受け付けるユーザー ID（`U` で始まる）。1件以上、重複不可。
  ここに無い相手からの DM とボタン操作は無視される。
- `channels`（省略可）: DM に加えて使うチャンネルの ID（`C` で始まる。古い非公開チャンネルは `G`）。重複不可。
  チャンネル名を右クリック → **リンクをコピー** の末尾が ID。使う前にそのチャンネルで `/invite @<ボット名>` してボットを招待する。
  チャンネルでも `allowFrom` に無いメンバーの発言とボタン操作は無視する。
  チャンネルで Claude に届くのは、**ボットへのメンション（`@<ボット名>`）を付けた発言** と、**ボットが関わっているスレッドへの返信**
  （メンションで話しかけたスレッド・ボットが投稿したスレッド。メンション無しでよい）だけ。それ以外の雑談には反応しない。
  メンションは本文から取り除いて Claude に渡す。関わっているスレッドはブリッジが起動している間だけ覚えている（起動し直したら、もう一度メンションする）。

> **Claude に作らせない理由**: この2ファイルはトークンと許可リストそのもの。Claude に扱わせると、
> ログや会話履歴に混入する経路が増える。手で作ること。起動スクリプトも存在を確認するだけで中身は読まない。

### 3. 疎通を確認する

```powershell
npm run check
```

`precheck` でビルドしてから、次を表示する。トークンそのものは出ない（`xoxb-***` のように接頭辞だけ）。

- 状態ディレクトリの場所
- ワークスペース名・`team_id`・ボットの user ID
- `access.json` の `teamId` が実際の `team_id` と食い違っていれば警告
- `allowFrom` に書いた ID の表示名

`access.json` がまだ無い・読めない場合はその旨を表示して続行する（`teamId` の突き合わせと表示名の確認だけ省く）。

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
| `scripts\start.cmd -DryRun` | 起動せず、実行されるコマンドラインだけ表示（ビルドは省き、`.env` / `access.json` が無くても警告だけ出す） |

- 起動時に experimental channels の警告ダイアログが出たら、**「1」（I am using this for local development）** を選ぶ（起動スクリプトもその旨を表示する。ダイアログ自体は Claude Code 側の挙動で未確認）。
- `dist` が無いときだけ自動でビルドする。**`git pull` で更新したあとは `npm run build` を手で実行する**（古い `dist` のまま起動してしまうため）。
- 起動後は Slack でこのボットに DM を送るか、`channels` に書いたチャンネルでボットにメンションして話しかければよい。

## 使い方

### メッセージ

- ボットに DM を送る（または許可チャンネルでメンションする・関わっているスレッドに返信する）と手元のセッションに届き、届いた印に :eyes: が付く。Claude には元のメッセージのスレッドへ返信するよう指示している（MCP の instructions）。
- 受け付けるのは **ボットとの DM と、`channels` に書いたチャンネルだけ**。それ以外のチャンネルやグループ DM、編集・削除などのイベントは無視する。
- **添付ファイルは中身を渡さない**。ファイル名・種類・サイズの要約だけが Claude に届く（本文が無ければ `(attachment)`、複数なら `(N attachments)`）。
- 受信したメッセージとボタン操作は、届いた順に1件ずつ処理する（前の処理が終わるまで次を始めない）。
- 長い返信は自動で複数のメッセージに分割される。途中で送信に失敗した場合、Claude には何件目まで送れたか（`sent=N`）付きのエラーが返る。
- 投稿したリンクのプレビュー（unfurl）は展開しない。
- Claude に渡したメッセージから5分たっても、Claude が何も返さない（`reply` / `react` / `edit_message` も実行許可の確認も無い）ときは、
  そのスレッドに「⚠️ Claude から 5 分応答が無い」と投稿する。ターミナル側の選択画面（Slack には中継されない）、使用量の上限、
  セッションの停止などで止まっているのに、Slack からは気付けないのを防ぐため。見張るのは最後に渡したメッセージ1件だけで、
  待ち時間は `SLACK_CHANNEL_REPLY_TIMEOUT_MIN` で変えられる。警告には「🖥 画面を確認」ボタンが付く（[ターミナル画面の確認と解除](#ターミナル画面の確認と解除)）。
- セッションは1つだけで、Slack 側の会話はすべて同じ文脈を共有する。
- Slack の DM は本文として Claude に届くだけで、`/clear` などの Claude Code のコマンドを Slack から実行する機能は無い（ローカルのターミナルで操作する）。

### 実行許可

許可リストに無い操作を Claude が行おうとすると、最後に Claude へ中継したメッセージのスレッド（DM でもチャンネルでも）に、
ボタン付きのメッセージが返信される（スレッド外のメッセージならそのメッセージを起点にスレッドを作る）。
起動後にまだ中継したメッセージが無いときや、そのスレッドへの返信に失敗したときは、許可ユーザー全員の DM に届く
（その DM で最後に中継したメッセージのスレッドに出る。まだ中継したメッセージが無い DM ではトップレベルに出る）。

- **Allow / Deny** ボタンで答えるか、`yes xxxxx` / `no xxxxx` と返信する。
  `xxxxx` はメッセージに表示された5文字の ID。`y` / `n` でもよく、大文字小文字は問わない。
- 答えると、配信したメッセージ（DM に配ったときは全員分）が `Allowed` / `Denied` と回答者の表示に書き換わる。
  ID は plain_text で表示し、回答者は Slack のユーザー ID の形のときだけメンション（`<@U...>`）で、それ以外は plain_text で表示する。
  テキストで答えた場合は、その返信に :white_check_mark: / :x: が付く。
- 保留中でない ID への `yes xxxxx` は回答として扱わず、通常のメッセージとして Claude に届く。
- 有効期限は **30分**。期限までに答えが無ければ、Claude に自動で deny を返し、メッセージを「期限切れのため自動で拒否した」表示に書き換える。
  期限切れのボタンを押しても Claude には送らず、押したメッセージが期限切れ表示に変わるだけ。
- 次の場合も、Slack からは答えられないので自動で deny を返す。
  - スレッドへの返信も、どの DM への配信もできなかった（全員分の投稿に失敗した・DM チャンネルが無い）。ログに `permission_request をどの DM にも配信できなかった` が出る。
  - ブリッジの終了時に保留中だった。メッセージは「ブリッジ終了のため自動で拒否した」表示に書き換える（書き換えは切断前にできた分だけ）。
- 入力内容（コマンドや差分）は合計約 2800 文字まで表示する。超えるときは先頭（約 2200 文字）と末尾（約 600 文字）を残し、
  間に `…（途中 N 文字省略）…` を入れ、その下に「See more で全文を確認すること」という警告行を出す（省略しないときは警告行も出ない）。
- ツール名・説明・入力内容のどれかを省略したときだけ **See more** ボタンが付き、押すと入力内容の全文をコードブロックでスレッドに送る
  （長ければ複数メッセージに分割。期限切れならその旨だけ送る）。
- 文字の向きを変える制御文字（U+202A〜202E、U+2066〜2069）、ゼロ幅文字（U+200B〜200D）、BOM（U+FEFF）は、
  見えない形で紛れ込まないよう `\u{202E}` のような表記に置き換えて表示する（See more の全文でも同じ）。
- Claude から届いた確認の ID が想定外の形（`l` を除く英小文字5文字でない）のときは、Slack には出さず、ログに警告を残して自動で deny を返す。
- ターミナル側にも同じ確認が出ていて、どちらで答えてもよい（Claude Code 側の挙動で未確認）。

### Slack セッションで使える MCP サーバー

> **注意**: Slack セッションは `--strict-mcp-config` で起動するため、普段の Claude Code で使っている MCP サーバー
> （ユーザー設定 `~/.claude.json` や作業フォルダーの `.mcp.json` に登録したもの）は **読み込まれない**。
> エラーや確認画面は出ず、Claude からは「そのツールにつながっていない」ように見えるだけなので気付きにくい。

- Slack セッションでも使うサーバーは `config\extra-mcp.json` に `.mcp.json` と同じ形で書く（ひな形: [config/extra-mcp.example.json](config/extra-mcp.example.json)、git 管理外）。
  起動時に `追加の MCP サーバー: ...` と表示される。
- `.mcp.json` をそのまま読ませないのは、新しいサーバーを見つけたときの承認の確認画面がターミナルに出て、
  隠しウィンドウで動かしていると Slack から気付けないまま止まるため。`extra-mcp.json` に書いたサーバーには確認画面は出ない。
- 追加したサーバーのツールは、**確認なしで実行される**（起動スクリプトが `mcp__<サーバー名>` を allow に足す）。
  MCP のツールは1操作ごとに確認が出て、ブラウザ操作などが確認のたびに止まるため。
  使う人が承知して入れたサーバーとして扱うので、ツールの中身（任意のスクリプト実行ができるものなど）を理解したうえで登録すること。
  個別のツールを確認させたいときは `channel-settings.json` の `ask` に書く（allow より優先される）。
- OAuth の認証が要るサーバー（HTTP 型など）は、一度ターミナルで `/mcp` から認証しておく。Slack からは認証できない。
- claude.ai のコネクター（Gmail など）は起動スクリプトが無効にしている（`ENABLE_CLAUDEAI_MCP_SERVERS=false`）。

### 許可リストへの追加（♾ 今後も許可）

実行許可のメッセージの **♾ 今後も許可** を押すと、今回の操作を許可したうえで、同じ種類の操作を許可リストに足すかをスレッドで確認する。
**追加する** を押すと、状態ディレクトリの `allow-extra.json` に書き込み、**次に起動し直したときから** 確認なしで実行される
（起動スクリプトが `channel-settings.json` の allow に足して渡す。起動中のセッションには効かない）。

- ルールは確認の中身から作る（自由な入力は受け付けない）。
  - Bash / PowerShell: コマンドの先頭の語をプレフィックスにする（`git` / `npm` などはサブコマンドまで。例: `Bash(git status:*)`）
  - それ以外のツール: ツール名だけ（例: `WebFetch`）
- 次のものは作らず、理由をスレッドで知らせる。
  - 複数のコマンドをつないだもの・リダイレクトを含むもの
  - 削除・移動・ネットワーク・プロセス起動・任意のコード実行（`node` / `python` / `npx` / `uvx` など）・権限やシステムの変更に当たるコマンド、
    エージェントの CLI（`claude` / `codex` / `gemini` など。別のエージェントに確認なしで操作させられるため）、
    `git push` / `reset` / `clean` などの破壊的な操作、スクリプトを実行する操作（`npm test` / `npm run` / `dotnet run` など。
    ファイル編集が確認なしだと、スクリプトを書き換えてから実行できるため）、読み取り系（`Get` / `Test` / `Select` など）以外の PowerShell コマンドレット
  - ファイル編集（Write / Edit など。許可モードで扱う）
- **deny に当たるものは追加しない**。`channel-settings.json` と作業フォルダーの `.claude/settings.json` / `settings.local.json` の deny と
  範囲が重なる（どちらかがもう一方を含む）ときは、「deny に当たるので追加しない」と当たった deny をスレッドで知らせる。
  確認の後、追加する直前にも deny を読み直して照合する。
- `!rules` と送ると、追加分のルールを一覧し、🗑 ボタンで消せる（次に起動し直したときから反映）。
- 追加・削除はログ（`許可リストに追加` / `許可リストから削除`）に残る。

### ターミナル画面の確認と解除

Claude Code がターミナル側の選択画面（Slack に中継されない案内など）で止まったときに、Slack から画面を確認して選択肢を選べる。

- `!screen` と送る（Claude には渡さない）か、無応答の警告の **🖥 画面を確認** を押すと、ブリッジがターミナルの画面を読む。
  - 選択画面（`>` / `❯` の付いた選択肢）なら、選択肢をボタンで出す。押すと、その選択肢までカーソルを動かして Enter を送る。
  - 選択画面でなければ、画面の末尾をコードブロックで送る。トークンらしき文字列は伏せる。
- 送れるのは **選択肢を選ぶキー操作（↑ / ↓ / Enter）だけ**。自由な文字入力はできない。
- ボタンを押したとき、画面を読み直して、見せたときと同じ選択画面のままのときだけ送る（変わっていたら何も送らない）。ボタンの有効期限は5分。
- 画面の読み取りとキー送信は `scripts\console.ps1` を子プロセスで実行して行う（ブリッジは Claude Code と同じコンソールを使っている）。
  Windows 以外やスクリプトが見つからない場合は使えない。

## 権限の設計

起動スクリプトは `claude.exe` を次のフラグで起動する。

> この節に書いたフラグ・設定・モードの効果（評価順や制限を含む）は Claude Code 側の仕様に基づく説明で、
> このリポジトリのコードやテストでは確認していない（未確認）。コードで確かめられるのは、
> 起動スクリプトがこれらのフラグを渡すことと、`channel-settings.json` の中身まで。

| フラグ | 目的 |
|---|---|
| `--mcp-config %TEMP%\claude-slack-channel\mcp.json` | `slackbridge` サーバーを読み込む。clone 先の絶対パスを含むので、起動のたびに生成する |
| `--strict-mcp-config` | `--mcp-config` 以外の MCP サーバー（ユーザー設定やプロジェクトの `.mcp.json`）を読み込まない。Slack セッションでも使うサーバーは `config\extra-mcp.json` に書く（下記） |
| `--no-chrome` | Claude in Chrome 連携を無効にする。有効だと、ブラウザ操作が必要になったときに「Claude wants to use your browser」の選択画面がターミナルに出て、Slack には中継されないまま止まる |
| `--setting-sources project,local` | ユーザー設定（`~/.claude/settings.json`）を読まない。便利さのために入れた緩い許可（`Bash(*)` など）に乗って、Slack からの指示が無確認で実行されるのを防ぐ |
| `--settings config\channel-settings.json` | channel セッション専用の設定を重ねる。managed（組織の管理設定）を除き、どの設定よりも上位。`extra-mcp.json` のサーバーや「今後も許可」で足したルールがあるときは、それを allow に足したもの（`%TEMP%\claude-slack-channel\channel-settings.merged.json`）を渡す |
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
  git コマンドは `git status` も含めて allow に入れていない（`git diff --no-index` などでプロジェクト外のファイルを読めるため）。
- **deny**:
  - 読み取りの禁止（`Read(...)`）:
    - Claude Code の設定と状態: `~/.claude/**`（状態ディレクトリ `~/.claude/channels/**` を含む）、`~/.claude.json`
    - 認証情報: `~/.ssh/**`、`~/.git-credentials`、`~/.aws/**`、`~/.config/gh/**`、`~/.npmrc`、`~/.docker/**`
    - 秘密ファイル: どこにあっても `.env*`、`*.pem`、`*.key`
  - 編集の禁止（`Edit(...)`）: 状態ディレクトリ `~/.claude/channels/**`、プロジェクトの `./.claude/**`
  - 破壊的な git 操作: `git push --force` / `-f`、`git reset --hard`（Bash・PowerShell の両方）
- **`defaultMode`**: `default`（起動スクリプトの `--permission-mode` でも指定する）
- **`disableBypassPermissionsMode`**: `bypassPermissions` モードへの切り替えを禁止
- **`disableClaudeAiConnectors`**: claude.ai 側の connector を読み込まない
- **`language`**: `japanese`

deny は allow より必ず優先される（評価順は deny → ask → allow）。

> **状態ディレクトリを移したとき**: 既定の場所は `Read(~/.claude/channels/**)` / `Edit(~/.claude/channels/**)` で守られているが、
> `SLACK_CHANNEL_STATE_DIR` で別の場所にした場合は、そのパスの `Read(...)` / `Edit(...)` を deny に自分で追加する。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような
> 間接呼び出しまでは塞がない（Claude Code のパターンマッチの既知の制限）。`sh -c` 自体は確認待ちになるが、
> 確認で許可すれば実行される。

## セキュリティ

- 送信者は Slack のユーザー ID（`allowFrom`）とワークスペース ID（`teamId`、送信者の所属ワークスペースを含む）で判定する。表示名やメールアドレスでは判定しない。
  ボタン操作はさらに、押されたのが許可ユーザーとの DM か `channels` のチャンネルであることも確認する。
- トークンは状態ディレクトリの `.env` だけに置く。環境変数からは読まず、MCP 設定ファイルにも書かない。
- ログに出るトークン（`xox` + 英小文字1字 + `-` で始まるもの全般、`xapp-`、`Bearer ...`）は伏せ字にする。
- 送信するテキストの `@channel` / `@here` / `@everyone` / ユーザーグループへのメンションは無効化する。
- Slack から届くメッセージは信頼できない入力として扱い、上記の権限設計で実行できる範囲を絞っている。

### 複数ユーザーで使うとき

`allowFrom` の全員が同じセッションを共有する。実行許可のメッセージは最後に話しかけたスレッドに届く
（DM 全体に配ったときは全員の DM に届く）。**誰か1人が答えればそれで決まる**（他の人のメッセージも結果表示に書き換わる）。
チャンネルでは、`allowFrom` に無いメンバーにも実行しようとしているコマンドの内容が見える点に注意する。
`!screen` の画面の内容や選択肢のボタンも同じスレッドに出る。

### 残るリスク

- 許可ユーザーの Slack アカウントが乗っ取られると、そのまま手元の Claude を操作される。
- 確認で許可した操作は、その内容どおりに実行される。確認内容をよく読むこと。
- 「今後も許可」で足したルールは、以後そのプレフィックスのコマンドを確認なしで実行させる（例: `Bash(git status:*)` は `git status` に続く引数を問わない）。
  危険なコマンドは除外しているが、不要になったら `!rules` から消すこと。
- `!screen` の選択肢ボタンで、ターミナルの選択画面に Slack から答えられる（信頼の確認などの画面も含む）。
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
| `access.json` | 状態ディレクトリ | `teamId`（`T...`）、`allowFrom`（`U...` の配列）、`channels`（`C...` / `G...` の配列、省略可）。これ以外のキーはエラー |
| `extra-mcp.json` | `config\`（git 管理外） | Slack セッションで一緒に使う MCP サーバー（`.mcp.json` と同じ `mcpServers` の形。ひな形: `extra-mcp.example.json`）。登録したサーバーのツールは確認なしで実行される |
| `allow-extra.json` | 状態ディレクトリ | Slack の「今後も許可」で足したルール（`{"allow": [...]}`）。ブリッジが書き、起動スクリプトが allow に足す |
| `projects.json` | `config\` | `projects`: `{ name, path }` の配列。起動時の選択肢 |
| `channel-settings.json` | `config\` | channel セッション専用の Claude Code 設定 |
| `logs\bridge.log` | 状態ディレクトリ | ログ（下記） |
| `instance.lock` | 状態ディレクトリ | 多重起動防止のロック（自動で作られ、終了時に消える） |
| `mcp.json` | `%TEMP%\claude-slack-channel\` | 起動スクリプトが毎回生成する MCP 設定 |

### 環境変数

| 変数 | 用途 |
|---|---|
| `SLACK_CHANNEL_STATE_DIR` | 状態ディレクトリを変える（既定 `%USERPROFILE%\.claude\channels\slack`）。**絶対パスで指定する**。相対パスはプロセスごとのカレントディレクトリ基準で絶対パスに解決されるため、参照先がずれうる（サーバーは起動されたときの作業ディレクトリ基準、`start.ps1` の存在確認は実行したシェルのカレントディレクトリ基準）。変えたら deny も書き換える |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | 起動スクリプトが `false` を設定する（手で設定する必要はない） |
| `SLACK_CHANNEL_REPLY_TIMEOUT_MIN` | 無応答の警告を出すまでの分数（既定 5、小数可）。`0` で無効 |

トークンは環境変数からは読まない。

### ログ

- 出力先は `logs\bridge.log` と stderr（stderr が Claude Code の `/mcp` から見えるかは未確認）。
- レベルは info 固定（変更する設定は無い）。
- 5MB を超えると `bridge.log.1` に退避する（1世代だけ保持し、古い `.1` は上書き）。

### 固定値

| 項目 | 値 |
|---|---|
| 実行許可の有効期限 | 30分 |
| ロックのハートビート / 失効 | 10秒ごとに更新 / 30秒更新が無ければ失効。ハートビートが現在時刻より5秒を超えて未来でも失効扱い（プロセスが生きているかは見ない） |
| 再接続の待ち時間 | 1秒から倍々で最大60秒 |

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 何が起きたか知りたい | `logs\bridge.log` を見る（トークンはマスク済み） |
| 接続状態を知りたい | セッション内で `/mcp` を実行し、`slackbridge` の状態を見る。`socket: connected` / `disconnected` はログにも出る |
| 起動スクリプトが `claude.exe が見つからない` | PATH に `claude` を通すか、VS Code の Claude Code 拡張を入れる |
| `/mcp` で `slackbridge` が failed | `node` に PATH が通っているか、`npm run build` 済みかを確認。理由は stderr とログに出る |
| `.env が見つからない` / `access.json の検証に失敗` | 状態ディレクトリの場所とファイル名（`.env.txt` になっていないか）、JSON の形式、ID の先頭文字（`T` / `U`）を確認 |
| `auth.test の team_id が access.json と一致しない` | `npm run check` で `team_id` を確認して `teamId` を直す |
| `許可ユーザーの DM チャンネルを 1 件も開けなかった` | `allowFrom` の ID と `im:write` スコープを確認 |
| `invalid_auth` | `SLACK_BOT_TOKEN` が無効。`npm run check` で確認し、トークンを取り直す |
| `missing_scope` | **OAuth & Permissions** で5スコープが揃っているか確認し、足りなければ再インストール |
| ツールが「別のインスタンスが動いている」エラーを返す | 別のセッションが Slack ブリッジを使用中。2つ目以降は Slack に接続しない縮退モードで動き、ツールはすべてエラー、実行許可は Slack に出ない（ターミナル側で答える想定。Claude Code 側の挙動は未確認）。先のセッションを終了してから起動し直す |
| 直前のセッションを落とした直後に起動したら縮退モードになった | 前のプロセスのロックが残っている。30秒待ってから起動し直す |
| DM を送っても :eyes: が付かない | `allowFrom` に自分の ID があるか、DM の相手がこのボットかを確認。ログの `受信を破棄 reason=...` は debug なので出ない。起動時に DM を開けなかったユーザーは、そのユーザーから DM が届いた時点で送信先に加わる |
| チャンネルで話しかけても :eyes: が付かない | ボットにメンションしたか（スレッドの続きは、ボットが関わっているスレッドならメンション不要。起動し直した後はもう一度メンションする）、`access.json` の `channels` にそのチャンネルの ID があるか、ボットを招待したか、Slack アプリの bot events に `message.channels`（公開）/ `message.groups`（非公開）があり再インストール済みかを確認 |
| 実行許可のメッセージが Slack に来ない | 縮退モードでないか確認。ログに `permission_request の request_id が不正なので deny を返す` があれば、Slack に出さず自動で deny している |
| 実行許可が勝手に拒否された | 30分答えが無かった（期限切れ）、どの DM にも投稿できなかった（ログに `permission_request をどの DM にも配信できなかった`）、またはブリッジが終了した、のいずれかで自動 deny している。投稿失敗なら直前の `DM への送信に失敗` の理由（スコープ・DM チャンネル）を確認する |
| スリープ復帰後に反応しない | 自動で再接続する（最大60秒間隔で繰り返す）。しばらく経っても駄目ならログを確認して起動し直す |
| 更新したのに挙動が変わらない | `npm run build` を実行してから起動し直す |

## 開発

```powershell
npm test             # vitest run
npm run typecheck    # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json（本体とテストの両方）
npm run build        # tsc -p tsconfig.json で dist へ出力
npm run check        # precheck（npm run build）のあと dist/scripts/check.js を実行
```

### ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。ロガー・ロック・設定の読み込み、終了処理 |
| `src/app.ts` | Slack・MCP・permission リレーの配線（通常モードと縮退モード）、MCP ツールと受信イベントの処理 |
| `src/slack.ts` | Slack の Socket Mode 受信と Web API 送信 |
| `src/mcp.ts` | MCP channel サーバー（`reply` / `react` / `edit_message` ツール） |
| `src/permission-relay.ts` | 実行許可リレーの状態管理（配信・回答・結果表示への書き換え・自動 deny） |
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
| `test/*.test.ts` | vitest のテスト |
| `test/helpers/fake-slack.ts` | Slack の Web API / Socket Mode の差し替え（`slack.test.ts` / `app.test.ts` で共用） |
| `test/fixtures/chunk-legacy.ts` | 分割前の `chunkText` 実装。`chunk-legacy.test.ts` で出力の一致を確かめる |
| `tsconfig.json` | 本体（`src` / `scripts`）のビルド設定 |
| `tsconfig.test.json` | テストを含めた型検査用の設定（出力なし） |
| `vitest.config.ts` | vitest の設定 |

## ライセンス

[MIT](LICENSE)
