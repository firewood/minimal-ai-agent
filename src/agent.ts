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
}
