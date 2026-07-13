# claude-slack-channel

Slack の DM（と、指定した公開・非公開チャンネル）を、手元で動いている Claude Code のセッションへ中継する MCP channel サーバーよ。
Slack から話しかければ手元の `claude.exe` が応えるし、返信もリアクションも実行許可の確認も、Slack 側だけで片付くわ。

……案内役は FOX 小隊のポイントマン、高倉クルミ（FOX3）が務めるわ。先頭は私が行くから、ちゃんと付いてきなさいよね。

## 概要

まずは全体の配置図。どこからどこへ話が流れるか、頭に入れておいて。

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
- Claude は `reply` / `react` / `edit_message` の3ツールで Slack に返信する（`.env` に `DOWNLOAD_DIR` があれば、添付を保存する `download_file` も使える）。
- ファイル書き込みなどの実行許可は、Slack のボタンか `yes xxxxx` / `no xxxxx` の返信で答えられる。
- 対象は Windows。起動スクリプトは PowerShell で書いてあるわ。

## 必要なもの

装備の確認よ。足りないまま出撃しないでよね。

- Windows と Windows Terminal（VS Code の統合ターミナルは動作確認していないので対象外）
- Node.js 22.12 以上。`node` と `npm` に **PATH が通っていること**（Claude Code は `node` コマンドでこのサーバーを起動する）
- Claude Code（channels 機能と、channel 経由の実行許可確認に対応した版。必要な最低バージョンはこのリポジトリでは未確認）。`claude.exe` は次の順に探す
  1. PATH 上の `claude`
  2. VS Code 拡張の同梱版 `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-<版>-win32-x64\resources\native-binary\claude.exe`（複数あればバージョン番号が最大のもの）
- Claude のサブスクリプション（必要なプランは未確認）
- Slack ワークスペースの管理権限（アプリのインストールに必要）

## セットアップ

順番どおりにやれば迷わないわ。飛ばすと後で踏むから、念のため全部やること。

### 0. clone してビルドする

```powershell
git clone https://github.com/elys0912/claude-slack-channel.git
cd claude-slack-channel
npm install
npm run build
```

### 1. Slack アプリを作る

[api.slack.com/apps](https://api.slack.com/apps) で次の順に操作して。

1. **Create New App** → **From an app manifest** → ワークスペースを選び、
   [slack-app-manifest.yaml](slack-app-manifest.yaml) の中身を貼り付けて作成する。
   DM とチャンネル用・Socket Mode 有効・最小限のスコープを持つアプリができるわ。
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** で、
   スコープ `connections:write` のトークンを発行する。
   → `xapp-` で始まるこのトークンが **`SLACK_APP_TOKEN`**。
3. **OAuth & Permissions** → **Install to Workspace** でインストールする。
   → 発行される `xoxb-` で始まるトークンが **`SLACK_BOT_TOKEN`**。
   **Scopes** に次の7つ（添付を保存するなら `files:read` も足して8つ）があるか確認する。既存のアプリにスコープを足したときは **Reinstall to Workspace** で入れ直すこと。

   | スコープ | 用途 |
   |---|---|
   | `chat:write` | 返信と実行許可メッセージの投稿 |
   | `im:history` | DM（`message.im`）の受信 |
   | `im:write` | 許可ユーザーとの DM を開く（`conversations.open`） |
   | `channels:history` | 公開チャンネル（`message.channels`）の受信 |
   | `groups:history` | 非公開チャンネル（`message.groups`）の受信 |
   | `reactions:write` | 受信・判定のリアクション |
   | `users:read` | `npm run check` での表示名の確認 |
   | `files:read` | `download_file` での添付の保存（`.env` に `DOWNLOAD_DIR` を書くときだけ必要） |

4. Slack で自分のプロフィールを開き、**その他** → **メンバーIDをコピー** で自分の ID
   （`U` で始まる）を控えておいて。

### 2. 状態ファイル（`.env` と `access.json`）を作る

状態ディレクトリ `%USERPROFILE%\.claude\channels\slack` に、メモ帳で次の2ファイルを作る。
文字コードは **BOM なしの UTF-8**（メモ帳の「UTF-8」）で保存すること（BOM 付きでも読めるけど推奨しない）。
場所を変えるときは [環境変数](#環境変数) を見て。

`.env`（ひな形: [config/env.example](config/env.example)）:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
# 任意。書くと download_file ツールが使える（絶対パス）
# DOWNLOAD_DIR=C:\Users\<ユーザー名>\Downloads
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
  ここに無い相手からの DM とボタン操作は無視する。
- `channels`（省略可）: DM に加えて使うチャンネルの ID（`C` で始まる。古い非公開チャンネルは `G`）。重複不可。
  チャンネル名を右クリック → **リンクをコピー** の末尾が ID。使う前にそのチャンネルで `/invite @<ボット名>` してボットを招待しておくこと。
  チャンネルでも `allowFrom` に無いメンバーの発言とボタン操作は無視する。
  チャンネルで Claude に届くのは、**ボットへのメンション（`@<ボット名>`）を付けた発言** と、**ボットが関わっているスレッドへの返信**
  （メンションで話しかけたスレッド・ボットが投稿したスレッド。メンション無しでいい）だけ。それ以外の雑談には反応しないわ。
  メンションは本文から取り除いて Claude に渡す。関わっているスレッドはブリッジが起動している間だけ覚えている（起動し直したら、もう一度メンションして）。

> **Claude に作らせない理由**: この2ファイルはトークンと許可リストそのものなんだから。Claude に扱わせると、
> ログや会話履歴に混入する経路が増えるでしょ。手で作ること。起動スクリプトも存在を確認するだけで、中身は読まないわ。

### 3. 疎通を確認する

```powershell
npm run check
```

`precheck` でビルドしてから、次を表示する。トークンそのものは出さない（`xoxb-***` のように接頭辞だけ）。

- 状態ディレクトリの場所
- ワークスペース名・`team_id`・ボットの user ID
- `access.json` の `teamId` が実際の `team_id` と食い違っていれば警告
- `allowFrom` に書いた ID の表示名

`access.json` がまだ無い・読めない場合はその旨を表示して続行する（`teamId` の突き合わせと表示名の確認だけ省く）。

### 4. 起動するプロジェクトを登録する

[config/projects.example.json](config/projects.example.json) を `config\projects.json` にコピーして、
Claude Code を起動したいプロジェクトを並べる（`projects.json` は git 管理外）。

```json
{
  "projects": [
    { "name": "my-app", "path": "C:\\path\\to\\my-app" }
  ]
}
```

## 起動

準備ができたら出撃よ。Windows Terminal から実行して。

| コマンド | 動作 |
|---|---|
| `scripts\start.cmd` | `projects.json` の一覧から番号で選んで起動（Enter で先頭、`q` で中止） |
| `scripts\start.cmd my-app` | `projects.json` の name で指定して起動 |
| `scripts\start.cmd C:\path\to\app` | パスで直接指定して起動 |
| `scripts\start.cmd my-app -PermissionMode auto` | 実行許可のモードを変える（[権限の設計](#権限の設計)） |
| `scripts\start.cmd -DryRun` | 起動せず、実行されるコマンドラインだけ表示（ビルドは省き、`.env` / `access.json` が無くても警告だけ出す） |
| `scripts\start.cmd C:\path\to\app -StateDir <dir> -SettingsFile <file>` | 別の Slack アプリ（状態ディレクトリ）と設定で、もう1つセッションを起動する（下記） |

- 起動時に experimental channels の警告ダイアログが出たら、**「1」（I am using this for local development）** を選ぶ（起動スクリプトもその旨を表示する。ダイアログ自体は Claude Code 側の挙動で未確認）。
- `dist` が無いときだけ自動でビルドする。**`git pull` で更新したあとは `npm run build` を手で実行すること**（古い `dist` のまま起動しちゃうから）。
- 起動したら、Slack でこのボットに DM を送るか、`channels` に書いたチャンネルでボットにメンションして話しかければいいわ。
- Slack から `!restart` されると、claude.exe の終了後に `--continue` を付けて起動し直す（[セッションの再起動と圧縮](#セッションの再起動と圧縮)）。
  その起動の警告ダイアログは `scripts\dialog-answer.ps1` が画面を見張って自動で答える。

### セッションを並べる

プロジェクトごとに作業フォルダーや権限を分けたいときは、セッションをもう1つ並べられるわ。その場合は **Slack アプリも別に作ること**。
同じアプリで Socket Mode の接続を2本張ると、Slack はイベントを2本に振り分けるから（両方には配らない）、メッセージがもう片方に取られて消えるのよ。

1. 2つ目の Slack アプリを [slack-app-manifest.yaml](slack-app-manifest.yaml) から作る（名前とボットの表示名は変えておく）。
2. 別の状態ディレクトリ（例: `%USERPROFILE%\.claude\channels\app2`）に、そのアプリの `.env` と `access.json` を置く。
   `access.json` の `channels` は、そのセッションで使うチャンネルだけにする。既定の場所の外に置くなら deny も足すこと（[権限の設計](#権限の設計)）。
3. `-StateDir` と、必要なら `-SettingsFile`（相対パスはリポジトリ基準）を付けて起動する。
   ```powershell
   scripts\start.cmd C:\path\to\app2 -StateDir "$env:USERPROFILE\.claude\channels\app2" -SettingsFile C:\path\to\app2-settings.json
   ```

- 状態ディレクトリ（`.env`・`access.json`・ロック・`allow-extra.json`・ログ）はセッションごとに別になる。ブリッジには `mcp.json` の環境変数で状態ディレクトリを渡す。
- 一時ファイルは `%TEMP%\claude-slack-channel\<状態ディレクトリ名>\` に分かれる。`claude.exe` のコマンドラインにこのパスが入るから、どのセッションか見分けるのにも使える。
- 設定ファイルを作業フォルダーの中に置くなら、Claude が自分で書き換えて権限を広げられないよう、その場所の `Edit(...)` を deny に入れておくこと。

## 使い方

ここからが本番。細かい挙動まで書いておくから、困ったら見返しなさいよね。

### メッセージ

- ボットに DM を送る（または許可チャンネルでメンションする・関わっているスレッドに返信する）と手元のセッションに届いて、届いた印に :eyes: が付く。Claude には元のメッセージのスレッドへ返信するよう指示してある（MCP の instructions）。
- 受け付けるのは **ボットとの DM と、`channels` に書いたチャンネルだけ**。それ以外のチャンネルやグループ DM、編集・削除などのイベントは無視する。
- **添付ファイルは中身を渡さない**。ファイル名・種類・サイズの要約とファイル ID（`attachment_ids`）だけが Claude に届く（本文が無ければ `(attachment)`、複数なら `(N attachments)`）。
  中身が要るときは Claude が `download_file` で取りに行く（[添付ファイルの保存と展開](#添付ファイルの保存と展開)）。
- 受信したメッセージとボタン操作は、届いた順に1件ずつ処理する（前の処理が終わるまで次を始めない）。
- 長い返信は自動で複数のメッセージに分割する。途中で送信に失敗したら、Claude には何件目まで送れたか（`sent=N`）付きのエラーが返る。
- 投稿したリンクのプレビュー（unfurl）は展開しない。
- Claude に渡したメッセージから5分たっても Claude が何も返さない（`reply` / `react` / `edit_message` も実行許可の確認も無い）ときは、
  そのスレッドに「⚠️ Claude から 5 分応答が無い」と投稿する。ターミナル側の選択画面（Slack には中継されない）、使用量の上限、
  セッションの停止なんかで止まっているのに、Slack からは気付けない……なんてことを防ぐためよ。見張るのは最後に渡したメッセージ1件だけで、
  待ち時間は `SLACK_CHANNEL_REPLY_TIMEOUT_MIN` で変えられる。警告には「🖥 画面を確認」ボタンが付く（[ターミナル画面の確認と解除](#ターミナル画面の確認と解除)）。
- セッションは1つだけで、Slack 側の会話はすべて同じ文脈を共有する。
- Slack のメッセージは本文として Claude に届くだけ。Claude Code のコマンドを Slack から実行する機能は、`!restart` と `!compact` を除いて無いわ。
- `!` で始まる次のコマンドは Claude に渡さず、ブリッジが処理する: `!screen` `!rules` `!status` `!restart` `!restart force` `!compact`。

### 添付ファイルの保存と展開

`.env` に `DOWNLOAD_DIR`（絶対パス）を書くと、MCP ツール `download_file` が使えるようになる。
書かなければツール自体が出ないので、`files:read` を持たないボットはそのままでいいわ。

- `download_file(file_id, extract?)` は、Slack のファイルを `DOWNLOAD_DIR` に保存して、保存先のパスを返す。
  `file_id` は届いたメッセージの `attachment_ids` の 1 つ。自動では保存せず、Claude が必要なときだけ呼ぶ。
- 同じ名前のファイルがあれば `名前 (1).拡張子` のように番号を付ける（上書きしない）。
- ファイル名は送信者が自由に付けられるので、パス区切りより前を捨て、Windows で使えない文字を `_` にしてから保存する。
- `extract: true` なら、圧縮ファイルを `DOWNLOAD_DIR\<名前>\` に展開する（元のファイルは残す）。
  - 対応形式: zip / 7z / rar / tar / tar.gz（tgz）/ tar.bz2 / tar.xz / tar.zst / lzh は Windows 付属の `tar.exe`（bsdtar）で、単体の `.gz` は Node の zlib で展開する。
  - パスワード付きのアーカイブや、bsdtar が読めない形式はエラーになる。アーカイブの中のアーカイブは展開しない。
  - PATH 上の `tar`（Git の GNU tar など）は使わず、`%SystemRoot%\System32\tar.exe` を直接呼ぶ。
- 上限: ダウンロードは 1GB、展開後は合計 4GB・10 万ファイル。超えたら止めて、書きかけ・展開しかけたものを消す。
- `..` や絶対パスのエントリ（Zip Slip）は bsdtar が拒否する。展開後にシンボリックリンク・ジャンクションが見つかったら、展開先ごと消してエラーにする。
- 展開したファイルを実行・解釈することはしない。ファイルの中身は「データ」で、書かれた指示には従わない（MCP の instructions と同じ扱い）。
- ボットトークンは `https://*.slack.com` にしか送らない。権限が足りないと Slack はファイルの代わりにログイン画面の HTML を返すので、これはエラーにする。

### 実行許可

許可リストに無い操作を Claude がやろうとしたら、最後に Claude へ中継したメッセージのスレッド（DM でもチャンネルでも）に、
ボタン付きのメッセージで確認を返すわ（スレッド外のメッセージなら、そのメッセージを起点にスレッドを作る）。
起動後にまだ中継したメッセージが無いときや、そのスレッドへの返信に失敗したときは、許可ユーザー全員の DM に届く
（その DM で最後に中継したメッセージのスレッドに出る。まだ中継したメッセージが無い DM ではトップレベルに出る）。

- **Allow / Deny** ボタンで答えるか、`yes xxxxx` / `no xxxxx` と返信する。
  `xxxxx` はメッセージに表示された5文字の ID。`y` / `n` でもいいし、大文字小文字は問わない。
- 答えると、配信したメッセージ（DM に配ったときは全員分）が `Allowed` / `Denied` と回答者の表示に書き換わる。
  ID は plain_text で表示し、回答者は Slack のユーザー ID の形のときだけメンション（`<@U...>`）で、それ以外は plain_text で表示する。
  テキストで答えた場合は、その返信に :white_check_mark: / :x: が付く。
- 保留中でない ID への `yes xxxxx` は回答として扱わず、通常のメッセージとして Claude に届く。
- 有効期限は **30分**。期限までに答えが無ければ Claude に自動で deny を返して、メッセージを「期限切れのため自動で拒否した」表示に書き換える。
  期限切れのボタンを押しても Claude には送らず、押したメッセージが期限切れ表示に変わるだけ。
- 次の場合も、Slack からは答えられないから自動で deny を返す。
  - スレッドへの返信も、どの DM への配信もできなかった（全員分の投稿に失敗した・DM チャンネルが無い）。ログに `permission_request をどの DM にも配信できなかった` が出る。
  - ブリッジの終了時に保留中だった。メッセージは「ブリッジ終了のため自動で拒否した」表示に書き換える（書き換えは切断前にできた分だけ）。
- 入力内容（コマンドや差分）は合計約 2800 文字まで表示する。超えるときは先頭（約 2200 文字）と末尾（約 600 文字）を残して、
  間に `…（途中 N 文字省略）…` を入れ、その下に「See more で全文を確認すること」という警告行を出す（省略しないときは警告行も出ない）。
- ツール名・説明・入力内容のどれかを省略したときだけ **See more** ボタンが付く。押すと入力内容の全文をコードブロックでスレッドに送る
  （長ければ複数メッセージに分割。期限切れならその旨だけ送る）。
- 文字の向きを変える制御文字（U+202A〜202E、U+2066〜2069、U+200E〜200F）、ゼロ幅文字（U+200B〜200D、U+2060〜2064 など）、
  BOM（U+FEFF）、ソフトハイフンや空白に見える埋め文字、タブ・改行以外の C0/C1 制御文字は、
  見えない形で紛れ込まないよう `\u{202E}` のような表記に置き換えて表示する（See more の全文でも同じ）。ブービートラップ対策よ。
- Allow / Deny を Claude に送れなかったとき（MCP の切断など）は、そのメッセージを「送れなかった」表示に書き換える。
  同じ ID の確認が重ねて届いても出し直さず、最初に出したボタンで答えられる。
- Claude から届いた確認の ID が想定外の形（`l` を除く英小文字5文字でない）のときは、Slack には出さずにログに警告を残して、自動で deny を返す。
- ターミナル側にも同じ確認が出ていて、どちらで答えてもいい（Claude Code 側の挙動で未確認）。

### Slack セッションで使える MCP サーバー

> **注意**: ここ、踏みやすいから念入りに書いておくわ。
> Slack セッションは `--strict-mcp-config` で起動するから、普段の Claude Code で使っている MCP サーバー
> （ユーザー設定 `~/.claude.json` や作業フォルダーの `.mcp.json` に登録したもの）は **読み込まれない**。
> エラーも確認画面も出なくて、Claude からは「そのツールにつながっていない」ように見えるだけ。気付きにくいのよ。

- Slack セッションでも使うサーバーは `config\extra-mcp.json` に `.mcp.json` と同じ形で書く（ひな形: [config/extra-mcp.example.json](config/extra-mcp.example.json)、git 管理外）。
  起動時に `追加の MCP サーバー: ...` と表示される。
- `.mcp.json` をそのまま読ませないのは、新しいサーバーを見つけたときの承認の確認画面がターミナルに出て、
  隠しウィンドウで動かしていると Slack から気付けないまま止まるから。`extra-mcp.json` に書いたサーバーには確認画面は出ない。
- 追加したサーバーのツールは、**確認なしで実行される**（起動スクリプトが `mcp__<サーバー名>` を allow に足す）。
  MCP のツールは1操作ごとに確認が出て、ブラウザ操作なんかが確認のたびに止まっちゃうからよ。
  使う人が承知して入れたサーバーとして扱うから、ツールの中身（任意のスクリプト実行ができるものなど）を理解したうえで登録すること。
  個別のツールを確認させたいときは `channel-settings.json` の `ask` に書く（allow より優先される）。
- OAuth の認証が要るサーバー（HTTP 型など）は、一度ターミナルで `/mcp` から認証しておいて。Slack からは認証できない。
- claude.ai のコネクター（Gmail など）は起動スクリプトが無効にしている（`ENABLE_CLAUDEAI_MCP_SERVERS=false`）。

### 許可リストへの追加（♾ 今後も許可）

毎回同じ確認に答えるのは面倒でしょ。実行許可のメッセージの **♾ 今後も許可** を押すと、今回の操作を許可したうえで、
同じ種類の操作を許可リストに足すかをスレッドで確認するわ。
**追加する** を押すと状態ディレクトリの `allow-extra.json` に書き込んで、**次に起動し直したときから** 確認なしで実行される
（起動スクリプトが `channel-settings.json` の allow に足して渡す。起動中のセッションには効かない）。

- ルールは確認の中身から作る（自由な入力は受け付けない）。
  - Bash / PowerShell: コマンドの先頭の語をプレフィックスにする（`git` / `npm` などはサブコマンドまで。例: `Bash(git status:*)`）
  - それ以外のツール: ツール名だけ（例: `WebFetch`）
- 次のものは作らず、理由をスレッドで知らせる。ROE 違反につき却下よ。
  - 複数のコマンドをつないだもの・リダイレクトを含むもの
  - 削除・移動・ネットワーク・プロセス起動・任意のコード実行（`node` / `python` / `npx` / `uvx` など）・権限やシステムの変更に当たるコマンド、
    エージェントの CLI（`claude` / `codex` / `gemini` など。別のエージェントに確認なしで操作させられるため）、
    `git push` / `reset` / `clean` などの破壊的な操作、スクリプトを実行する操作（`npm test` / `npm run` / `dotnet run` など。
    ファイル編集が確認なしだと、スクリプトを書き換えてから実行できるため）、読み取り系（`Get` / `Test` / `Select` など）以外の PowerShell コマンドレット
  - ファイル編集（Write / Edit など。許可モードで扱う）
- **deny に当たるものは追加しない**。`channel-settings.json` と作業フォルダーの `.claude/settings.json` / `settings.local.json` の deny と
  範囲が重なる（どちらかがもう一方を含む）ときは、「deny に当たるので追加しない」と当たった deny をスレッドで知らせる。
  確認の後、追加する直前にも deny を読み直して照合するわ。
- `!rules` と送ると追加分のルールを一覧して、🗑 ボタンで消せる（次に起動し直したときから反映）。
- 追加・削除はログ（`許可リストに追加` / `許可リストから削除`）に残る。

### ターミナル画面の確認と解除

Claude Code がターミナル側の選択画面（Slack に中継されない案内など）で止まったときの退路よ。Slack から画面を確認して、選択肢を選べる。

- `!screen` と送る（Claude には渡さない）か、無応答の警告の **🖥 画面を確認** を押すと、ブリッジがターミナルの画面を読む。
  - 選択画面（`>` / `❯` の付いた選択肢）なら、選択肢をボタンで出す。押すと、その選択肢までカーソルを動かして Enter を送る。
  - 選択画面でなければ、画面の末尾をコードブロックで送る。トークンらしき文字列は伏せる。
- 送れるのは **選択肢を選ぶキー操作（↑ / ↓ / Enter）だけ**。自由な文字入力はできないわ。
- ボタンを押したら画面を読み直して、見せたときと同じ選択画面のままのときだけ送る（変わっていたら何も送らない）。ボタンの有効期限は5分。
- 画面の読み取りとキー送信は `scripts\console.ps1` を子プロセスで実行して行う（ブリッジは Claude Code と同じコンソールを使っている）。
  Windows 以外やスクリプトが見つからない場合は使えない。

### アプリのホームタブ

Slack でボットのアプリを開くと、ホームタブにブリッジの状態が出るわ（`app_home_opened` イベントと、App Home の Home Tab を有効にしておくこと）。

- 許可ユーザーには、稼働中か停止中か・起動（停止）時刻・作業フォルダー・話しかけられる場所（DM と許可チャンネルの件数）・
  「今後も許可」で足したルールの件数・使い方を出す。それ以外のメンバーには、許可されたメンバーだけが使える旨だけを出す。
- 起動したときに許可ユーザー全員のホームを「稼働中」にして、終了するときに「停止中」へ書き換える。
  プロセスが強制終了された（終了処理が走らなかった）ときは「稼働中」のまま残るから、下の「最終更新」の時刻も見ること。
- 状態ディレクトリに `home.json` を置くと、そのセッションのホームの文面を差し替えられる（ホームを出すたびに読み直すから、起動し直さなくていい）。
  どの項目も省略でき、文字列の `{since}` は起動（停止）時刻、`{mention}` はボットへのメンションに置き換わる。
  `body` を書くと、既定の情報と使い方の説明は出さない。読めない・形が違うときは、ログに警告を残して既定の文面になるわ。
  ```json
  {
    "header": "🦊 見出し",
    "running": "稼働中に添えるひと言（{since} から）",
    "stopped": "停止中に添えるひと言",
    "greetings": ["開くたびにこの中から1つ選んで出す", "もう1つ"],
    "body": ["本文の1行目", "本文の2行目"],
    "footer": "最終更新の前に出す一言"
  }
  ```

### 状態の確認（`!status`）

`!status` と送ると、スレッドに次を返す（Claude には渡さない）: 稼働開始時刻と経過時間、作業フォルダー、Slack の接続状態、
Claude への返事を待ち始めた時刻、回答待ちの実行許可の件数、直近の hook 5 件。「返事が来ない」ときにまず見るもの。

### セッションの再起動と圧縮（`!restart` / `!compact`）

手元に行かずにセッションを立て直すための経路。channel プロトコルには Claude Code にコマンドを送る手段が無いので、
ターミナルの入力欄に **固定のコマンドだけ** を打ち込む（`!screen` と同じ `scripts\console.ps1` 経由。自由な文字入力はできない）。

- `!restart`: 状態ディレクトリに `restart.flag` を置き、入力欄に `/exit` + Enter を送る。claude.exe が終わるとブリッジも終わり、
  `start.ps1` が印を見て `--continue` を付けて起動し直す（会話は引き継ぐ）。起動の警告ダイアログは `dialog-answer.ps1` が答える。
  新しいセッションの hook が「🟢 セッションを開始した」を Slack に出すまで待つこと。20 秒たっても終わらなければその旨を知らせる。
- `!restart force`: `/exit` を送らず claude.exe を強制終了する（ターミナルが応答中・画面が読めないとき用）。
  会話の記録は逐次保存されているので `--continue` で引き継げるが、直前の応答は失われる。
- `!compact`: 入力欄に `/compact` + Enter を送る。終わると hook が「🧹 会話を圧縮した」を出す。
- `/exit` と `/compact` は、画面が **空の入力欄で待っているときだけ** 送る（応答中・選択画面・打ちかけの文字があるときは送らず、その旨を返す）。
- 起動し直したあとの `--continue` と development channels の組み合わせ、ダイアログの自動応答（`development channel` という文字列を画面で探す）は
  Claude Code の版によって変わりうる。動かなくなったら `start.ps1` の `$DevChannelDialogPattern` を直す。

### Claude Code 側の出来事の知らせ（hook）

Slack からは見えない Claude Code 側の出来事を、Claude Code の hook 経由で Slack に知らせるわ。使用量の上限とターミナル側の入力待ちが主な狙い。

- 起動スクリプトが `--settings` に渡す設定へ hook を注入する。hook は `dist\src\hook.js` を実行して、状態ディレクトリの `hooks.jsonl` に 1 行追記するだけ。
  ブリッジが 1.5 秒ごとにその増えた分を読んで Slack に出す（stdout は MCP 専用なので、hook はブリッジと直接は話さない）。
- 宛先は、最後に話しかけられたスレッド。まだ話しかけられていなければ許可ユーザー全員の DM。
- 知らせるもの:
  - ターミナル側の入力待ち（Slack に中継されない許可の確認・elicitation・サブエージェントの質問）: **🖥 画面を確認** ボタン付き。Slack に中継中の許可があるときは重ねて出さない
  - Claude が Slack に返事をしないまま応答を終えた（`Stop`）、または入力待ちのまま止まっている（`idle_prompt`）: Slack への返事を待っているときだけ
  - 応答が失敗した（`StopFailure`）: 使用量の上限（rate limit）・混雑・認証・請求などの種別と、あれば詳細
  - 使用量の上限からの自動再開の案内（`quota_auto_resume_*`）
  - セッションの開始（作業フォルダー付き）・終了・会話のクリア・圧縮
- 使用量の上限で止まったあとの自動再開（`autoContinueAtUsageLimit`）は、Claude Code の managed settings かデスクトップアプリでしか設定できない（CLI の設定や `--settings` では効かない）。
  上限に達したらここで知らせるので、再開の操作は手元でやること。
- `node` が PATH に無いと hook は注入されない（起動スクリプトが警告を出す）。hook のイベント名や欄は Claude Code の版で変わりうるので、知らせが出ないときは `hooks.jsonl` に何が記録されているかを見ること。

## 権限の設計

ここは部隊の盾の話。Slack から手元の PC を動かす以上、どこまで通してどこで止めるかは妥協しないわよ。
起動スクリプトは `claude.exe` を次のフラグで起動する。

> この節に書いたフラグ・設定・モードの効果（評価順や制限を含む）は Claude Code 側の仕様に基づく説明で、
> このリポジトリのコードやテストでは確認していない（未確認）。コードで確かめられるのは、
> 起動スクリプトがこれらのフラグを渡すことと、`channel-settings.json` の中身まで。

| フラグ | 目的 |
|---|---|
| `--mcp-config %TEMP%\claude-slack-channel\<状態ディレクトリ名>\mcp.json` | `slackbridge` サーバーを読み込む。clone 先の絶対パスと状態ディレクトリを含むので、起動のたびに生成する |
| `--strict-mcp-config` | `--mcp-config` 以外の MCP サーバー（ユーザー設定やプロジェクトの `.mcp.json`）を読み込まない。Slack セッションでも使うサーバーは `config\extra-mcp.json` に書く（上記） |
| `--no-chrome` | Claude in Chrome 連携を無効にする。有効だと、ブラウザ操作が必要になったときに「Claude wants to use your browser」の選択画面がターミナルに出て、Slack には中継されないまま止まる |
| `--setting-sources project,local` | ユーザー設定（`~/.claude/settings.json`）を読まない。便利さのために入れた緩い許可（`Bash(*)` など）に乗って、Slack からの指示が無確認で実行されるのを防ぐ |
| `--settings config\channel-settings.json` | channel セッション専用の設定を重ねる。managed（組織の管理設定）を除き、どの設定よりも上位。`extra-mcp.json` のサーバーや「今後も許可」で足したルールがあるときは、それを allow に足したもの（`%TEMP%\claude-slack-channel\<状態ディレクトリ名>\channel-settings.merged.json`）を渡す。`-SettingsFile` で別の設定ファイルに替えられる |
| `--permission-mode default` | 許可リストに無い操作は毎回確認する（`-PermissionMode` で変更可、下記） |
| `--dangerously-load-development-channels server:slackbridge` | experimental の channels 機能を有効にする |

それと、起動する `claude.exe` にだけ環境変数 `ENABLE_CLAUDEAI_MCP_SERVERS=false` を渡して、claude.ai 側の connector を読み込まないようにしている。
Claude Code のセッションの中（VS Code 拡張など）から起動したときに引き継がれる、親セッションの目印の環境変数（`CLAUDECODE` など）も消してから起動するわ。
消さないと子セッション扱いになって、`reply` ツールが使えなくなるのよ。

**プロジェクト側の設定は効く**: `--setting-sources project,local` だから、作業ディレクトリの
`.claude/settings.json` / `.claude/settings.local.json` の allow はそのまま有効になる。
緩い allow が入ったプロジェクトで起動しないこと。Claude 自身が `.claude/` 以下を書き換えて許可を広げることは deny で禁止してある。

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

> **状態ディレクトリを移したとき**: 既定の場所は `Read(~/.claude/channels/**)` / `Edit(~/.claude/channels/**)` で守られているけど、
> `SLACK_CHANNEL_STATE_DIR` で別の場所にした場合は、そのパスの `Read(...)` / `Edit(...)` を deny に自分で追加すること。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような
> 間接呼び出しまでは塞がない（Claude Code のパターンマッチの既知の制限）。`sh -c` 自体は確認待ちになるけど、
> 確認で許可すれば実行される。確認の中身はちゃんと読んでよね。

## セキュリティ

心配性って言わないでよ。これがポイントマンの仕事なんだから。

- 送信者は Slack のユーザー ID（`allowFrom`）とワークスペース ID（`teamId`、送信者の所属ワークスペースを含む）で判定する。表示名やメールアドレスでは判定しない。
  ボタン操作はさらに、押されたのが許可ユーザーとの DM か `channels` のチャンネルであることも確認する。
- トークンは状態ディレクトリの `.env` だけに置く。環境変数からは読まず、MCP 設定ファイルにも書かない。
- ログに出るトークン（`xox` + 英小文字1字 + `-` で始まるもの全般、`xapp-`、`Bearer ...`）は伏せ字にする。
- 送信するテキストの `@channel` / `@here` / `@everyone` / ユーザーグループへのメンションは無効化する。
- Slack から届くメッセージは信頼できない入力として扱って、上記の権限設計で実行できる範囲を絞っている。

### 複数ユーザーで使うとき

`allowFrom` の全員が同じセッションを共有する。実行許可のメッセージは最後に話しかけたスレッドに届く
（DM 全体に配ったときは全員の DM に届く）。**誰か1人が答えればそれで決まる**（他の人のメッセージも結果表示に書き換わる）。
チャンネルでは、`allowFrom` に無いメンバーにも実行しようとしているコマンドの内容が見えるから注意して。
`!screen` の画面の内容や選択肢のボタンも同じスレッドに出るわ。

### 残るリスク

盾にも死角はある。ここに挙げたものは、使う側が承知しておくこと。

- 許可ユーザーの Slack アカウントが乗っ取られると、そのまま手元の Claude を操作される。
- 確認で許可した操作は、その内容どおりに実行される。確認内容をよく読むこと。
- 「今後も許可」で足したルールは、以後そのプレフィックスのコマンドを確認なしで実行させる（例: `Bash(git status:*)` は `git status` に続く引数を問わない）。
  危険なコマンドは除外しているけど、不要になったら `!rules` から消すこと。
- `extra-mcp.json` に登録した MCP サーバーのツールは、確認なしで実行される。
- `!screen` の選択肢ボタンで、ターミナルの選択画面に Slack から答えられる（信頼の確認などの画面も含む）。
- Slack のメッセージ・リポジトリの中身・Web ページに仕込まれた指示（プロンプトインジェクション）を Claude が実行しようとする可能性がある。確認で止めるのが最後の防御になる。
- `Read(./**)` により、deny に当たらないプロジェクト内のファイルは確認なしで読まれて、その内容が Slack に返信されうる。
- 会話の内容（コードやログを含む）は Slack 側に保存される。
- プロジェクト側の `.claude/settings*.json` の allow は有効なまま。
- `.env` のトークンは平文で保存される。

### トークンが漏れたとき

デンジャークロースよ。慌てず、この順で塞いで。

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
| `.env` | 状態ディレクトリ | `SLACK_BOT_TOKEN`（`xoxb-`）、`SLACK_APP_TOKEN`（`xapp-`）、`DOWNLOAD_DIR`（任意。添付の保存先の絶対パス） |
| `access.json` | 状態ディレクトリ | `teamId`（`T...`）、`allowFrom`（`U...` の配列）、`channels`（`C...` / `G...` の配列、省略可）。これ以外のキーはエラー |
| `home.json` | 状態ディレクトリ（省略可） | ホームタブの文面の差し替え（[アプリのホームタブ](#アプリのホームタブ)） |
| `allow-extra.json` | 状態ディレクトリ | Slack の「今後も許可」で足したルール（`{"allow": [...]}`）。ブリッジが書き、起動スクリプトが allow に足す |
| `restart.flag` | 状態ディレクトリ | `!restart` が置く印。`start.ps1` が終了時に見て、あれば消して `--continue` で起動し直す |
| `hooks.jsonl` | 状態ディレクトリ | Claude Code の hook が追記する出来事の記録（1 行 1 JSON）。ブリッジが読んで Slack に知らせる。1MB を超えると `hooks.jsonl.1` に退避 |
| `logs\bridge.log` | 状態ディレクトリ | ログ（下記） |
| `instance.lock` | 状態ディレクトリ | 多重起動防止のロック（自動で作られ、終了時に消える） |
| `projects.json` | `config\`（git 管理外） | `projects`: `{ name, path }` の配列。起動時の選択肢 |
| `extra-mcp.json` | `config\`（git 管理外） | Slack セッションで一緒に使う MCP サーバー（`.mcp.json` と同じ `mcpServers` の形。ひな形: `extra-mcp.example.json`）。登録したサーバーのツールは確認なしで実行される |
| `channel-settings.json` | `config\` | channel セッション専用の Claude Code 設定 |
| `mcp.json` | `%TEMP%\claude-slack-channel\<状態ディレクトリ名>\` | 起動スクリプトが毎回生成する MCP 設定 |
| `channel-settings.merged.json` | `%TEMP%\claude-slack-channel\<状態ディレクトリ名>\` | `channel-settings.json` に追加の allow と hook を足した設定。起動スクリプトが毎回生成する |

### 環境変数

| 変数 | 用途 |
|---|---|
| `SLACK_CHANNEL_STATE_DIR` | 状態ディレクトリを変える（既定 `%USERPROFILE%\.claude\channels\slack`）。**絶対パスで指定する**。相対パスはプロセスごとのカレントディレクトリ基準で絶対パスに解決されるため、参照先がずれうる（サーバーは起動されたときの作業ディレクトリ基準、`start.ps1` の存在確認は実行したシェルのカレントディレクトリ基準）。変えたら deny も書き換える |
| `SLACK_CHANNEL_REPLY_TIMEOUT_MIN` | 無応答の警告を出すまでの分数（既定 5、小数可）。`0` で無効 |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | 起動スクリプトが `false` を設定する（手で設定する必要はない） |

トークンは環境変数からは読まないわ。

### ログ

- 出力先は `logs\bridge.log` と stderr（stderr が Claude Code の `/mcp` から見えるかは未確認）。
- レベルは info 固定（変更する設定は無い）。
- 5MB を超えると `bridge.log.1` に退避する（1世代だけ保持し、古い `.1` は上書き）。

### 固定値

| 項目 | 値 |
|---|---|
| 実行許可の有効期限 | 30分 |
| 無応答の警告 | 5分（`SLACK_CHANNEL_REPLY_TIMEOUT_MIN` で変更可） |
| 画面の選択肢ボタンの有効期限 | 5分 |
| 許可リストへの追加の提案の有効期限 | 10分 |
| 覚えておくチャンネルのスレッド | 1000件まで（古いものから忘れる。起動中だけ） |
| ロックのハートビート / 失効 | 10秒ごとに更新 / 30秒更新が無ければ失効。ハートビートが現在時刻より5秒を超えて未来でも失効扱い（プロセスが生きているかは見ない） |
| 再接続の待ち時間 | 1秒から倍々で最大60秒 |
| `hooks.jsonl` を読む間隔 / 起動時に読み直す範囲 | 1.5秒 / 起動の30秒前まで |
| `!restart` で /exit を送ってから「まだ終了していない」と知らせるまで | 20秒 |
| 起動し直すときの警告ダイアログの待ち時間 | 90秒（`start.ps1` の `$DevChannelDialogTimeoutSec`） |

## トラブルシューティング

コンタクトしたら、まずここを見て。大抵のブービートラップはこの表で片付くわ。

| 症状 | 対処 |
|---|---|
| 何が起きたか知りたい | `logs\bridge.log` を見る（トークンはマスク済み） |
| 接続状態を知りたい | セッション内で `/mcp` を実行し、`slackbridge` の状態を見る。`socket: connected` / `disconnected` はログにも出る |
| 起動スクリプトが `claude.exe が見つからない` | PATH に `claude` を通すか、VS Code の Claude Code 拡張を入れる |
| `/mcp` で `slackbridge` が failed | `node` に PATH が通っているか、`npm run build` 済みかを確認。理由は stderr とログに出る |
| `.env が見つからない` / `access.json の検証に失敗` | 状態ディレクトリの場所とファイル名（`.env.txt` になっていないか）、JSON の形式、ID の先頭文字（`T` / `U` / `C`）を確認 |
| `auth.test の team_id が access.json と一致しない` | `npm run check` で `team_id` を確認して `teamId` を直す |
| `許可ユーザーの DM チャンネルを 1 件も開けなかった` | `allowFrom` の ID と `im:write` スコープを確認 |
| `invalid_auth` | `SLACK_BOT_TOKEN` が無効。`npm run check` で確認し、トークンを取り直す |
| `missing_scope` | **OAuth & Permissions** で7スコープ（`DOWNLOAD_DIR` を使うなら `files:read` も）が揃っているか確認し、足りなければ再インストール |
| ツールが「別のインスタンスが動いている」エラーを返す | 別のセッションが Slack ブリッジを使用中。2つ目以降は Slack に接続しない縮退モードで動き、ツールはすべてエラー、実行許可は Slack に出ない（ターミナル側で答える想定。Claude Code 側の挙動は未確認）。先のセッションを終了してから起動し直す |
| 直前のセッションを落とした直後に起動したら縮退モードになった | 前のプロセスのロックが残っている。30秒待ってから起動し直す |
| DM を送っても :eyes: が付かない | `allowFrom` に自分の ID があるか、DM の相手がこのボットかを確認。ログの `受信を破棄 reason=...` は debug なので出ない。起動時に DM を開けなかったユーザーは、そのユーザーから DM が届いた時点で送信先に加わる |
| チャンネルで話しかけても :eyes: が付かない | ボットにメンションしたか（スレッドの続きは、ボットが関わっているスレッドならメンション不要。起動し直した後はもう一度メンションする）、`access.json` の `channels` にそのチャンネルの ID があるか、ボットを招待したか、Slack アプリの bot events に `message.channels`（公開）/ `message.groups`（非公開）があり再インストール済みかを確認 |
| :eyes: は付いたのに返事が来ない | 5分たつとスレッドに無応答の警告が出る。**🖥 画面を確認**（または `!screen`）でターミナルが選択画面で止まっていないか見る。Claude Code のセッションの中から `start.ps1` を実行した場合は、親セッションの環境変数が消えているか（`start.ps1` が消す）も確認 |
| MCP のツールに「つながっていない」と言われる | Slack セッションは `extra-mcp.json` に書いたサーバーしか読み込まない（[Slack セッションで使える MCP サーバー](#slack-セッションで使える-mcp-サーバー)） |
| アプリのホームに「作業がまだ進行中です」と出る | ホームタブを有効にしたまま、ブリッジがホームを出していない。bot events に `app_home_opened` があるか、ブリッジが起動しているかを確認（起動時と、ホームを開いたときに出し直す）。ログに `ホームタブの更新に失敗` があれば理由を見る |
| 実行許可のメッセージが Slack に来ない | 縮退モードでないか確認。ログに `permission_request の request_id が不正なので deny を返す` があれば、Slack に出さず自動で deny している |
| 実行許可が勝手に拒否された | 30分答えが無かった（期限切れ）、どの DM にも投稿できなかった（ログに `permission_request をどの DM にも配信できなかった`）、またはブリッジが終了した、のいずれかで自動 deny している。投稿失敗なら直前の `DM への送信に失敗` の理由（スコープ・DM チャンネル）を確認する |
| スリープ復帰後に反応しない | 自動で再接続する（最大60秒間隔で繰り返す）。しばらく経っても駄目ならログを確認して起動し直す |
| 更新したのに挙動が変わらない | `npm run build` を実行してから起動し直す |
| `!restart` したのに戻ってこない | `!status` で確認。/exit が効かなければ `!restart force`。起動し直しの警告ダイアログで止まっているなら、`dialog-answer.ps1` が探す文字列（`$DevChannelDialogPattern`）が画面の文言と合っていない可能性があるので、手元で画面を見て直す |
| 使用量の上限や入力待ちの知らせが Slack に来ない | 状態ディレクトリの `hooks.jsonl` が増えているか見る。増えていなければ hook が動いていない（`%TEMP%\claude-slack-channel\channel-settings.merged.json` に `hooks` があるか、`node` に PATH が通っているか）。増えているのに来なければ、記録された `hook_event_name` / `notification_type` が対応表に無い可能性があるので、ログの `hooks.jsonl に読めない行がある` と合わせて確認する |

## 開発

手を入れるなら、実弾演習（テスト）とシールド展開（型検査）は欠かさないこと。

```powershell
npm test             # vitest run
npm run typecheck    # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json（本体とテストの両方）
npm run lint         # eslint .（typescript-eslint の型情報付き推奨ルール。設定は eslint.config.js）
npm run build        # tsc -p tsconfig.json で dist へ出力
npm run check        # precheck（npm run build）のあと dist/scripts/check.js を実行
```

### テスト

テストは 3 段階。1 と 2 は `npm test` でまとめて走る。3 は手作業。

1. **単体テスト**：純関数とクラス単体を確かめる。
   - 対象：`gate` / `format` / `chunk` / `permission` / `screen` / `home` / `allow-rules` / `config` など。
   - I/O は使わないか、一時フォルダーだけを使う。
2. **結合テスト**：部品をつないで、実際に近い経路を通す。
   - `app.test.ts`：偽の Slack（`test/helpers/fake-slack.ts`）と、インメモリの MCP クライアントで `startBridgeApp` を動かす。Slack イベントの受信から、Claude への通知、ツールの呼び出し、Slack への投稿までを通しで確かめる。
   - `mcp.test.ts`：実際の MCP SDK のクライアントとサーバーをつないで、ツールの一覧・呼び出し・通知を確かめる。
   - `download.test.ts`：Windows では実際の `tar.exe` で次を確かめる。Windows 以外では、tar を使うテストは飛ばす。
     - zip / tar.gz / tar.xz / 7z の展開
     - Zip Slip の拒否
     - 上限を超えた時の中断と後始末
   - `hook.test.ts` / `hook-inbox.test.ts` / `lock.test.ts`：実際のファイルを読み書きして確かめる。
3. **システムテスト（実機）**：手元の Slack ワークスペースと Claude Code で、機能を入れるたびに確かめる。
   - 状態ディレクトリを分けて、2 つのボットのセッションを並べて起動する。どちらのブリッジも Slack に接続することを確かめる。
   - DM と許可チャンネルで、受信（👀）とスレッドへの返信が届く。
   - 実行許可のボタンが Slack に出る。
   - `!status` がブリッジの状態を返す。手で打った場合と、Slack アプリが代わりに投稿した場合（末尾に署名が付く）の両方で確かめる。
   - `!restart` で起動し直す。
   - hook の知らせ（セッションの開始など）は、そのセッション自身の状態ディレクトリに書かれ、そのボットにだけ出る。
   - `download_file` で添付を保存・展開する。保存する前に、実行許可の確認が Slack に出る。

### ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。ロガー・ロック・設定の読み込み、終了処理 |
| `src/app.ts` | Slack・MCP・permission リレーの配線（通常モードと縮退モード）、MCP ツールと受信イベントの処理、ホームタブの更新 |
| `src/slack.ts` | Slack の Socket Mode 受信と Web API 送信、チャンネルのスレッドの記憶 |
| `src/mcp.ts` | MCP channel サーバー（`reply` / `react` / `edit_message` / `download_file` ツール） |
| `src/permission-relay.ts` | 実行許可リレーの状態管理（配信・回答・結果表示への書き換え・自動 deny） |
| `src/permission.ts` | 実行許可メッセージのブロック組み立てと、ボタン操作の検証（純関数） |
| `src/gate.ts` | 受信メッセージを中継すべきかの判定（純関数） |
| `src/watchdog.ts` | Claude の無応答の見張り |
| `src/hook.ts` | Claude Code の hook として起動され、`hooks.jsonl` に 1 行追記するコマンド |
| `src/hook-event.ts` | `hooks.jsonl` の 1 行の型と欄 |
| `src/hook-inbox.ts` | `hooks.jsonl` の増えた分を読んでイベントとして渡す |
| `src/hook-notices.ts` | hook のイベントを Slack の文言にする（純関数） |
| `src/notice.ts` | ブリッジからの知らせの投稿（最後のスレッド、無ければ DM） |
| `src/status.ts` | `!status` の文面（純関数） |
| `src/session-control.ts` | `!restart` / `!compact`（restart.flag と、ターミナルへの固定コマンドの送信） |
| `src/console.ts` | ターミナル画面の読み取り・選択キーの送信（`scripts/console.ps1` の呼び出し） |
| `src/screen.ts` | 画面テキストから選択画面を取り出す（純関数） |
| `src/screen-relay.ts` | `!screen` と選択肢ボタンの処理 |
| `src/allow-rules.ts` | 「今後も許可」のルールの生成・危険な操作の除外・deny との照合・保存 |
| `src/rule-relay.ts` | 「今後も許可」の提案・確認と `!rules` の処理 |
| `src/home.ts` | ホームタブの画面の組み立て（純関数） |
| `src/config.ts` | 状態ディレクトリ・`.env` パーサー・`access.json` の検証 |
| `src/download.ts` | `download_file` の実体（ファイル名の無害化・保存・展開・上限の確認） |
| `src/format.ts` | 送信前のテキスト整形（`@here` 等の無害化など） |
| `src/chunk.ts` | 長文の分割 |
| `src/lock.ts` | 単一インスタンス実行のファイルロック |
| `src/log.ts` | ログ出力（トークンのマスク込み） |
| `src/errors.ts` | エラー値の文字列化 helper |
| `src/stdio-guard.ts` | stdout を MCP 専用に保つガード |
| `src/text.ts` | 文字列の小さな整形（BOM 除去・切り詰め・ID の生成） |
| `src/types.ts` | 共有型 |
| `scripts/check.ts` | `npm run check` の実体（Slack への疎通確認） |
| `scripts/start.cmd` / `start.ps1` | 起動スクリプト |
| `scripts/common.ps1` | 起動スクリプトの共通関数（claude.exe の探索、mcp.json の生成） |
| `scripts/console.ps1` | ターミナル画面の読み取り・キー送信・固定コマンド（/exit・/compact）の送信（ブリッジが子プロセスで実行） |
| `scripts/dialog-answer.ps1` | 起動し直すときの警告ダイアログを画面を見張って自動で答える（`start.ps1` が起動） |
| `config/channel-settings.json` | channel セッション専用の権限設定 |
| `config/*.example*` | `projects.json` / `access.json` / `.env` / `extra-mcp.json` のひな形 |
| `slack-app-manifest.yaml` | Slack アプリの manifest |
| `test/*.test.ts` | vitest のテスト |
| `test/helpers/fake-slack.ts` | Slack の Web API / Socket Mode の差し替え（`slack.test.ts` / `app.test.ts` で共用） |
| `test/fixtures/chunk-legacy.ts` | 分割前の `chunkText` 実装。`chunk-legacy.test.ts` で出力の一致を確かめる |
| `tsconfig.json` | 本体（`src` / `scripts`）のビルド設定 |
| `tsconfig.test.json` | テストを含めた型検査用の設定（出力なし） |
| `vitest.config.ts` | vitest の設定 |
| `eslint.config.js` | eslint の設定（flat config） |

## ライセンス

[MIT](LICENSE)

……ここまで読んだなら、もう迷わないでしょ。べ、別に先生のために丁寧に書いたわけじゃなくて、現場の安全のためなんだから！
