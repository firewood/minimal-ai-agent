# minimal-ai-agent

雑誌記事「**エージェント自作で学ぶLLMの組み込み方**」の解説用リポジトリ。

Cloudflare Agents SDK + Gemini API + Slack + Google Calendar で、
「先回りして動く個人アシスタント Agent」を作る。実装は 9 ファイル・約 1,140 行
（解説コメントを含めて 1,780 行）。テストは別に 5 ファイル・約 490 行。

```
Slack Events ───────▶┐   Cloudflare Worker (src/index.ts)  ← Gateway
Slack Interactivity ─┘   ・Slack 署名検証
                         └─▶ PersonalAssistantAgent (src/agent.ts)  一意名 "ai-agent"
                              ├─ this.state       … 設定 / 所有者の Slack ID
                              ├─ this.sql (SQLite)… tasks / task_events
                              │                     processed_events / user_decisions
                              ├─ schedule()       … heartbeat（2 時間ごと自律チェック）
                              ├─ Gemini API       … 次アクションを structured JSON で生成
                              ├─ Google Calendar  … 予定の読み取り / 作成
                              └─ Slack API        … 投稿 / 承認ボタン (Block Kit)
```

## このリポジトリの読み方

**`git log` が記事の目次になっている。** 古い commit から順に、記事の各節に対応した
1 つの概念だけを足していく。

```bash
git log --oneline --reverse
```

まず [CONCEPT.md](./CONCEPT.md) を読む。設計判断（何を LLM に任せ、何をコードで制御するか）が
そこに全部書いてある。そのあと commit を順に追うと、その設計がコードとして立ち上がっていく。

各 commit は単体で型チェックが通るので、`git checkout <commit>` して読み進められる。

| ファイル | 役割 |
|---|---|
| `src/index.ts` | Worker（ゲートウェイ）。署名検証とルーティングだけ |
| `src/agent.ts` | Agent 本体。状態・台帳・スケジュール・アクションの実行 |
| `src/actions.ts` | 行動空間。`Action` 型・スキーマ・LLM 出力の検証（純関数） |
| `src/llm.ts` | LLM との契約（型のみ）。アダプタが満たすべき形 |
| `src/gemini.ts` | 契約の実装。structured output で JSON を強制 |
| `src/slack.ts` | Slack 署名検証（Web Crypto のみ） |
| `src/google.ts` | Google Calendar（サービスアカウント + JWT 自前署名） |
| `src/log.ts` | ログレベルの判定と整形 |
| `src/task-prefix.ts` | 行頭 `TODO:` の解析。LLM を通さない唯一の経路 |
| `test/*.test.ts` | 純関数のテスト。`node --test` で走る（テスト用の依存は無い） |

---

## テスト

```bash
pnpm test        # node --test test/*.test.ts
pnpm typecheck
```

Node 24 が `.ts` をそのまま実行できるので、`node:test` と `node:assert` だけで足りる。
vitest も設定ファイルも無い。

対象は Workers ランタイムに依存しない部分に絞ってある。

| テスト | 守っているもの |
|---|---|
| `test/actions.test.ts` | LLM 出力の関所。`{"type":"reply"}` のような「スキーマは通るが成立していない」出力を捨てること。**スキーマの `enum` と `toAction` の分岐がずれたら落ちる**ので、アクションを増やすとき片方を忘れられない |
| `test/slack.test.ts` | 署名検証。改竄・リプレイ・ヘッダ欠落、そして**シークレット未設定で拒否**すること（fail-closed が逆に倒れても正常時の動作は変わらないので、テストでしか気づけない） |
| `test/task-prefix.test.ts` | `TODO:` の解析。拾うべきものと、拾ってはいけないもの（件数・長さの上限を含む） |
| `test/gemini.test.ts` | LLM 境界の契約。`fetch` を差し替え、`responseSchema` を必ず送ること、`parse` にパース済みの値が渡ること、失敗時に投げること |

**Durable Object の中（`applyActions` / 状態機械 / 重複排除）はテストしていない。** workerd が必要で、
`@cloudflare/vitest-pool-workers` を入れることになるため。ここは `pnpm dev` での手動確認に頼っている。

---

## セットアップ

### 0. 依存のインストールと型生成

```bash
pnpm install
pnpm exec wrangler types    # worker-configuration.d.ts を生成（gitignore 済み）
pnpm exec tsc --noEmit      # 型チェック
```

> `wrangler types` を実行しないと `Cloudflare.Env` が未定義で型が通らない。
> 生成物（500KB超）なのでリポジトリには含めていない。

### 1. Gemini API キー

[Google AI Studio](https://aistudio.google.com/apikey) でキーを発行する。無料枠で動く
（ただし 1 日あたりのリクエスト上限があるので、heartbeat の間隔を短くしすぎないこと）。

### 2. 先にデプロイして公開 URL を確定する

Slack の Request URL には**公開 URL が必要**で、`wrangler dev`（localhost）には届かない。
先にデプロイして `*.workers.dev` の URL を得るのが最短。

```bash
pnpm exec wrangler login    # 初回のみ
pnpm exec wrangler deploy
```

表示された `https://minimal-ai-agent.<your-subdomain>.workers.dev` を控える。

### 3. Slack App を作る

1. https://api.slack.com/apps → **Create New App** → **From a manifest**
2. ワークスペースを選択
3. [`slack-app-manifest.json`](./slack-app-manifest.json) を貼り付ける。
   **`YOUR-SUBDOMAIN` を手順 2 の実際のサブドメインに置換する**（2 箇所）
4. 作成

> 作成時に Slack が即 URL 検証を試みるが、まだ Signing Secret を登録していないので
> **ここでは検証が失敗してよい**（`url_verification` も署名付きで届くため）。

### 4. シークレットを登録して再デプロイ

- **Signing Secret**: App の *Basic Information* → *App Credentials*
- **Bot Token**: *OAuth & Permissions* → *Install to Workspace* → `xoxb-...`

```bash
pnpm exec wrangler secret put SLACK_SIGNING_SECRET   # 署名検証に必須。先に入れる
pnpm exec wrangler secret put SLACK_BOT_TOKEN
pnpm exec wrangler secret put GEMINI_API_KEY
pnpm exec wrangler deploy                            # シークレット反映のため再デプロイ
```

そのうえで App の *Event Subscriptions* を開き、Request URL の **Retry / Verify** を押す。
Worker が署名検証 → `challenge` 返却を行い **Verified** になれば OK。

### 5. Google Calendar（サービスアカウント方式）

対話型 OAuth ではなく、サービスアカウントにカレンダーを共有する方式を使う。
ブラウザ認証もトークン失効もない。

1. [GCP Console](https://console.cloud.google.com/) でプロジェクトを作成
2. **APIs & Services → Library** で **Google Calendar API** を *Enable*
3. **Credentials → Create Credentials → Service account** を作成（ロール付与は不要）
4. そのサービスアカウント → **Keys → Add key → Create new key → JSON** をダウンロード
5. [Google Calendar](https://calendar.google.com/) → 対象カレンダーの **設定と共有** →
   **特定のユーザーと共有** に JSON の `client_email`（`xxx@yyy.iam.gserviceaccount.com`）を追加。
   権限は **「予定の変更権限」**（`create_event` で予定を作るため）
6. 同じ画面の **カレンダーの統合** にある **カレンダー ID** を控える（通常は自分のメールアドレス）

```bash
pnpm exec wrangler secret put GOOGLE_SERVICE_ACCOUNT_EMAIL   # client_email
pnpm exec wrangler secret put GOOGLE_PRIVATE_KEY             # private_key
pnpm exec wrangler secret put GOOGLE_CALENDAR_ID             # カレンダー ID
pnpm exec wrangler deploy
```

> **`GOOGLE_PRIVATE_KEY` の貼り方**: JSON の `private_key` は
> `-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n` の形。
> `\n` がエスケープされたまま貼っても `src/google.ts` の `pemToPkcs8` が実際の改行に正規化する。
> JSON 値のダブルクオートは外して中身だけ貼ること。

### ローカル開発

```bash
cp .dev.vars.example .dev.vars   # 値を入れる
pnpm exec wrangler dev
```

Slack からのイベントは届かないが、Agent の起動・SQLite の初期化・型の確認はできる。

---

## 動作確認

### フロー A: Slack から話しかける

Bot に DM するか、チャンネルに招待して `@minimal-ai-agent こんにちは` とメンションする。

- 初回メッセージで、発言者が**所有者**として、そのチャンネルが**返信先**として自動学習される
- 2 回目以降は所有者以外のメッセージを拒否する
- 「今日の予定は？」と聞くと、カレンダーを読んだうえで Gemini が答える

### フロー B: heartbeat（自律ループ）

2 時間ごとに Agent が自分で起きて、台帳と予定を点検する。見るのは点検リスト
（期限超過 → 24 時間以内の期限 → 止まっている承認 → 着手されていないタスク →
予定に関連するタスク）で、該当したものを 1 通にまとめて `show_task` を添えて出す。

該当が無ければ黙る。**台帳に未完了タスクが 1 件も無ければ何も言わない**（先回りの材料は台帳で、
賑やかしに予定を読み上げることはしない）。夜間（22-7 時）は、期限を過ぎたものが無ければ
LLM を呼ばずに終わる。

```bash
pnpm exec wrangler tail   # ログを監視
```

すぐ試したいときは `src/agent.ts` の `HEARTBEAT_INTERVAL_MIN` を一時的に `15` にして再デプロイする。

### フロー C: 承認ボタン（human-in-the-loop）

Slack で「明日 15 時に打ち合わせを入れて」と依頼する。

1. Gemini が `create_event` を返す
2. 即実行はされず、`waiting_user` のタスクとして台帳に保存され、**承認 / 却下ボタン**が届く
3. **承認**を押すと `approved → executing → done` と進み、Google Calendar に予定が入る。
   元メッセージが「✅ 承認しました: …」に置き換わる
4. **却下**を押すと `rejected` になり、`user_decisions` に記録される

### `TODO:` で確実に登録する

```
TODO: 請求書を送る
やること：会場を予約する
```

行頭にこの書式で書くと、**LLM を通さず**書いたとおりのタスクが登録される。複数行書けば
複数タスクになる。ログに `command.recognized` が出て `llm.prompt` が出ないのが目印。

自由文で「◯◯をタスクに入れて」と頼むこともできるが、そちらは LLM の解釈が入るので、
タイトルが言い換えられたり「登録しますか?」と聞かれたりする。確実に入れたいときは `TODO:` を使う。

### タスクのチェックボックス

「◯◯をタスクに入れておいて」と依頼すると、平文の「登録しました」ではなく
**チェックボックス 1 個**が届く。チェックすればその場で `done` になり、ラベルが打ち消し線に変わる。
外せば `open` に戻る。

「今のタスクは?」と聞いたときや heartbeat の注意喚起でも、Gemini が `show_task` を返して
同じチェックボックスを再掲する。通知して終わりにせず、その場で状態を進められる形で出す。

### ログを見る

流れているところを見るなら `wrangler tail`、**問題が起きた後から**見るなら Cloudflare の
ダッシュボード（Workers → `minimal-ai-agent` → Logs）を使う。`wrangler.jsonc` で
observability を有効にしてあるので、`console` の出力はそちらに保存されている
（保持期間は Free 3 日 / Paid 7 日）。

```bash
pnpm exec wrangler tail        # ライブ
```

既定の `LOG_LEVEL` は `verbose`。**中で何が起きているかを読めることがこのサンプルの目的**なので、
最初から「何を受け取り、LLM がどう解釈し、何を実行しようとしたか」が段ごとに出る。

| 段 | イベント | 内容 |
|---|---|---|
| 受信 | `slack.http` | `event_id` と Slack のリトライヘッダ。同じ発言が二重に処理される不具合はまずここを見る |
| | `slack.recv` | 受け取った本文・チャンネル・スレッド・`ts` |
| | `slack.duplicate` | 二重に届いた発言を弾いたとき（`info` レベル） |
| | `heartbeat.quiet` | 静音時間（22-7 時）に起きたが、期限超過が無いので LLM を呼ばず終わったとき（`info` レベル） |
| | `heartbeat.empty_talk` | タスクを伴わない自発的発言（状況の読み上げ）を落としたとき（`info` レベル）。続くならプロンプトを見直す |
| 解釈 | `command.recognized` | `TODO:` のような明示コマンドを拾ったとき。これが出たら LLM は通らない |
| | `llm.prompt` | LLM に送った全文（コンテキスト込み） |
| | `llm.actions` | 返ってきたアクション配列（検証を通ったものだけ） |
| | `llm.actions.invalid` | スキーマは通ったが `Action` として成立せず捨てた要素（`error` レベル）。出続けるならプロンプトかスキーマの問題 |
| 実行 | `apply.action` | 副作用に変える直前のアクション |
| | `slack.post` | 投稿した本文 |

`llm.prompt` と `llm.actions` を突き合わせれば、LLM の判断が悪いのかプロンプトが悪いのかを
切り分けられる。

静かにしたいときは `wrangler.jsonc` の `LOG_LEVEL` を `info`（重要な出来事だけ）または
`error`（失敗だけ）に書き換えて再デプロイする。

> **日常的に使うなら `info` に落とす。** `verbose` はカレンダーの内容やタスク名を
> そのままログに載せる。

### つまずいたとき

| 症状 | 原因 |
|---|---|
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | 公開から 7 日経っていないパッケージ。数日待つか、`pnpm-workspace.yaml` の `minimumReleaseAge` を一時的に下げる |
| `Slack postMessage failed: not_in_channel` | Bot をチャンネルに招待していない |
| `Calendar API error 404` | カレンダー ID が違う / 共有できていない |
| `Calendar API error 403` | 共有権限が「予定の変更権限」になっていない |
| `Google token error 401` | `GOOGLE_PRIVATE_KEY` / `client_email` が不正 |
| `Gemini API error 429` | 無料枠のレート上限。少し待つか翌日 |
| Slack が 401 を返す | `SLACK_SIGNING_SECRET` 未設定（fail-closed で拒否している） |
