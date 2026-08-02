// アクション語彙の宣言。コード側の型と、LLM に渡す structured output のスキーマ。
//
// この 2 つは同じものの 2 つの見え方（コードから見た形 / LLM に強制する形）なので、
// 同じファイルに並べて置く。片方だけ増やす事故を防ぐには、隣に置くのが一番効く。
//
// 能力を足すというのは、この 2 つとそれを実行するコードを増やすことであって、
// LLM に「もっと自由にやっていい」と言うことではない（CONCEPT.md 原則 2）。

import type { LlmResponseSchema } from "./llm";

/**
 * Agent の行動空間。LLM が取れる行動はこの 5 つだけ（CONCEPT.md 原則 2「LLM は頭脳、コードは手足」）。
 *
 * 能力を足すというのは、この型と ACTIONS_SCHEMA、そしてそれを実行するコードを
 * 増やすことであって、LLM に「もっと自由にやっていい」と言うことではない。
 */
export type Action =
  // reply: 質問への回答・情報提供。
  | { type: "reply"; message: string }
  // ask_user: ユーザーに確認・判断を求める問いかけ。
  | { type: "ask_user"; message: string }
  // create_task: タスクを台帳に登録する。
  | {
      type: "create_task";
      title: string;
      priority?: "low" | "medium" | "high";
      due_at?: string | null;
      requires_user_approval?: boolean;
    }
  // create_event: カレンダーに予定を作る「外部作用」アクション。
  // 実世界に影響するため必ず承認を挟み、承認後にコードが実行する。
  | {
      type: "create_event";
      title: string;
      start: string;
      end?: string | null;
      location?: string;
    }
  // show_task: 既存タスクをチェックボックス付きで Slack に再掲する。
  // 「押しても何も進まない通知」ではなく、その場で完了にできる形で出すためのアクション。
  | { type: "show_task"; task_id: string };

/**
 * LLM に返させる structured output のスキーマ。
 *
 * responseSchema は OpenAPI のサブセットで oneOf を持たないため、union ではなく
 * 「全プロパティを持つ 1 種類のオブジェクト + type による分岐」で表現する。
 * 冗長に見えるが、モデルを差し替えても壊れにくいのはこの形。
 *
 * このスキーマこそがエージェントの設計の背骨である。ここを決めた瞬間に、
 * 非決定的な自然文が、プログラムで分岐・永続化できる決定的なデータになる。
 */
export const ACTIONS_SCHEMA: LlmResponseSchema = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      description: "実行すべきアクションの配列（不要なら空配列）",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["reply", "ask_user", "create_task", "create_event", "show_task"],
            description:
              "reply=質問への回答・情報提供 / ask_user=Slackで確認・問いかけ / " +
              "create_task=タスク登録 / create_event=カレンダーに予定作成（要承認） / " +
              "show_task=既存タスクをチェックボックスで再掲（着手・進捗の促し）",
          },
          message: { type: "string", description: "reply・ask_user の本文" },
          task_id: {
            type: "string",
            description:
              "show_task の対象タスクID（コンテキストの『未完了タスク』の task_id をそのまま使う）",
          },
          title: {
            type: "string",
            description: "create_task のタスク名 / create_event の予定名",
          },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          due_at: {
            type: "string",
            description: "create_task の期限 ISO8601。なければ省略",
            nullable: true,
          },
          requires_user_approval: {
            type: "boolean",
            description: "create_task の実行前に承認が要るか",
          },
          start: { type: "string", description: "create_event の開始 ISO8601" },
          end: {
            type: "string",
            description: "create_event の終了 ISO8601（省略時は開始+1時間）",
            nullable: true,
          },
          location: { type: "string", description: "create_event の場所（任意）" },
        },
        required: ["type"],
      },
    },
  },
  required: ["actions"],
};
