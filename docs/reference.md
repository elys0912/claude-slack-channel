# 設定リファレンスとトラブルシューティング

設定値を調べるときと、動かないときに開く文書。困っているなら、[トラブルシューティング](#トラブルシューティング) から読めばいい。

## 用語

| 用語 | 意味 |
|---|---|
| ブリッジ | このリポジトリのサーバー（`dist/src/main.js`）。Claude Code が MCP サーバーとして起動し、Slack との間でメッセージを中継する |
| 状態ディレクトリ | ブリッジの設定・ログ・ロックを置く場所。既定は `%USERPROFILE%\.claude\channels\slack`。`SLACK_CHANNEL_STATE_DIR` か、起動スクリプトの `-StateDir` で変えられる |
| 縮退モード | ロックが取れなかったブリッジが入るモード。Slack に接続せず、ツールはすべてエラーを返し、実行許可も Slack に出さない。同じ状態ディレクトリで2つ目のセッションを起動すると、こうなる |
| 許可リスト（allow / ask / deny） | Claude Code の権限ルール。allow は確認なしで通す、ask は毎回確認する、deny は実行させない。評価は deny → ask → allow の順 |
| hook | Claude Code が出来事（セッションの開始、応答の失敗など）のたびに実行するコマンド。ブリッジは hook の記録を読んで Slack に通知する |
| 再起動フラグ | `!restart` が状態ディレクトリに置く `restart.flag`。起動スクリプトは、claude.exe の終了時にこれがあれば再起動する |

## ファイル

| ファイル | 場所 | 内容 |
|---|---|---|
| `.env` | 状態ディレクトリ | `SLACK_BOT_TOKEN`（`xoxb-`）、`SLACK_APP_TOKEN`（`xapp-`）。任意で `DOWNLOAD_DIR`（添付の保存先の絶対パス）と `SESSION_ALLOW_ALL`（`on` で「このセッション中は全部許可」ボタンを出す） |
| `access.json` | 状態ディレクトリ | `teamId`（`T...`）、`allowFrom`（`U...` の配列）、`channels`（`C...` / `G...` の配列、省略可）。ほかのキーがあるとエラーにする |
| `home.json` | 状態ディレクトリ（省略可） | ホームタブの文面の差し替え（[アプリのホームタブ](usage.md#アプリのホームタブ)） |
| `allow-extra.json` | 状態ディレクトリ | Slack の「今後も許可」で足したルール（`{"allow": [...]}`）。ブリッジが書き、起動スクリプトが allow に足す |
| `restart.flag` | 状態ディレクトリ | 再起動フラグ（`{"at": ..., "sessionId": ...}`）。`start.ps1` はこれを消してから、`--resume <sessionId>`（会話の記録が無ければ新しい会話）で再起動する |
| `hooks.jsonl` | 状態ディレクトリ | Claude Code の hook が追記する出来事の記録（1行に1つの JSON）。ブリッジが読んで Slack に通知する。1MB を超えると `hooks.jsonl.1` に退避する |
| `logs\bridge.log` | 状態ディレクトリ | ブリッジのログ（下記） |
| `logs\dialog-answer.log` | 状態ディレクトリ | 起動・`!restart` のたびに、警告ダイアログに自動で答えたかどうか（答えた・キーを送れなかった・時間切れ） |
| `instance.lock` | 状態ディレクトリ | 多重起動を防ぐロック。自動で作られ、終了時に消える |
| `projects.json` | `config\`（git の管理外） | `projects`: `{ name, path }` の配列。起動時の選択肢になる |
| `extra-mcp.json` | `config\`（git の管理外） | Slack のセッションで一緒に使う MCP サーバー。`.mcp.json` と同じ `mcpServers` の形で書く（ひな形: `extra-mcp.example.json`）。登録したサーバーのツールは確認なしで実行される |
| `channel-settings.json` | `config\` | Slack のセッション専用の Claude Code の設定 |
| `mcp.json` | `%TEMP%\claude-slack-channel\<状態ディレクトリ名>\` | 起動スクリプトが毎回作る MCP の設定 |
| `channel-settings.merged.json` | `%TEMP%\claude-slack-channel\<状態ディレクトリ名>\` | `channel-settings.json` に、追加の allow と hook を足した設定。起動スクリプトが毎回作る |

## 環境変数

| 変数 | 用途 |
|---|---|
| `SLACK_CHANNEL_STATE_DIR` | 状態ディレクトリを変える（既定は `%USERPROFILE%\.claude\channels\slack`）。変えたら deny も書き換える（[権限の設計](security.md#権限の設計)） |
| `SLACK_CHANNEL_REPLY_TIMEOUT_MIN` | 無応答の警告を出すまでの分数（既定は 5、小数も可）。`0` で無効になる |
| `ENABLE_CLAUDEAI_MCP_SERVERS` | 起動スクリプトが `false` を設定する。手で設定する必要はない |
| `SLACK_CHANNEL_PLACEHOLDER` | `1` なら、サーバーはツールを持たずに待つだけになる。起動スクリプトが local スコープに登録する `slackbridge` にだけ付ける（[権限の設計](security.md#権限の設計)）。手で設定する必要はない |

`SLACK_CHANNEL_STATE_DIR` は**絶対パスで指定する**。相対パスだと、プロセスごとに基準が違うので参照先がずれることがある。
サーバーは、起動されたときの作業フォルダーを基準にする。`start.ps1` がファイルの有無を確かめるときは、実行したシェルの作業フォルダーを基準にする。

トークンは環境変数からは読まない。

## ログ

- 出力先は `logs\bridge.log` と stderr。stderr が Claude Code の `/mcp` から見えるかは確かめていない。
- レベルは info で固定（変える設定は無い）。
- 5MB を超えると `bridge.log.1` に退避する。残すのは1世代だけで、古い `.1` は上書きする。

## 固定値

| 項目 | 値 |
|---|---|
| 実行許可の有効期限 | 30分 |
| 無応答の警告 | 5分（`SLACK_CHANNEL_REPLY_TIMEOUT_MIN` で変えられる） |
| 画面の選択肢ボタンの有効期限 | 5分 |
| 許可リストへの追加の提案の有効期限 | 10分 |
| 覚えておくチャンネルのスレッド | 1000件まで（古いものから忘れる。動いている間だけ） |
| ロックのハートビート / 失効 | 10秒ごとに更新する。30秒間更新が無いか、ハートビートが現在時刻より5秒を超えて未来なら失効とみなす。持ち主のプロセスが死んでいれば、失効前でも取る |
| ロックが取れないときの取り直し | 起動時に最大10秒（0.5秒間隔）。取れなければ縮退モードに入る |
| 再接続の待ち時間 | 1秒から倍々に延ばし、最大60秒 |
| `hooks.jsonl` を読む間隔 / 起動時に読み直す範囲 | 1.5秒 / 起動の30秒前以降（そのうち、最後のセッションが始まった後の分だけ） |
| `hooks.jsonl` を1回に読む量 / 改行の無い行を溜める上限 | 1MB（超えた古い分は読み飛ばす）/ 64KB（超えたら次の改行まで捨てる） |
| `!restart` で `/exit` を送ってから「まだ終了していない」と通知するまで | 20秒 |
| 警告ダイアログへの自動応答の待ち時間 | 90秒（`start.ps1` の `$DevChannelDialogTimeoutSec`） |

## トラブルシューティング

まず `logs\bridge.log` を見る（トークンは伏せてある）。接続状態は、セッションの中で `/mcp` を実行して `slackbridge` の状態を見れば分かる。`socket: connected` / `disconnected` はログにも出る。

### 起動できない・接続できない

| 症状 | 対処 |
|---|---|
| 起動スクリプトが `claude.exe が見つからない` と出す | PATH に `claude` を通すか、VS Code の Claude Code 拡張を入れる |
| `/mcp` で `slackbridge` が failed になる | `node` に PATH が通っているか、`npm run build` を済ませたかを確かめる。理由は stderr とログに出る |
| `.env が見つからない` / `access.json の検証に失敗` | 状態ディレクトリの場所、ファイル名（`.env.txt` になっていないか）、JSON の形式、ID の先頭の文字（`T` / `U` / `C`）を確かめる |
| `auth.test の team_id が access.json と一致しない` | `npm run check` で `team_id` を確かめ、`teamId` を直す |
| `許可ユーザーの DM チャンネルを 1 件も開けなかった` | `allowFrom` の ID と、`im:write` スコープを確かめる |
| `invalid_auth` | `SLACK_BOT_TOKEN` が無効になっている。`npm run check` で確かめ、トークンを取り直す |
| `missing_scope` | **OAuth & Permissions** で7つのスコープ（`DOWNLOAD_DIR` を使うなら `files:read` も）が揃っているか確かめる。足りなければ足して再インストールする |
| ツールが「別のインスタンスが動いている」エラーを返す | 縮退モードで動いている。同じ状態ディレクトリで、別のセッションがブリッジを使っている。先のセッションを終了してから再起動する。縮退モードの間、実行許可はターミナル側で答える想定（Claude Code 側の挙動は確かめていない） |
| 前のセッションを落とした直後に起動したら、縮退モードになった | 新しいブリッジは起動時に最大10秒ロックを取り直し、持ち主のプロセスが死んでいればロックを取る。それでも縮退になるなら、前のブリッジがまだ生きている（固まっている）可能性がある。タスクマネージャーで古い `node.exe`（`dist\src\main.js`）が残っていないか確かめ、止めてから再起動する |
| 更新したのに挙動が変わらない | `npm run build` を実行してから再起動する |
| スリープから復帰したあと反応しない | 自動で再接続する（最大60秒間隔で繰り返す）。しばらくたっても反応しなければ、ログを確かめて再起動する |

### メッセージに反応しない

| 症状 | 対処 |
|---|---|
| ターミナルに `server:slackbridge · no MCP server configured with that name` と出て、Slack から話しかけてもセッションに届かない | 作業フォルダーの local スコープに `slackbridge` が登録されていない。起動スクリプトが起動前に登録するので、起動時の警告を確かめる。登録できていなければ、警告に出たコマンドを作業フォルダーで実行してから再起動する（[権限の設計](security.md#権限の設計)） |
| DM を送っても :eyes: が付かない | `allowFrom` に自分の ID があるか、DM の相手がこのボットかを確かめる。ログの `受信を破棄 reason=...` は debug レベルなので出ない。起動時に DM を開けなかったユーザーは、そのユーザーから DM が届いた時点で送信先に加わる |
| チャンネルで話しかけても :eyes: が付かない | 次を順に確かめる。(1) ボットにメンションしたか。ボットが関わっているスレッドならメンションは要らないが、再起動した後はもう一度メンションする。(2) `access.json` の `channels` に、そのチャンネルの ID があるか。(3) ボットを招待したか。(4) Slack アプリの bot events に `message.channels`（公開）/ `message.groups`（非公開）があり、再インストール済みか |
| :eyes: は付いたのに返事が来ない | 5分たつと、スレッドに無応答の警告が出る。**🖥 画面を確認**（または `!screen`）で、ターミナルが選択画面で止まっていないかを見る。Claude Code のセッションの中から `start.ps1` を実行したときは、親のセッションの環境変数が消えているか（`start.ps1` が消す）も確かめる |
| MCP のツールに「つながっていない」と言われる | Slack のセッションは、`extra-mcp.json` に書いたサーバーしか読み込まない（[普段の MCP サーバーは読み込まれない](usage.md#普段の-mcp-サーバーは-slack-のセッションでは読み込まれない)） |
| アプリのホームに「作業がまだ進行中です」と出る | Home Tab は有効なのに、ブリッジがホームを出していない。bot events に `app_home_opened` があるか、ブリッジが動いているかを確かめる。ブリッジは起動時と、ホームが開かれたときにホームを出し直す。ログに `ホームタブの更新に失敗` があれば、その理由を見る |

### 実行許可がおかしい

| 症状 | 対処 |
|---|---|
| 実行許可のメッセージが Slack に来ない | 縮退モードになっていないか確かめる。ログに `permission_request の request_id が不正なので deny を返す` があれば、Slack に出さずに自動で deny している |
| 実行許可が勝手に拒否された | 次のどれかで自動で deny している。30分答えが無かった（期限切れ）、どの DM にも投稿できなかった（ログに `permission_request をどの DM にも配信できなかった`）、ブリッジが終了した。投稿の失敗なら、直前の `DM への送信に失敗` の理由（スコープ・DM チャンネル）を確かめる |

### 再起動・通知・画面の操作が動かない

| 症状 | 対処 |
|---|---|
| `!restart` したのに戻ってこない | `!status` で状態を見る。`/exit` が効かなければ `!restart force` を使う。警告ダイアログで止まっているなら（初回の起動でも同じ）、`dialog-answer.ps1` が探す文字列（`start.ps1` の `$DevChannelDialogPattern` / `$DevChannelChoicePattern`）が画面の文言と合っていない可能性がある。手元で画面を見て直す |
| 使用量の上限や入力待ちの通知が Slack に来ない | 状態ディレクトリの `hooks.jsonl` が増えているかを見る。増えていなければ hook が動いていない。`%TEMP%\claude-slack-channel\<状態ディレクトリ名>\channel-settings.merged.json` に `hooks` があるか、`node` に PATH が通っているかを確かめる。増えているのに通知が来なければ、記録された `hook_event_name` / `notification_type` が対応表に無い可能性がある。ログの `hooks.jsonl に読めない行がある` とあわせて確かめる |
| `!screen` / `!restart` / `!compact` / 警告ダイアログへの自動応答がどれも動かない | PowerShell が Constrained Language Mode だと、`console.ps1` の `Add-Type` が失敗する。`powershell -NoProfile -Command '$ExecutionContext.SessionState.LanguageMode'` の結果が `FullLanguage` かを確かめる。それ以外なら、その PC ではこれらの機能を使えない |

ここで解決しないときは、GitHub の Issues に書いてほしい。`logs\bridge.log` の該当する行を添えると調べやすい（トークンは伏せてある）。
