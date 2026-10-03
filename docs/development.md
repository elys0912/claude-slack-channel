# 開発

このリポジトリに手を入れるときに開く文書。変更を入れる前に、ここのコマンドとテストで確かめる。

## コマンド

```powershell
npm test             # vitest run
npm run typecheck    # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json（本体とテストの両方）
npm run lint         # eslint .（typescript-eslint の型情報付きの推奨ルール。設定は eslint.config.js）
npm run build        # tsc -p tsconfig.json で dist へ出力する
npm run check        # precheck（npm run build）のあと dist/scripts/check.js を実行する
```

GitHub Actions（`.github/workflows/ci.yml`）は、main への push と pull request で動く。windows-latest と ubuntu-latest の両方で、`npm run typecheck`・`npm test`・`npm run lint` を実行する。main へのマージには、この CI の通過が要る。

## テスト

テストは3段階ある。1と2は `npm test` でまとめて実行し、3は手で確かめる。

1. **単体テスト**: 純関数とクラスを単体で確かめる。
   - 対象は `gate` / `format` / `chunk` / `permission` / `screen` / `home` / `allow-rules` / `config` など。
   - I/O は使わないか、一時フォルダーだけを使う。
2. **結合テスト**: 部品をつないで、実際に近い経路を通す。
   - `app.test.ts`: 偽の Slack（`test/helpers/fake-slack.ts`）とインメモリの MCP クライアントで `startBridgeApp` を動かす。Slack イベントの受信から、Claude への通知、ツールの呼び出し、Slack への投稿までを通して確かめる。
   - `mcp.test.ts`: 実際の MCP SDK のクライアントとサーバーをつなぎ、ツールの一覧・呼び出し・通知を確かめる。
   - `download.test.ts`: Windows では実際の `tar.exe` で、次を確かめる。Windows 以外では、tar を使うテストを飛ばす。
     - zip / tar.gz / tar.xz / 7z の展開
     - Zip Slip の拒否
     - 上限を超えたときの中断と後始末
   - `hook.test.ts` / `hook-inbox.test.ts` / `lock.test.ts`: 実際のファイルを読み書きして確かめる。
   - `console-script.test.ts` / `common-script.test.ts`: Windows でだけ、PowerShell のスクリプトを実際に実行して確かめる。
3. **システムテスト（実機）**: 手元の Slack ワークスペースと Claude Code で、機能を入れるたびに確かめる。
   - 状態ディレクトリを分けて、2つのボットのセッションを並べて起動する。どちらのブリッジも Slack に接続すること。
   - DM と許可チャンネルで、受信（👀）とスレッドへの返信が届くこと。
   - 実行許可のボタンが Slack に出ること。
   - `!status` がブリッジの状態を返すこと。手で打った場合と、Slack アプリが代わりに投稿した場合（末尾に署名が付く）の両方で確かめる。
   - `!restart` で再起動すること。会話の記録があれば `--resume` で同じ会話を開き、記録が無ければ新しい会話で起動すること。
   - hook の通知（セッションの開始など）が、そのセッション自身の状態ディレクトリに書かれ、そのボットにだけ出ること。
   - `download_file` で添付を保存・展開できること。保存の前に、実行許可の確認が Slack に出ること。
   - `console.ps1` で複数のキーを送れること、`dialog-answer.ps1` が警告ダイアログに答えること。テストを動かしているコンソールに入力が入らないよう、別のコンソール（`conhost.exe`）を開き、その中で受け取ったキーを記録して確かめる。

## ファイル構成

| パス | 役割 |
|---|---|
| `src/main.ts` | エントリポイント。ロガー・ロック・設定の読み込みと、終了処理 |
| `src/app.ts` | Slack・MCP・実行許可のリレーの配線（通常モードと縮退モード）、MCP ツールと受信イベントの処理、ホームタブの更新 |
| `src/slack.ts` | Slack の Socket Mode での受信と Web API での送信、チャンネルのスレッドの記憶 |
| `src/mcp.ts` | MCP channel サーバー（`reply` / `react` / `edit_message` / `download_file` ツール） |
| `src/permission-relay.ts` | 実行許可のリレーの状態管理（配信・回答・結果の表示への書き換え・自動 deny） |
| `src/permission.ts` | 実行許可のメッセージのブロックの組み立てと、ボタン操作の検証（純関数） |
| `src/session-allow.ts` | 「このセッション中は全部許可」の状態と、ask との照合 |
| `src/gate.ts` | 受信したメッセージを中継すべきかの判定（純関数） |
| `src/watchdog.ts` | Claude の無応答の見張り |
| `src/hook.ts` | Claude Code の hook として起動され、`hooks.jsonl` に1行追記するコマンド |
| `src/hook-event.ts` | `hooks.jsonl` の1行のスキーマ（zod）と型 |
| `src/hook-inbox.ts` | `hooks.jsonl` の増えた分を読み、イベントとして渡す |
| `src/hook-notices.ts` | hook のイベントを Slack の文言にする（純関数） |
| `src/notice.ts` | ブリッジからの通知の投稿（最後のスレッド、無ければ DM） |
| `src/status.ts` | `!status` の文面（純関数） |
| `src/session-control.ts` | `!restart` / `!compact` / `!clear`（再起動フラグと、ターミナルへの決まったコマンドの送信） |
| `src/console.ts` | ターミナル画面の読み取りと選択キーの送信（`scripts/console.ps1` の呼び出し） |
| `src/screen.ts` | 画面のテキストから選択画面を取り出す（純関数） |
| `src/screen-relay.ts` | `!screen` と選択肢ボタンの処理 |
| `src/allow-rules.ts` | 「今後も許可」のルールの生成、危険な操作の除外、deny との照合、保存 |
| `src/rule-relay.ts` | 「今後も許可」の提案・確認と、`!rules` の処理 |
| `src/home.ts` | ホームタブの画面の組み立て（純関数） |
| `src/blocks.ts` | Slack の Block Kit の小さな部品（section、ボタンの文字数の上限） |
| `src/config.ts` | 状態ディレクトリ、`.env` のパーサー、`access.json` の検証 |
| `src/download.ts` | `download_file` の実体（ファイル名の無害化・保存・展開・上限の確認） |
| `src/format.ts` | 送信前のテキストの整形（`@here` などの無害化） |
| `src/chunk.ts` | 長文の分割 |
| `src/lock.ts` | 単一インスタンス実行のファイルロック |
| `src/log.ts` | ログの出力（トークンの伏せ字を含む） |
| `src/errors.ts` | エラーの値を文字列にする helper |
| `src/stdio-guard.ts` | stdout を MCP 専用に保つガード |
| `src/text.ts` | 文字列の小さな整形（BOM の除去・切り詰め・ID の生成） |
| `src/types.ts` | 共有の型 |
| `scripts/check.ts` | `npm run check` の実体（Slack との疎通の確認） |
| `scripts/start.cmd` / `start.ps1` | 起動スクリプト |
| `scripts/common.ps1` | 起動スクリプトの共通の関数（claude.exe の探索、mcp.json の生成、再起動フラグと会話の記録の確認） |
| `scripts/console.ps1` | ターミナル画面の読み取り、キーの送信、決まったコマンド（/exit・/compact・/clear）の送信（ブリッジが子プロセスで実行する） |
| `scripts/dialog-answer.ps1` | 再起動するときの警告ダイアログを画面で見張り、自動で答える（`start.ps1` が起動する） |
| `config/channel-settings.json` | Slack のセッション専用の権限の設定 |
| `config/*.example*` | `projects.json` / `access.json` / `.env` / `extra-mcp.json` のひな形 |
| `slack-app-manifest.yaml` | Slack アプリの manifest |
| `test/*.test.ts` | vitest のテスト |
| `test/helpers/fake-slack.ts` | Slack の Web API / Socket Mode の差し替え（`slack.test.ts` / `app.test.ts` で共用） |
| `test/fixtures/chunk-legacy.ts` | 分割前の `chunkText` の実装。`chunk-legacy.test.ts` で出力が一致することを確かめる |
| `tsconfig.json` | 本体（`src` / `scripts`）のビルドの設定 |
| `tsconfig.test.json` | テストを含めた型検査用の設定（出力なし） |
| `vitest.config.ts` | vitest の設定 |
| `eslint.config.js` | eslint の設定（flat config） |
