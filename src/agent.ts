import { Agent } from "agents";
import { generate } from "./gemini";
// 行動空間の宣言（型とスキーマ）は actions.ts にまとめてある。
import { ACTIONS_SCHEMA, type Action } from "./actions";

// Cloudflare.Env は `wrangler types` が生成する（worker-configuration.d.ts）。
// Durable Object のバインディングはそこで型付け済みなので、ここではシークレットだけ足す。
export type Env = Cloudflare.Env & {
  GEMINI_API_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  // Google Calendar（サービスアカウント方式）
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CALENDAR_ID: string;
};

/**
 * 状態の 3 層のうち第 1 層（CONCEPT.md 参照）。
 * 永続 JSON。設定と、軽量な「学習値」だけを置く。
 * 台帳や履歴はここではなく this.sql（第 2 層）に置く。
 */
export type AssistantState = {
  // suggest: 提案のみ / draft: 下書きまで / approve_execute: 承認後に実行。
  // 初期値は最も保守的な suggest（CONCEPT.md 原則 3「human-in-the-loop」）。
  autonomyLevel: "suggest" | "draft" | "approve_execute";
  timezone: string;
  // 所有者の Slack User ID。プレースホルダのままなら未学習。
  // 最初に話しかけてきたユーザーを所有者として学習する。
  slackUserId: string;
  // 返信先チャンネル。Slack で話しかけられたときに覚え、
  // 自発的に投稿するときにも使う。
  slackChannelId?: string;
};

const SYSTEM_PROMPT = `あなたは個人アシスタント（秘書）Agent です。
毎回のプロンプトには「未完了タスク」のコンテキストが与えられます。
これらを踏まえ、次に取るべきアクションを JSON で返します。

# アクションの使い分け
- 質問への回答や情報提供は reply。コンテキストの台帳を根拠に具体的に答える。
  ユーザーの発言をそのまま繰り返さない。付け加えることが無いなら、次の一歩を短く示す。
- ユーザーに確認・判断を求める問いかけは ask_user。
- create_task はユーザーが明示的に依頼したときだけ使う。推測でタスク化しない。
  実行前に承認が要るものは requires_user_approval=true にする。
- カレンダーに予定を追加すべきときは create_event（title と start[ISO8601] は必須）。
  実世界に作用するため必ず承認を挟む。曖昧なら ask_user で確認する。
- すでに台帳にあるものを重複して作らない。
- 何もする必要がなければ actions は空配列にする（無意味な発信をしない）。

日本語で簡潔に。`;

/**
 * 個人アシスタント Agent。
 *
 * Agents SDK の Agent は SQLite-backed Durable Object の上に載っており、
 * インスタンスごとに次の 3 つを持つ:
 *   this.state    永続 JSON（setState で更新）
 *   this.sql      ローカル SQLite（タグ付きテンプレートで発行）
 *   schedule()    永続スケジューラ
 *
 * 「1 ユーザー = 1 インスタンス」に振り切ることで、セッションストアも中央 DB も要らなくなる。
 */
export class PersonalAssistantAgent extends Agent<Env, AssistantState> {
  initialState: AssistantState = {
    autonomyLevel: "suggest",
    timezone: "Asia/Tokyo",
    slackUserId: "UXXXXXXXX",
  };

  /**
   * Agent インスタンスの起動時に毎回呼ばれる（コードやシークレットを更新して
   * Durable Object が作り直されるたびに走る）。そのため冪等でなければならない。
   */
  async onStart() {
    // 状態の第 2 層 = Task Ledger（タスク台帳）。
    // 中央 DB（D1）は置かず、Agent ローカルの SQLite が台帳そのもの（CONCEPT.md 原則 1「1 ユーザー = 1 Agent」）。
    //
    // status がタスクの状態機械そのものになる:
    //   open → waiting_user → approved → executing → done / error / rejected
    // payload_json には「承認されたら何を実行するか」を丸ごと保存しておく。
    this.sql`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        priority TEXT,
        source TEXT,
        autonomy_level TEXT,
        due_at TEXT,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    // タスクに起きたことの履歴。tasks は現在の状態しか持たないので、
    // 「いつ完了したか」のような時系列はこちらに追記する。
    this.sql`
      CREATE TABLE IF NOT EXISTS task_events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT,
        type TEXT,
        message TEXT,
        created_at TEXT NOT NULL
      )
    `;
  }

  // ---- Task Ledger の操作 ----

  /** タスクを 1 件登録し、その task_id を返す。 */
  createTask(
    title: string,
    opts: {
      status?: string;
      priority?: string;
      source?: string;
      dueAt?: string | null;
      payload?: unknown;
    } = {},
  ): string {
    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    this.sql`
      INSERT INTO tasks (
        task_id, title, status, priority, source,
        autonomy_level, due_at, payload_json, created_at, updated_at
      ) VALUES (
        ${taskId},
        ${title},
        ${opts.status ?? "open"},
        ${opts.priority ?? "medium"},
        ${opts.source ?? "llm"},
        ${this.state.autonomyLevel},
        ${opts.dueAt ?? null},
        ${opts.payload ? JSON.stringify(opts.payload) : null},
        ${now},
        ${now}
      )
    `;
    return taskId;
  }

  /** タスクの状態を遷移させる。完了は履歴にも 1 件だけ残す。 */
  markTaskStatus(taskId: string, status: string) {
    const now = new Date().toISOString();
    this.sql`
      UPDATE tasks SET status = ${status}, updated_at = ${now} WHERE task_id = ${taskId}
    `;
    if (status === "done") this.recordTaskCompletion(taskId);
  }

  /** 完了を task_events に 1 件だけ記録する（何度 done にしても増えない）。 */
  private recordTaskCompletion(taskId: string) {
    const existing = this.sql`
      SELECT 1 FROM task_events WHERE task_id = ${taskId} AND type = 'completed' LIMIT 1
    `;
    if (existing.length > 0) return;
    const title = this.sql<{ title: string }>`
      SELECT title FROM tasks WHERE task_id = ${taskId}
    `[0]?.title;
    if (!title) return;
    this.sql`
      INSERT INTO task_events (event_id, task_id, type, message, created_at)
      VALUES (${crypto.randomUUID()}, ${taskId}, ${"completed"}, ${title}, ${new Date().toISOString()})
    `;
  }

  /** 未完了タスク（＝Agent が気にかけ続けるべきもの）。 */
  openTasks() {
    return this.sql`
      SELECT task_id, title, status, priority, due_at
      FROM tasks
      WHERE status IN ('open', 'waiting_user', 'approved', 'executing')
      ORDER BY updated_at DESC LIMIT 30
    `;
  }

  // ---- フロー A: Slack から話しかけられたとき ----

  /**
   * Slack Events API の payload を処理する（Worker で署名検証済み）。
   * ここが「誰の言うことを聞くか」を決める場所でもある。
   */
  async handleSlackEvent(payload: any) {
    const event = payload.event;
    if (!event) return { ok: true };

    // Bot 自身の投稿・メッセージ編集などは無視する。
    // これを忘れると、自分の投稿に自分が反応して無限ループする。
    if (event.bot_id || event.subtype) return { ok: true };

    const user: string | undefined = event.user;
    const channel: string | undefined = event.channel;

    // 初回ブートストラップ: slackUserId が未設定（プレースホルダ）なら、
    // 最初に話しかけてきたユーザーを所有者として学習する。
    if (this.state.slackUserId === "UXXXXXXXX" && user) {
      this.setState({ ...this.state, slackUserId: user });
      console.log(`bootstrapped owner slackUserId = ${user}`);
    }

    // 所有者以外は拒否（allowlist）。チャンネルの他メンバーの発言はここで弾かれる。
    // 「所有者しか使えない」を既定にする（CONCEPT.md 原則 4「安全側に倒す」）。
    if (user && user !== this.state.slackUserId) {
      return { ok: false, reason: "user not allowed" };
    }

    // 話しかけられたチャンネルを返信先として覚える。
    // これを state に持つことで、heartbeat から自発的に投稿できるようになる。
    if (channel && channel !== this.state.slackChannelId) {
      this.setState({ ...this.state, slackChannelId: channel });
    }

    // TODO: LLM の応答をここに書く
    return { ok: true };
  }

  // ---- Slack への投稿 ----

  async postSlackMessage(text: string, threadTs?: string) {
    await this.slackPost({ text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }

  protected async slackPost(body: Record<string, unknown>) {
    if (!this.state.slackChannelId) {
      console.warn("slackPost skipped: slackChannelId is not set yet");
      return;
    }
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel: this.state.slackChannelId, ...body }),
    });
    // Slack は HTTP 200 でも { ok: false, error } を返すことがある。
    const data = (await res.json()) as { ok: boolean; error?: string };
    if (!data.ok) {
      console.error(`Slack postMessage failed: ${data.error}`);
    }
  }

  // ---- LLM への問い合わせ ----

  /**
   * LLM に「次に取るべきアクション」を決めさせる。
   *
   * 返るのは必ず Action[]。LLM が落ちても Agent 全体は生き続けるべきなので、
   * 失敗しても例外を投げず空配列にする（CONCEPT.md 原則 4「安全側に倒す」）。
   */
  async askLlm(prompt: string): Promise<Action[]> {
    try {
      const result = await generate<{ actions: Action[] }>({
        apiKey: this.env.GEMINI_API_KEY,
        systemInstruction: SYSTEM_PROMPT,
        prompt,
        schema: ACTIONS_SCHEMA,
      });
      return result.actions ?? [];
    } catch (err) {
      console.error("LLM call failed:", err);
      return [];
    }
  }
}
