import { Agent } from "agents";

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
}
