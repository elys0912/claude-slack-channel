# claude-slack-channel

Slack の DM をローカルで動いている Claude Code のセッションへ中継する MCP channel サーバー。
Slack から話しかけると、手元の `claude.exe` セッションが応答する。
返信・リアクション・実行許可の確認まで、Slack 側だけで完結する。

## 仕組み

```
Slack (DM)
   │  Socket Mode（WebSocket、外向きの穴あけ不要）
   ▼
claude-slack-channel（このリポジトリ / dist/src/main.js）
   │  MCP（標準入出力・experimental "channels" 機能）
   ▼
Claude Code（claude.exe、手元のセッション）
```

- Slack 側の送受信は Socket Mode（Slack → サーバーへの Web hook 受信ではなく、サーバー側から
  WebSocket を張りに行く方式）なので、ポート開放やトンネルは不要。
- このサーバーは MCP の channel サーバーとして Claude Code に読み込まれ、Slack のメッセージを
  Claude のセッションへ直接注入する。Claude からの返信・リアクション・メッセージ編集は
  `reply` / `react` / `edit_message` の3ツールとして Claude 側から呼び出される。
- ファイル書き込みなどの実行許可（permission）が必要な操作は、通常ならローカルの確認ダイアログに
  出るところを、Slack のボタンまたは `yes xxxxx` / `no xxxxx` の返信でも承認・拒否できる。

## 必要なもの

- Node.js 22.12 以上
- Claude Code v2.1.234 以上（Slack 側での実行許可承認に必要）
- Claude の Pro 以上のサブスクリプション
- Slack ワークスペースの管理権限（アプリのインストールに必要）

## セットアップ手順

### 1. 依存関係のインストールとビルド

```
npm install
npm run build
```

`dist/src/main.js` が作られる。以後 `scripts\start-portfolio.cmd` から起動できる。

### 2. Slack アプリを manifest から作る

[api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
を選び、対象のワークスペースを選択してから、このリポジトリの `slack-app-manifest.yaml` の中身を
貼り付けて作成する。DM 専用・Socket Mode 有効・必要最小限のスコープ（`chat:write` /
`im:history` / `im:write` / `reactions:write`）だけを持つアプリができる。

### 3. App-Level Token（`connections:write`）の発行

作成したアプリの **Basic Information** → **App-Level Tokens** から **Generate Token and Scopes**
を選び、スコープに `connections:write` を追加してトークンを発行する。ここで発行される
`xapp-` から始まるトークンが Socket Mode の接続に使う `SLACK_APP_TOKEN`。

### 4. ワークスペースへのインストールとスコープの確認

**OAuth & Permissions** → **Install to Workspace** でインストールする。完了すると
`xoxb-` から始まる Bot User OAuth Token が発行される。これが `SLACK_BOT_TOKEN`。
**Scopes** の欄に manifest 通りの4つ（`chat:write` / `im:history` / `im:write` /
`reactions:write`）が入っているか確認する。

### 5. 自分の member ID の調べ方

Slack のワークスペースで自分のプロフィールを開き、**その他** メニューから
**メンバーIDをコピー** を選ぶ（`U` から始まる ID）。この ID を `access.json` の
`allowFrom` に入れる。ここに入っていない相手からの DM は無視される。

### 6. `.env` と `access.json` をメモ帳で作る

状態ディレクトリは既定で `%USERPROFILE%\.claude\channels\slack`（`SLACK_CHANNEL_STATE_DIR`
環境変数で変更可）。ここに次の2ファイルを作る。

`%USERPROFILE%\.claude\channels\slack\.env`（`config\env.example` の形式）:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
```

`%USERPROFILE%\.claude\channels\slack\access.json`（`config\access.example.json` の形式）:

```json
{
  "teamId": "T00000000",
  "allowFrom": ["U00000000"]
}
```

**Claude に作らせない理由**: この2ファイルはトークンと許可リストそのもので、Claude Code の
プロジェクトディレクトリの外・状態ディレクトリに置く。Claude（このリポジトリの他のセッション
含む）にトークンを扱わせると、ログや会話履歴に混入する経路が増える。手で作り、Claude には
存在確認（中身は読まない）だけさせる設計にしている。

### 7. `npm run check` で確認する

```
npm run check
```

`auth.test` を呼び、ワークスペース名・team ID・ボットの user ID を表示する。`access.json` の
`allowFrom` があれば、そこに書いた ID の表示名も引いて出す（失敗しても止まらない）。
`access.json` の `teamId` と実際の `team_id` が食い違っていれば警告が出る。
**トークンそのものは画面に出ない**（`xoxb-***` のように接頭辞だけ表示する）。

### 8. 起動する

**Windows Terminal から**（VS Code 拡張の中の統合ターミナルでは動かない。理由は
[権限の設計](#権限の設計)を参照）:

```
C:\dev\claude-slack-channel\scripts\start-portfolio.cmd
```

既定では `C:\dev\portfolio` で起動する。別のディレクトリで起動したい場合:

```
scripts\start-portfolio.cmd -Project C:\path\to\project
```

起動のたびに全画面の警告ダイアログ（experimental channels の確認）が出るので、
**「1」（I am using this for local development）を選ぶ**。

## 使い方

Slack のアプリ一覧からこのボットに DM を送ると、手元のセッションに届く。返信は元のメッセージの
スレッドに返る。ファイル編集など実行許可が必要な操作は、Slack にボタン付きメッセージが届くので
ボタンで答えるか、`yes xxxxx` / `no xxxxx`（`xxxxx` は表示された5文字の ID、`l` を除く
`a-z` のみ）で返信する。

セッションは1つで、Slack 側から複数の会話を並行して持てるわけではない。文脈は共有される。
**Slack からは `/clear` できない**（ローカルのターミナルで操作する必要がある）。

## 権限の設計

起動スクリプトは Claude Code を次のフラグで起動する。

```
--mcp-config config\mcp.portfolio.json
--setting-sources project,local
--settings config\channel-settings.json
--permission-mode default
--dangerously-load-development-channels server:slackbridge
```

- **`--setting-sources project,local`**: ユーザー設定（`~/.claude/settings.json`）を
  読み込まない。ユーザー設定には便利さのために緩い許可（`Bash(*)` や `Write` の無確認実行など）
  が入っていることが多く、Slack 経由で届く指示がそれに乗って無確認で実行されるのを防ぐ。
- **`--settings config\channel-settings.json`**: channel セッション専用の許可リストを、
  ユーザー・プロジェクト・ローカルのどの設定より上位に重ねて適用する。

`config/channel-settings.json` の内訳:

- `allow`: `Read` / `Glob` / `Grep`（読み取り全般）、このサーバー自身の3ツール
  （`reply` / `react` / `edit_message`）、`git status` / `git diff` / `git log`
  （Bash・PowerShell 両方の形で登録。Windows では既定でどちらのツールが使われるか
  環境依存のため）。
- `deny`: 状態ディレクトリ（`~/.claude/channels/**`）そのものへの読み書き、
  `~/.claude.json`、`~/.ssh/**`、プロジェクト内の `.env` 系ファイル、
  `git push --force` / `-f`、`git reset --hard`。
- `permissions.disableBypassPermissionsMode: "disable"`: `bypassPermissions`
  モードへの切り替えを禁止する。
- `disableClaudeAiConnectors: true`: claude.ai 側の connector を取得しない。

deny ルールは allow ルールより必ず優先される（Claude Code の評価順は deny → ask → allow）ので、
上の allow に `Read` を許可していても、deny に挙げたパスは読めない。

> **制限**: `Bash(git push --force:*)` の deny は、`sh -c 'git push --force ...'` のような
> 間接呼び出しを塞がない（Claude Code のパターンマッチの既知の制限）。channel セッションの
> allow には `Bash(*)` が入っていないため `sh -c` 自体が確認待ちになるが、迂回が不可能なわけ
> ではない。

起動には Windows Terminal から `claude.exe` を直接叩く運用にしている。VS Code 拡張の中の
統合ターミナルでは、`--dangerously-load-development-channels` の起動時警告ダイアログや
channels（experimental）の動作を確認できていない（`docs/phase0.md` のスパイクは素の
ターミナルで検証したもの）ため、対象外にしている。

## セキュリティ

- 送信者の許可判定は Slack のユーザー ID（`access.json` の `allowFrom`）で行う。表示名や
  メールアドレスでは判定しない。
- トークン（`SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`）は状態ディレクトリの `.env` だけに置く。
  環境変数にも `mcp.portfolio.json` にも書かない。
- Slack から届くメッセージは信頼できない入力として扱う。届いた指示をそのまま実行するかどうかは
  上記の権限設計（deny 優先、ユーザー設定を読まない）で制限している。

### トークンが漏れたときの手順

1. [api.slack.com](https://api.slack.com/apps) でアプリを開き、**Basic Information** →
   **App-Level Tokens** から該当トークンを **Revoke**。
2. **OAuth & Permissions** でボットトークンを失効させる（またはアプリを一度アンインストールして
   再インストールし、新しいトークンを発行する）。
3. `%USERPROFILE%\.claude\channels\slack\.env` を新しいトークンで書き直す。
4. `npm run check` で疎通を確認してから、`scripts\start-portfolio.cmd` で再起動する。

### 許可リストから外すときの手順

`access.json` の `allowFrom` から該当の member ID を削除して保存する。サーバーは起動中の
ファイル内容までは自動で再読み込みしないため、反映するにはセッションを再起動する。

## トラブルシューティング

- **ログ**: `%USERPROFILE%\.claude\channels\slack\logs\bridge.log`。トークンはログ内で
  マスクされる（`xoxb-***` 等）。
- **二重起動**: `instance.lock` により多重起動は検知される。別インスタンスが動いている場合、
  新しいプロセスは Slack には接続せず MCP サーバーのみを縮退モードで起動する
  （ツール呼び出しはエラーを返す）。
- **`invalid_auth`**: `SLACK_BOT_TOKEN` が無効。`npm run check` で確認し、トークンを
  取り直す。
- **`missing_scope`**: OAuth スコープが不足している。**OAuth & Permissions** で
  `slack-app-manifest.yaml` 記載の4スコープが揃っているか確認し、揃っていなければ
  再インストールする。
- **再接続 / スリープで切れる**: Socket Mode はスリープ復帰後に自動再接続を試みるが、
  しばらく応答が無い場合はログを確認し、必要なら起動し直す。
- **接続状態の確認**: セッション内で `/mcp` を実行すると `slackbridge` の接続状態が見える。
- 実機での動作確認手順やチェックリストは [docs/phase0.md](docs/phase0.md) を参照
  （echo channel を使ったスパイクの手順で、Slack を使わずに channels 機能自体の動作確認ができる）。

## 開発

```
npm test         # vitest（159件）
npm run typecheck # tsc --noEmit
```

### ファイル構成

- `src/main.ts` — エントリポイント。stateDir・ロック・トークン読み込み・Slack/MCP の配線
- `src/config.ts` — stateDir・`.env` パーサー・`access.json` のスキーマ検証
- `src/slack.ts` — Slack Socket Mode / Web API まわり
- `src/mcp.ts` — MCP channel サーバー（`reply` / `react` / `edit_message` ツール）
- `src/gate.ts` — 受信メッセージを中継すべきか判定する純関数群
- `src/permission.ts` — 実行許可リレー（Slack のボタン・`yes/no` 返信）のロジック
- `src/format.ts` — メッセージ整形（`@here` 等のブロードキャスト無害化など）
- `src/chunk.ts` — 長文の分割送信
- `src/lock.ts` — 単一インスタンス実行のファイルロック
- `src/log.ts` — ログ出力（トークンのマスク込み）
- `src/stdio-guard.ts` — stdout を MCP 専用に保つためのガード
- `src/types.ts` — 共有型定義
- `scripts/check.ts` — `npm run check` の実体。Slack への疎通確認
- `scripts/start-portfolio.ps1` / `start-portfolio.cmd` — 起動スクリプト
- `config/channel-settings.json` — channel セッション専用の権限設定
- `config/mcp.portfolio.json` — `--mcp-config` に渡す MCP サーバー定義
- `config/access.example.json` / `config/env.example` — `access.json` / `.env` のひな形
- `slack-app-manifest.yaml` — Slack アプリの manifest
- `docs/phase0.md` — channels 機能そのものの実機確認手順（スパイク）
