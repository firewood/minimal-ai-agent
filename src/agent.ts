import { Agent } from "agents";
import { generate } from "./gemini";
// 行動空間の定義（型・スキーマ）とその検証は actions.ts にまとめてある。
import { ACTIONS_SCHEMA, toAction, parseActionsResponse, type Action } from "./actions";
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
毎回のプロンプトには「現在時刻・未完了タスク・カレンダー予定・直近の声かけ」が与えられます。
これらを踏まえ、次に取るべきアクションを JSON で返します。

# あなたの仕事は「聞かれたら答える」ことではない
指示を待つのではなく、与えられたコンテキストを自分で点検し、ユーザーがまだ気づいていない
「そろそろ動くべきこと」を先に出す。ただし 1 回につき 1 通までにする。
言うべきときに言えることと、黙るべきときに黙れることは、同じくらい重要である。

# 発言には必ず「次の一手」を含める
コンテキストの内容をそのまま読み上げるのは発信ではない。
「予定があります」「タスクが N 件あります」は、ユーザーが自分で見れば分かることであり、
伝えても状況は 1 ミリも進まない。書けるのが状況の要約だけなら、黙る方が正しい。
発言するときは「何が」「いつまでで」「次に何をするか」が分かる形にする。

# 時間の扱い
- 「現在」に与えられた時刻だけを基準にする。今日の日付を自分で推測してはならない。
- due_at は必ず現在時刻と比べる。過ぎているものは「過ぎている」と言い切る（曖昧にしない）。
- created_at / updated_at を見て、登録されたまま動いていないタスクを見つける。

# アクションの使い分け
- 質問への回答や情報提供は reply。コンテキストの台帳・予定を根拠に具体的に答える。
  ユーザーの発言をそのまま繰り返さない。付け加えることが無いなら、次の一歩を短く示す。
- ユーザーに確認・判断を求める問いかけは ask_user。
- 先回りは reply と show_task で行う。台帳を勝手に増やして先回りしたことにはしない。
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

# しつこさを避ける
- reply は 1 回につき 1 通まで。伝えることが複数あるなら 1 通にまとめ、show_task を対象ぶん並べる。
- 「直近の声かけ」に同じ task_id が 4 時間以内にあるなら、そのタスクには触れない。
  期限を過ぎているものだけは例外として、再度促してよい。
- 該当が無ければ actions は空配列にする。空配列は失敗ではない。

# 自律レベル
- suggest: 声かけと問いかけまで。台帳とカレンダーは自分から変えない。
- draft / approve_execute: 台帳への登録や承認後の実行に踏み込む（段階的に上げる）。
先回りするかどうかは自律レベルに依らない。声かけは台帳を変えないので suggest でも行う。

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

  // ---- 時刻 ----

  /**
   * 「いま」をユーザーのタイムゾーンで表す。
   *
   * 時刻の計算をコードに持たせ、LLM には基準値として渡すだけにするのが要点。
   * LLM は自分が呼ばれた日付を知らないので、これが無いと「期限が近い」も
   * 「3 日放置」も判断できない。プロンプトで催促しても材料が無ければ動けない。
   */
  private localNow(): { iso: string; local: string; hour: number; weekday: number } {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: this.state.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      // h23 を明示する。ja-JP の既定は実装によって深夜を 24 時と表記することがあり、
      // そうなると hour が 24 になって静音時間の判定が狂う。
      hourCycle: "h23",
    }).formatToParts(now);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // 0=日曜。Intl は曜日を文字で返すので、並びから番号に戻す。
    const weekday = ["日", "月", "火", "水", "木", "金", "土"].indexOf(get("weekday"));
    return {
      iso: now.toISOString(),
      local: `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}（${get("weekday")}）`,
      hour: Number(get("hour")),
      weekday,
    };
  }

  /**
   * 自発的な発信を控える時間帯（22:00〜07:00 と土日）。
   *
   * 「夜中に通知するな」は時刻から機械的に決まる。LLM に判断させる理由がない
   * （CONCEPT.md 原則 2「LLM は頭脳、コードは手足」）。
   */
  private isQuietHours(): boolean {
    const { hour, weekday } = this.localNow();
    return hour >= 22 || hour < 7 || weekday === 0 || weekday === 6;
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
      // 静音時間は LLM を呼ばずに終わる（呼んで「空配列を返せ」と頼むより確実で、
      // API も消費しない）。ただし期限を過ぎたものがあるなら黙らない。
      if (this.isQuietHours() && !this.hasOverdueTasks()) {
        this.log.info("heartbeat.quiet", { local: this.localNow().local });
        return;
      }
      const actions = await this.askLlmForPlan();
      await this.applyActions(this.withoutEmptyTalk(actions));
    } finally {
      // 途中で失敗しても次回を必ず登録する。
      // ここを try の中に置くと、1 回の失敗で heartbeat の鎖が切れて Agent が永久に眠る。
      await this.rescheduleHeartbeat();
    }
  }

  /**
   * 「タスクを伴わない自発的な発言」を落とす。
   *
   * 点検リストの候補はどれもタスク起点なので、show_task が付いていない発言は
   * 「10:00 に予定があります」のような状況の読み上げになっている。それは
   * ユーザーが自分で見れば分かることで、伝えても状況が進まない。
   *
   * プロンプトでも禁じているが、「タスクを伴うか」は決定的に判定できるので
   * コード側でも閉じる（CONCEPT.md 原則 2「LLM は頭脳、コードは手足」）。
   * 落としたことはログに残す。黙って捨てると、なぜ静かなのか追えなくなる。
   */
  private withoutEmptyTalk(actions: Action[]): Action[] {
    if (actions.some((a) => a.type === "show_task")) return actions;
    const talk = actions.filter((a) => a.type === "reply" || a.type === "ask_user");
    if (talk.length === 0) return actions;
    this.log.info("heartbeat.empty_talk", talk);
    return actions.filter((a) => a.type !== "reply" && a.type !== "ask_user");
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

  /**
   * 未完了タスク（＝Agent が気にかけ続けるべきもの）。
   *
   * created_at / updated_at も渡すのが要点。これが無いと LLM は
   * 「登録されたまま何日も動いていない」を判断できず、催促の理由を持てない。
   */
  openTasks() {
    return this.sql`
      SELECT task_id, title, status, priority, due_at, created_at, updated_at
      FROM tasks
      WHERE status IN ('open', 'waiting_user', 'approved', 'executing')
      ORDER BY updated_at DESC LIMIT 30
    `;
  }

  /** 期限を過ぎた未完了タスクが 1 件でもあるか（静音時間の例外判定に使う）。 */
  private hasOverdueTasks(): boolean {
    const now = new Date().toISOString();
    return (
      this.sql`
        SELECT 1 FROM tasks
        WHERE status IN ('open', 'waiting_user', 'approved', 'executing')
          AND due_at IS NOT NULL AND due_at < ${now}
        LIMIT 1
      `.length > 0
    );
  }

  /**
   * 「このタスクに声をかけた」を履歴に残す。
   *
   * tasks の updated_at は台帳の変更で動くもので、声かけでは動かない。
   * 催促した事実はどこにも残らないので、task_events に置く。
   * これが無いと LLM は「前回も同じことを言った」を知り得ず、
   * 黙るか同じ催促を繰り返すかの二択になる。
   */
  private recordNudge(taskId: string) {
    this.sql`
      INSERT INTO task_events (event_id, task_id, type, message, created_at)
      VALUES (${crypto.randomUUID()}, ${taskId}, ${"nudged"}, ${null}, ${new Date().toISOString()})
    `;
  }

  /** 直近 24 時間の声かけ。同じ話を繰り返さないための材料として LLM に渡す。 */
  private recentNudges() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return this.sql`
      SELECT task_id, created_at FROM task_events
      WHERE type = 'nudged' AND created_at > ${since}
      ORDER BY created_at DESC LIMIT 20
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
          // 声をかけた事実を残す。次の heartbeat がこれを見て、同じ催促を繰り返さない。
          this.recordNudge(task.task_id);
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
      // 台帳に入る前に検証済みだが、DB には旧バージョンが書いた行も残る。
      // 外部作用（カレンダー書き込み）の直前なので、ここでもう一度通す。
      action = row.payload_json ? toAction(JSON.parse(row.payload_json)) : null;
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
    const now = this.localNow();
    const tasks = this.openTasks();
    const calendarEvents = await this.fetchUpcomingCalendarEvents();
    const nudges = this.recentNudges();
    return `# 現在
${now.iso} / 現地 ${now.local} ${this.state.timezone}

# 未完了タスク
${JSON.stringify(tasks)}

# 今後のカレンダー予定
${JSON.stringify(calendarEvents)}

# 直近 24 時間の声かけ（同じ話を繰り返さないための記録）
${JSON.stringify(nudges)}`;
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

  /**
   * フロー B: 定期チェックで「いま何かすべきか」を決めさせる。
   *
   * 「必要なら言え」ではなく「順に点検して該当を拾え」と書くのが要点。
   * 前者は判断基準を LLM 任せにするので、遠慮して黙る方に倒れ続ける。
   * 後者は該当・非該当が決まるので、言うときは言い、無いときは黙る。
   */
  async askLlmForPlan(): Promise<Action[]> {
    return this.askLlm(`定期チェック（heartbeat）です。ユーザーからの指示はありません。
あなたが自分で台帳と予定を点検します。

次の順に見て、最初に該当したものだけを 1 通の reply にまとめ、対象タスクに show_task を添えてください。

1. 期限を過ぎているのに未完了のタスク（最優先。何日/何時間過ぎているかを言う）
2. 期限が 24 時間以内に来るタスク（残り時間を言う）
3. waiting_user のまま 24 時間以上動いていないタスク（承認が止まっている）
4. open のまま 24 時間以上 updated_at が動いていないタスク（着手されていない）
5. 12 時間以内に始まる予定に**関連する未完了タスクがある**場合、そのタスクを促す
   （予定は「なぜ今か」の理由として述べる。関連タスクが無いなら該当しない）

該当が複数あっても、上から 1 つだけを選ぶ。全部並べると結局読まれない。
1〜5 のどれにも当てはまらなければ actions は空配列にする。

# 発言の中身（ここが本題）
選んだ候補について、**ユーザーが次に取れる行動**を 1 つ書けないなら、その候補は飛ばして次を見る。
コンテキストに書いてあることをそのまま読み上げるのは発信ではない。

悪い例（どれも発信する価値がない）
- 「10:00 に役員会の予定があります」→ カレンダーを見れば分かる。何をすべきかが無い
- 「未完了のタスクが 3 件あります」→ 台帳を見れば分かる。どれを今やるのかが無い
- 「予定が近づいています。ご確認ください」→ 中身が無い

良い例
- 「請求書を送る の期限は昨日 18:00 でした。まだ未完了です」＋ show_task
- 「健康診断の予約 が 2 日間承認待ちのままです。進めますか？」＋ show_task
- 「10:00 の役員会の前に 資料をまとめる が残っています。あと 50 分です」＋ show_task

カレンダーは「タスクを促す理由」として使い、予定そのものの通知には使わない。

# この経路での制約
- create_task と create_event は使わない（heartbeat は声かけだけを行う）
- 「直近の声かけ」に同じ task_id が 4 時間以内にあれば、そのタスクは飛ばして次の候補を見る
  （期限を過ぎているものは例外）
- 台帳に未完了タスクが 1 件も無いなら、何も言わない（actions は空配列）。
  先回りの材料は台帳であり、賑やかしのために予定を読み上げてはならない

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
      const { actions, dropped } = await generate({
        apiKey: this.env.GEMINI_API_KEY,
        systemInstruction: SYSTEM_PROMPT,
        prompt: full,
        schema: ACTIONS_SCHEMA,
        // 型を宣言するのではなく、検証関数を渡す。
        // ここを通らなかった出力は Agent の内側に入らない。
        parse: parseActionsResponse,
      });
      // スキーマは通ったのに Action として成立していない出力。
      // プロンプトかスキーマ側の問題なので、黙って捨てずに残す。
      if (dropped.length > 0) {
        this.log.error("llm.actions.invalid", dropped);
      }
      this.log.verbose("llm.actions", actions);
      return actions;
    } catch (err) {
      this.log.error("llm.failed", String(err));
      return [];
    }
  }
}
