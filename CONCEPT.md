# minimal-ai-agent のコアコンセプト

Slack を入口とする個人アシスタント Agent。Google Calendar を読み、Gemini で「次のアクション」を決め、
Slack で対話し、外部への作用には人間の承認を挟む。

このドキュメントは **AIエージェントを自作するときに何をどう決めるか** だけを扱う。
実装は `git log` を古い順に読めば、この順序どおりに積み上がっている。

---

## 1. 何を作るか

「1 ユーザー = 1 Agent インスタンス」を Cloudflare の Durable Object 上に常駐させ、
そこに状態・タスク台帳・スケジュールをすべて閉じ込める。中央 DB も cron 用の別 Worker も置かない。

```
Slack Events ───────▶┐   Cloudflare Worker (src/index.ts)  ← Gateway
Slack Interactivity ─┘   ・Slack 署名検証
                         ・URL 検証チャレンジ応答
                         └─▶ PersonalAssistantAgent (src/agent.ts)  一意名 "ai-agent"
                              ├─ this.state       … 設定 / 自律レベル / 学習済み Slack ID
                              ├─ this.sql (SQLite)… tasks / task_events / user_decisions
                              ├─ schedule()       … heartbeat（2 時間ごと自律チェック）
                              ├─ Gemini API       … 次アクションを structured JSON で生成
                              ├─ Google Calendar  … 直近予定の読み取り / 予定の作成
                              └─ Slack API        … 投稿 / 承認ボタン (Block Kit)
```

**Worker はゲートウェイに徹する。** 署名検証と URL ルーティングだけを担当し、検証済みの payload だけを
Agent に渡す。ビジネスロジックはすべて Agent 側に集約する。

---

## 2. 4 つの設計原則

### 原則 1. 1 ユーザー = 1 Agent。すべてを 1 つのプロセスに閉じ込める

個人アシスタントの本質は「一人のユーザーに関する状態の継続」である。
であれば、状態・タスク台帳・スケジュール・会話履歴を 1 つの Durable Object に集約するのが最も単純になる。

- 中央 DB（D1 等）を置かない。Agent ローカルの SQLite が台帳そのもの。
- cron 用の別 Worker を置かない。Agent 自身の `schedule()` が目覚まし時計。
- 排他制御を考えない。Durable Object の単一実行モデルが直列化を保証する。

分散させる理由が生まれるまで分散させない。個人利用にスケーラビリティは不要で、
失って困るのは「単純さ」の方である。

### 原則 2. LLM は頭脳、コードは手足

Gemini の役割は **「状況を見て、次に取るべきアクションを決める」ことだけ** に限定する。

- LLM の出力は structured output で強制した **閉じたアクション語彙** の JSON のみ。自由文をパースしない。
- アクションの **実行** はすべて TypeScript コードが担う。DB 書き込み・Slack 投稿・カレンダー操作は
  決定的なコードパスであり、LLM は一切触れない。
- 新しい能力を足すとき増えるのは「アクションの種類」であって、LLM への信頼ではない。

これにより、LLM の間違いは「不適切なアクションの選択」に限定され、それは次の原則で抑え込める。

### 原則 3. 外部作用には必ず人間を挟む（human-in-the-loop）

実世界に影響する操作（カレンダーへの予定作成など）は、LLM がどれだけ確信していても
**必ず承認ボタンを経由** する。

- 外部作用アクションは即実行せず `waiting_user` のタスクとして台帳に保存し、Slack に承認/却下ボタンを出す。
- 承認されて初めて `approved → executing → done/error` と進み、保存しておいたペイロードをコードが実行する。
- 却下も記録する。これが後の学習材料になる。

自律性は「ユーザーが承認の手間より信頼を選んだとき」に段階的に上げるものであり、
初期値は常に最も保守的にする（`autonomyLevel: "suggest"`）。

### 原則 4. 安全側に倒す

判断に迷う箇所はすべて保守的な既定値を選ぶ。

- **所有者 allowlist**: 最初に話しかけてきたユーザーを所有者として学習し、以後それ以外の入力は拒否する。
- **fail-closed**: 署名検証できない Slack リクエストは拒否する。
- **既定は控えめに**: 自律動作の頻度は 2 時間間隔。設定ミスで連投・課金・枠の枯渇が起きる方向には倒さない。
- **壊れても止まらない**: Gemini 呼び出しの失敗は空アクションに、Calendar 未設定は空配列に落とす。
  個々の連携が落ちても Agent 全体は生き続ける。

---

## 3. 状態の 3 層

| 置き場所 | 用途 | 例 |
|---|---|---|
| `this.state`（永続 JSON） | 設定・軽量な学習値 | 自律レベル、タイムゾーン、所有者の Slack User ID / Channel ID |
| `this.sql`（ローカル SQLite） | 台帳・履歴 | `tasks` / `task_events` / `user_decisions` |
| メモリ変数 | isolate 内キャッシュのみ | Google アクセストークンの短期キャッシュ |

中央 DB は「複数 Agent 横断の管理画面」「分析集計」「バックアップ」が必要になったら
**後から同期先として足す**方針とし、ここでは使わない。

---

## 4. 3 つの処理フロー

### フロー A: Slack から話しかけられたとき（イベント駆動）

```
Slack → Worker：署名検証 → 検証済み payload を Agent へ
Agent：Bot 自身の投稿は無視（無限ループ防止）
      初回なら発言者を所有者として学習（bootstrap）、以後は allowlist で他人を拒否
      投稿元チャンネルを state に記憶（返信先）
Agent → Calendar：直近予定を取得
Agent → Gemini：メッセージ＋台帳＋予定を渡し、アクション配列を JSON で要求
Gemini → Agent：{ actions: [...] }
Agent：applyActions() でタスク登録 or Slack 返信 or 承認依頼
```

Slack の 3 秒ルールに対しては、Worker が即 `200 OK` を返し、実処理は `ctx.waitUntil()` で背後に逃がす。

### フロー B: heartbeat（自律ループ）

```
schedule → heartbeat()：2 時間ごとに起床
Agent → SQLite：未処理タスク（open / waiting_user）を取得
Agent → Calendar：直近予定を取得
Agent → Gemini：状況を渡して次アクションを計画
Agent：applyActions() で反映
Agent → schedule：次回 heartbeat を再登録（finally で必ず実行し、鎖を切らさない）
```

### フロー C: 承認ボタン（human-in-the-loop）

```
外部作用アクション → waiting_user で台帳に保存（payload_json に実行内容）
                  → Slack に「承認 / 却下」ボタン付きメッセージ (Block Kit)
ユーザーがボタン押下 → Slack Interactivity → Worker：署名検証
Agent.handleSlackInteraction：所有者か確認 → tasks.status を approved/rejected に更新
                              → user_decisions に記録
                              → 承認なら executeTask() が payload を実行
                              → response_url で元メッセージを結果テキストに置換
```

---

## 5. タスクの状態機械

```
open ──(承認依頼)──▶ waiting_user ──(approve)──▶ approved ──▶ executing ──▶ done
                          │                                              └──▶ error
                          └──(reject)──▶ rejected
```

外部作用を持つアクションは `open` を経由せず、最初から `waiting_user` で登録される。

---

## 6. アクション語彙（4 種）

LLM に返させる structured output のスキーマ。**スキーマ設計 = エージェントの行動空間の設計**である。

| アクション | 意味 | 副作用 | 承認 |
|---|---|---|---|
| `reply` | 質問への回答・情報提供 | Slack 投稿 | 不要 |
| `ask_user` | ユーザーに確認・判断を求める | Slack 投稿 | 不要 |
| `create_task` | タスクを台帳に登録 | SQLite INSERT | `requires_user_approval` 次第 |
| `create_event` | カレンダーに予定を作成 | **Google Calendar 書き込み** | **必須** |

union 型は使わず「`type` フィールドで分岐する 1 種類のオブジェクト」に寄せている。
Gemini の `responseSchema` は OpenAPI サブセットで、`oneOf` の扱いがモデルによって不安定なため。

**能力を足す = アクションを足す** であって、LLM への指示を増やすことではない。

---

## 7. この repo の読み方

`git log --oneline --reverse` がそのまま目次になっている。

| # | commit | 学べること |
|---|---|---|
| 01 | コアコンセプトと読み方 | このドキュメント |
| 02 | Worker + Agent の骨組み | Agents SDK の Agent と Durable Object の関係、`this.state` |
| 03 | Task Ledger（Agent ローカル SQLite） | `this.sql`、状態機械をテーブルで表す |
| 04 | Gemini を薄いラッパーに隔離し、アクション語彙を閉じる | structured output、LLM の交換可能性 |
| 05 | Slack 入口（署名検証・3 秒ルール・所有者の自動学習） | Gateway と Agent の責務分離、fail-closed |
| 06 | applyActions — LLM の出力を副作用に変える翻訳層 | エージェントの心臓部。ここに副作用を一点集中させる |
| 07 | heartbeat — schedule() による自律ループ | イベント駆動と自律ループが同じ状態を共有する |
| 08 | Google Calendar 読み取り（サービスアカウント + JWT 自前署名） | 外部サービスとの境界（信頼と認証） |
| 09 | human-in-the-loop — 承認ボタンと状態機械 | 人間はシステムの外ではなく中にいる |
| 10 | セットアップ手順 | 動かし方 |

各 commit は単体で型チェックが通る。`git checkout <commit>` して読み進められる。
