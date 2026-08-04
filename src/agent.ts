import { Agent } from "agents";
import { generate } from "./gemini";
// 行動空間の宣言（型とスキーマ）は actions.ts にまとめてある。
import { ACTIONS_SCHEMA, type Action } from "./actions";
import { listUpcomingEvents, insertEvent, type CalendarEvent } from "./google";
import { createLogger, type Logger } from "./log";
import { parseTaskLines } from "./task-prefix";

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

// 自律チェック（heartbeat）の間隔。
// 発信が多すぎると通知そのものが無視されるようになるので、間隔は控えめに 2 時間にしてある。
// 「設定ミスで連投・課金・枠の枯渇が起きる方向には倒さない」（CONCEPT.md 原則 4「安全側に倒す」）。
const HEARTBEAT_INTERVAL_MIN = 120;

// 重複排除のために覚えておく発言の件数。直近ぶんだけあれば足りる。
const PROCESSED_EVENT_KEEP = 200;

const SYSTEM_PROMPT = `あなたは個人アシスタント（秘書）Agent です。
毎回のプロンプトには「未完了タスク・カレンダー予定」のコンテキストが与えられます。
これらを踏まえ、次に取るべきアクションを JSON で返します。

# アクションの使い分け
- 質問への回答や情報提供は reply。コンテキストの台帳・予定を根拠に具体的に答える。
  ユーザーの発言をそのまま繰り返さない。付け加えることが無いなら、次の一歩を短く示す。
- ユーザーに確認・判断を求める問いかけは ask_user。
- create_task はユーザーが明示的に依頼したときだけ使う。推測でタスク化しない。
  title は短い名詞句にする。説明・補足・言い換え・スキーマのフィールド名を混ぜてはならない
  （承認の要否は title に書くのではなく requires_user_approval に入れる）。
  行頭に「TODO:」を付けた発言はコードが直接登録するので、あなたは関与しない。
- カレンダーに予定を追加すべきときは create_event（title と start[ISO8601] は必須）。
  実世界に作用するため必ず承認を挟む。曖昧なら ask_user で確認する。
- 既存タスクへの注意喚起・着手の促し・進捗確認には必ず show_task を添える。
  task_id はコンテキストの「未完了タスク」からそのまま取る。
  言葉で促すだけにせず、その場でチェックして完了にできる形で出すこと。
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
    // 同じ発言を二度処理しないための記録。ts は Slack の「発言そのもの」の識別子で、
    // 二重配信でもリトライでも同じ値になる（event_id は配信ごとに変わるので使えない）。
    this.sql`
      CREATE TABLE IF NOT EXISTS processed_events (
        ts TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      )
    `;
    // ユーザーの承認/却下の記録。人間がどこで介入したかの台帳。
    // 却下も記録する。
    this.sql`
      CREATE TABLE IF NOT EXISTS user_decisions (
        decision_id TEXT PRIMARY KEY,
        task_id TEXT,
        decision TEXT,
        created_at TEXT NOT NULL
      )
    `;

    // heartbeat を 1 回だけ登録する（重複登録を防ぐ）。
    // onStart はコード/シークレット更新で DO が作り直されるたびに走るので、
    // 「もう登録済みか」を必ず確認してから予約する。
    const hasHeartbeat = this.getSchedules().some((s) => s.payload === "heartbeat");
    if (!hasHeartbeat) {
      await this.rescheduleHeartbeat();
    }
  }

  // ---- ログ ----

  private logger?: Logger;

  /**
   * env を読むのは this が使えるようになってからなので、初回アクセス時に作る。
   * 出力先は console だけ。observability を有効にしてあるので、
   * 問題が起きた後から Cloudflare のダッシュボードで検索できる。
   */
  protected get log(): Logger {
    return (this.logger ??= createLogger(this.env.LOG_LEVEL));
  }

  // ---- フロー B: heartbeat（自律ループ） ----

  /**
   * schedule() のコールバック。一定間隔で自分で目を覚まし、
   * 台帳と予定を見て「いま伝える価値のあること」があるかを判断する。
   *
   * cron 用の別 Worker は要らない。Agent 自身が目覚まし時計を持っている。
   */
  async heartbeat() {
    try {
      const actions = await this.askLlmForPlan();
      await this.applyActions(actions);
    } finally {
      // 途中で失敗しても次回を必ず登録する。
      // ここを try の中に置くと、1 回の失敗で heartbeat の鎖が切れて Agent が永久に眠る。
      await this.rescheduleHeartbeat();
    }
  }

  /** 既存の heartbeat 予約を消して、次回を登録し直す。 */
  private async rescheduleHeartbeat(): Promise<Date> {
    for (const s of this.getSchedules()) {
      if (s.payload === "heartbeat") await this.cancelSchedule(s.id);
    }
    const at = new Date(Date.now() + HEARTBEAT_INTERVAL_MIN * 60 * 1000);
    // idempotent: false は明示的な選択。true にすると「同じ callback+payload の既存行が
    // あればその行（＝古い時刻）を返す」ため、cancel を取りこぼしたときに
    // 古い予約に張り付いたまま、それが実行されて予約ゼロ＝heartbeat 停止になりうる。
    // false なら最悪でも重複行が増えるだけで、次の再登録が全部消して直す。
    await this.schedule(at, "heartbeat", "heartbeat", { idempotent: false });
    return at;
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

  /**
   * task_id でタスクを引く。見つからなければ題名の部分一致で救済する。
   * LLM が id を取り違えることがあるので、素直に諦めない方が体験が良い。
   */
  private findTask(taskIdOrTitle: string) {
    const byId = this.sql<{ task_id: string; title: string; status: string }>`
      SELECT task_id, title, status FROM tasks WHERE task_id = ${taskIdOrTitle}
    `;
    if (byId[0]) return byId[0];
    return this.sql<{ task_id: string; title: string; status: string }>`
      SELECT task_id, title, status FROM tasks
      WHERE title LIKE ${"%" + taskIdOrTitle + "%"}
        AND status NOT IN ('done', 'rejected')
      ORDER BY updated_at DESC LIMIT 1
    `[0];
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

    // 同じ発言が二重に届くことがある。経路は 2 つあり、どちらも実際に踏んだ。
    //   1. チャンネルでメンションすると app_mention と message.* が両方配信される
    //      （event_id は別だが、発言の識別子である ts は同じ）
    //   2. 3 秒以内に 200 を返せないと Slack がリトライする（event_id も同じ）
    // 弾かないと、同じ問いに 2 回別々の答えを返すことになる。
    if (!this.claimSlackEvent(event.ts)) {
      this.log.info("slack.duplicate", { ts: event.ts, type: event.type });
      return { ok: true };
    }

    const user: string | undefined = event.user;
    const channel: string | undefined = event.channel;

    // 初回ブートストラップ: slackUserId が未設定（プレースホルダ）なら、
    // 最初に話しかけてきたユーザーを所有者として学習する。
    if (this.state.slackUserId === "UXXXXXXXX" && user) {
      this.setState({ ...this.state, slackUserId: user });
      this.log.info("owner.bootstrapped", { user });
    }

    // 所有者以外は拒否（allowlist）。チャンネルの他メンバーの発言はここで弾かれる。
    // 「所有者しか使えない」を既定にする（CONCEPT.md 原則 4「安全側に倒す」）。
    if (user && user !== this.state.slackUserId) {
      this.log.info("slack.rejected", { user });
      return { ok: false, reason: "user not allowed" };
    }

    // 話しかけられたチャンネルを返信先として覚える。
    // これを state に持つことで、heartbeat から自発的に投稿できるようになる。
    if (channel && channel !== this.state.slackChannelId) {
      this.setState({ ...this.state, slackChannelId: channel });
    }

    const text: string = event.text ?? "";
    // スレッド内の発言なら thread_ts が入る。返信も同じスレッドに返す。
    const threadTs: string | undefined = event.thread_ts;

    this.log.verbose("slack.recv", {
      type: event.type,
      channel,
      thread: threadTs,
      ts: event.ts,
      text,
    });

    // 行頭 "TODO:" のような明示コマンドは LLM を通さず、書かれたとおりに登録する。
    // ここを LLM に通すと「登録しますか?」の確認や、タイトルの勝手な言い換えが混ざる。
    const taskTitles = parseTaskLines(text);
    if (taskTitles.length > 0) {
      this.log.verbose("command.recognized", { command: "task-prefix", titles: taskTitles });
      await this.registerPrefixedTasks(taskTitles, threadTs);
      return { ok: true };
    }

    const actions = await this.askLlmForSlackReply(text);
    await this.applyActions(actions, { threadTs });
    return { ok: true };
  }

  /**
   * この発言をまだ処理していなければ記録して true を返す（既に処理済みなら false）。
   * Durable Object は単一実行モデルなので、この読み書きに競合は起きない。
   */
  private claimSlackEvent(ts: string | undefined): boolean {
    // ts を持たない形の event は素通しする（弾く根拠が無いものを弾かない）。
    if (!ts) return true;
    const seen = this.sql`SELECT 1 FROM processed_events WHERE ts = ${ts} LIMIT 1`;
    if (seen.length > 0) return false;
    this.sql`
      INSERT INTO processed_events (ts, created_at)
      VALUES (${ts}, ${new Date().toISOString()})
    `;
    // 台帳と同じで、残すものを設計する。古い分は重複排除に要らない。
    this.sql`
      DELETE FROM processed_events WHERE rowid NOT IN (
        SELECT rowid FROM processed_events ORDER BY rowid DESC LIMIT ${PROCESSED_EVENT_KEEP}
      )
    `;
    return true;
  }

  /**
   * プレフィックス付き発言から拾ったタスクを登録し、その場でチェックできる形で出す。
   * source を "slack:todo" にして、LLM が作ったタスクと台帳上で区別できるようにする。
   */
  private async registerPrefixedTasks(titles: string[], threadTs?: string) {
    for (const title of titles) {
      const taskId = this.createTask(title, { source: "slack:todo" });
      await this.postTask(taskId, title, false, threadTs);
    }
  }

  // ---- applyActions: LLM の出力を副作用に変える翻訳層 ----

  /**
   * エージェントの心臓部。
   *
   * LLM が返したアクションを、実際の副作用（DB 書き込み・Slack 投稿）に変換する。
   * Slack 経由でも heartbeat 経由でも、あらゆる経路が最終的にここに集約される。
   * 「副作用が起きる場所」を一箇所に絞ることで、システムの振る舞いが追えるようになる。
   *
   * LLM はここに書かれていないことは何もできない。
   */
  async applyActions(actions: Action[], opts: { threadTs?: string } = {}) {
    for (const action of actions) {
      // 「何を実行しようとしたか」。副作用が起きる直前にここだけ見れば追える。
      this.log.verbose("apply.action", action);

      if (action.type === "reply" || action.type === "ask_user") {
        await this.postSlackMessage(action.message, opts.threadTs);
      }

      if (action.type === "create_task") {
        const taskId = this.createTask(action.title, {
          // 承認が要るタスクは open ではなく waiting_user から始める。
          status: action.requires_user_approval ? "waiting_user" : "open",
          priority: action.priority,
          dueAt: action.due_at,
          payload: action,
        });
        if (action.requires_user_approval) {
          await this.postApprovalRequest(taskId, action.title, opts.threadTs);
        } else {
          // 平文で「登録しました」と言うのではなく、その場で完了にできる形で出す。
          await this.postTask(taskId, action.title, false, opts.threadTs);
        }
      }

      if (action.type === "show_task") {
        const task = this.findTask(action.task_id);
        if (!task) {
          await this.postSlackMessage("⚠️ 対象のタスクが見つかりませんでした。", opts.threadTs);
        } else {
          await this.postTask(task.task_id, task.title, task.status === "done", opts.threadTs);
        }
      }

      if (action.type === "create_event") {
        // 外部作用アクション。LLM がどれだけ確信していても即実行しない。
        // waiting_user のタスクとして台帳に保存し、承認ボタンを出す。
        // payload_json にアクション全体を入れておき、承認時に実行内容を復元する。
        const taskId = this.createTask(action.title, {
          status: "waiting_user",
          dueAt: action.start,
          payload: action,
        });
        await this.postApprovalRequest(
          taskId,
          `📅 予定を追加: ${action.title}（${action.start}）`,
          opts.threadTs,
        );
      }
    }
  }

  // ---- タスクのチェックボックス（チェック＝完了） ----

  /**
   * タスク 1 件を「チェックボックス 1 個」として描く。
   *
   * 通知して終わりにせず、その場で状態を進められる形で出すのが要点。
   * 「終わりましたか?」と聞いて「はい/いいえ」を押させるより、
   * チェックボックス 1 つの方が押す手間も往復も少ない。
   */
  private renderTaskBlocks(taskId: string, title: string, done: boolean): unknown[] {
    // Slack のオプションラベルは 150 文字まで。完了済みは打ち消し線で見せる。
    const label = title.slice(0, 150);
    const option = {
      text: { type: "mrkdwn" as const, text: done ? `~${label}~` : label },
      value: taskId,
    };
    const checkboxes: Record<string, unknown> = {
      type: "checkboxes",
      action_id: "task_toggle",
      options: [option],
    };
    // initial_options は空配列を渡すと Slack がエラーにするので、完了時だけ付ける。
    // また initial_options の要素は options の要素と完全一致していなければならない。
    if (done) checkboxes.initial_options = [option];

    // block_id にタスクを載せて往復させる（承認ボタンの approval:<id> と同じ流儀）。
    return [{ type: "actions", block_id: `task:${taskId}`, elements: [checkboxes] }];
  }

  /** タスクをチェックボックス付きで Slack に投稿する。 */
  async postTask(taskId: string, title: string, done = false, threadTs?: string) {
    await this.slackPost({
      // blocks を出す場合も text は入れる（通知プレビュー・アクセシビリティ用）。
      text: title,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      blocks: this.renderTaskBlocks(taskId, title, done),
    });
  }

  /**
   * チェックボックスが押されたとき。チェック＝完了、外す＝open にする（元の状態には戻らない）。
   *
   * 承認ボタンと同じく状態機械を動かす操作だが、承認と違って外部作用は伴わない。
   * そのため承認ゲートは要らず、その場で台帳を更新してよい。
   */
  async handleTaskToggle(payload: any, action: any) {
    const blockId: string = action.block_id ?? "";
    const taskId = blockId.startsWith("task:") ? blockId.slice("task:".length) : "";
    if (!taskId) return { ok: true };

    const row = this.sql<{ title: string }>`
      SELECT title FROM tasks WHERE task_id = ${taskId}
    `[0];
    if (!row) return { ok: true };

    // Slack は「いま選択されている選択肢の集合」を送ってくる。
    // 選択肢が 1 つしかないので、空かどうかがそのままチェック状態になる。
    const done = (action.selected_options ?? []).length > 0;
    // markTaskStatus 経由なので、完了は task_events にも 1 件残る。
    this.markTaskStatus(taskId, done ? "done" : "open");

    // 元メッセージを最新の状態で描き直す。
    if (payload.response_url) {
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: row.title,
          blocks: this.renderTaskBlocks(taskId, row.title, done),
        }),
      });
    }
    return { ok: true };
  }

  // ---- フロー C: 承認ボタン（human-in-the-loop） ----

  /** 承認/却下ボタン付きメッセージ（Block Kit）を投稿する。 */
  async postApprovalRequest(taskId: string, title: string, threadTs?: string) {
    await this.slackPost({
      text: `承認依頼: ${title}`,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*承認依頼*\n${title}` },
        },
        {
          type: "actions",
          block_id: `approval:${taskId}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "承認" },
              style: "primary",
              action_id: "approve",
              // どのタスクへの承認かを value に載せて往復させる。
              value: taskId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "却下" },
              style: "danger",
              action_id: "reject",
              value: taskId,
            },
          ],
        },
      ],
    });
  }

  /**
   * Slack のボタン押下（block_actions）を処理する。Worker で署名検証済み。
   * ここでタスクの状態機械が waiting_user から先へ進む。
   */
  async handleSlackInteraction(payload: any) {
    // 所有者以外の操作は拒否（allowlist はボタンにも効かせる）。
    if (payload.user?.id && payload.user.id !== this.state.slackUserId) {
      return { ok: false, reason: "user not allowed" };
    }
    const action = payload.actions?.[0];
    if (!action) return { ok: true };

    // ボタンの種類でディスパッチする。UI を足すときはここに 1 本足す。
    if (action.action_id === "task_toggle") {
      return this.handleTaskToggle(payload, action);
    }

    if (action.action_id !== "approve" && action.action_id !== "reject") {
      return { ok: true };
    }

    const taskId: string = action.value;
    const decision = action.action_id as "approve" | "reject";
    const now = new Date().toISOString();

    this.markTaskStatus(taskId, decision === "approve" ? "approved" : "rejected");
    // 却下も記録する。今後機能拡張する場合、学習材料になりうる。
    this.sql`
      INSERT INTO user_decisions (decision_id, task_id, decision, created_at)
      VALUES (${crypto.randomUUID()}, ${taskId}, ${decision}, ${now})
    `;

    const title =
      this.sql<{ title: string }>`SELECT title FROM tasks WHERE task_id = ${taskId}`[0]?.title ??
      taskId;
    const label = decision === "approve" ? "✅ 承認しました" : "🚫 却下しました";

    // 元の承認依頼メッセージを結果テキストに置き換える。
    // ボタンを残したままにすると二度押しできてしまう。
    if (payload.response_url) {
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace_original: true, text: `${label}: ${title}` }),
      });
    }

    // 承認されて初めて、保存しておいた副作用を実行する。
    if (decision === "approve") {
      await this.executeTask(taskId);
    }
    return { ok: true };
  }

  /**
   * 承認済みタスクの副作用を実際に実行する（approved → executing → done/error）。
   *
   * 実行対象は payload_json に保存しておいたアクション。
   * LLM はこの経路に一切関与しない。決定的なコードだけが実世界に触れる。
   */
  async executeTask(taskId: string) {
    const row = this.sql<{ payload_json: string | null; title: string }>`
      SELECT payload_json, title FROM tasks WHERE task_id = ${taskId}
    `[0];
    if (!row) return;

    let action: Action | null = null;
    try {
      action = row.payload_json ? (JSON.parse(row.payload_json) as Action) : null;
    } catch {
      action = null;
    }
    // 外部作用を持つのは create_event だけ。外部作用がないものは approved のまま残る。
    if (!action || action.type !== "create_event") return;

    if (!this.env.GOOGLE_PRIVATE_KEY || !this.env.GOOGLE_CALENDAR_ID) {
      this.markTaskStatus(taskId, "error");
      await this.postSlackMessage(`⚠️ カレンダー未設定のため予定を追加できません: ${row.title}`);
      return;
    }

    this.markTaskStatus(taskId, "executing");
    try {
      const ev = await insertEvent(this.env, {
        summary: action.title,
        start: action.start,
        end: action.end ?? undefined,
        location: action.location,
        timezone: this.state.timezone,
      });
      this.markTaskStatus(taskId, "done");
      await this.postSlackMessage(`📅 カレンダーに追加しました: ${ev.summary}（${ev.start}）`);
    } catch (err) {
      this.log.error("task.execute.failed", { taskId, error: String(err) });
      // 失敗を握り潰さない。done でも waiting_user でもない error という行き先を用意する。
      this.markTaskStatus(taskId, "error");
      await this.postSlackMessage(`⚠️ 予定の追加に失敗しました: ${row.title}`);
    }
  }

  // ---- LLM に渡すコンテキスト ----

  /**
   * すべての LLM 呼び出しに前置きする共通コンテキスト。
   *
   * 経路（Slack 応答 / heartbeat）ごとに見える情報が違うと、
   * 「さっき言ったことを heartbeat が知らない」型の不整合が生まれる。
   * 視界を 1 つの関数に一元化しておくのが要点。
   */
  protected async buildAssistantContext(): Promise<string> {
    const tasks = this.openTasks();
    const calendarEvents = await this.fetchUpcomingCalendarEvents();
    return `# 未完了タスク
${JSON.stringify(tasks)}

# 今後のカレンダー予定
${JSON.stringify(calendarEvents)}`;
  }

  /**
   * 直近の予定を取得する。未設定・失敗時は空配列に落とす。
   * カレンダーが落ちても Agent は返事ができるべき（CONCEPT.md 原則 4「安全側に倒す」）。
   */
  async fetchUpcomingCalendarEvents(): Promise<CalendarEvent[]> {
    if (!this.env.GOOGLE_PRIVATE_KEY || !this.env.GOOGLE_CALENDAR_ID) {
      return []; // 未設定なら Calendar 連携オフ
    }
    try {
      return await listUpcomingEvents(this.env, { maxResults: 10 });
    } catch (err) {
      this.log.error("calendar.fetch.failed", String(err));
      return [];
    }
  }

  // ---- Slack への投稿 ----

  async postSlackMessage(text: string, threadTs?: string) {
    await this.slackPost({ text, ...(threadTs ? { thread_ts: threadTs } : {}) });
  }

  protected async slackPost(body: Record<string, unknown>) {
    if (!this.state.slackChannelId) {
      this.log.error("slack.post.skipped", "slackChannelId is not set yet");
      return;
    }
    this.log.verbose("slack.post", {
      text: body.text,
      blocks: Array.isArray(body.blocks) ? body.blocks.length : 0,
    });
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
      this.log.error("slack.post.failed", { error: data.error });
    }
  }

  // ---- LLM への問い合わせ ----

  /** フロー B: 定期チェックで「いま何かすべきか」を決めさせる。 */
  async askLlmForPlan(): Promise<Action[]> {
    return this.askLlm(`定期チェック（heartbeat）です。
コンテキストのタスク台帳・カレンダー予定を見直し、今本当に必要なアクションだけを返してください。
- 期限が近い/過ぎたタスクなど、価値のある注意喚起だけを行う
- 注意喚起は短い reply 1 通に留め、対象タスクには show_task を必ず併せて出す
  （その場でチェックして完了にできる形にする）
- 特に伝えるべきことがなければ actions は空配列にする（無意味な発信をしない）

# 自律レベル
${this.state.autonomyLevel}`);
  }

  /** フロー A: Slack のメッセージへの応答アクションを決めさせる。 */
  async askLlmForSlackReply(text: string): Promise<Action[]> {
    return this.askLlm(`Slack でユーザーから次のメッセージが来ました。
コンテキスト（タスク台帳・予定）を踏まえて応答アクションを決めてください。
質問への回答や情報提供は reply を使い、台帳や予定を根拠に具体的に答えてください。

# メッセージ
${text}

# 自律レベル
${this.state.autonomyLevel}`);
  }

  /**
   * LLM に「次に取るべきアクション」を決めさせる。
   * 共通コンテキストを前置きしてから問いを渡す。
   *
   * 返るのは必ず Action[]。LLM が落ちても Agent 全体は生き続けるべきなので、
   * 失敗しても例外を投げず空配列にする（CONCEPT.md 原則 4「安全側に倒す」）。
   */
  async askLlm(prompt: string): Promise<Action[]> {
    const full = `${await this.buildAssistantContext()}\n\n---\n\n${prompt}`;
    // 「どう解釈したか」を追うには、送った全文と返ってきたアクションの両方が要る。
    // 片方だけでは、LLM が悪いのかプロンプトが悪いのか切り分けられない。
    this.log.verbose("llm.prompt", full);
    try {
      const result = await generate<{ actions: Action[] }>({
        apiKey: this.env.GEMINI_API_KEY,
        systemInstruction: SYSTEM_PROMPT,
        prompt: full,
        schema: ACTIONS_SCHEMA,
      });
      const actions = result.actions ?? [];
      this.log.verbose("llm.actions", actions);
      return actions;
    } catch (err) {
      this.log.error("llm.failed", String(err));
      return [];
    }
  }
}
