// アクション語彙の定義 —— 型・スキーマ・検証の 3 つを 1 ファイルに置く。
//
// 型とスキーマを隣に並べておけば「片方だけ増やす」事故は防げる。だが並べても消えない
// ズレがある。両者は表現できることが違うからだ: ACTIONS_SCHEMA の required は ["type"]
// だけなのに、Action 型は arm ごとに message や title を必須と宣言している。
// 3 つ目の見え方（検証）が必要なのは、この差を埋めるためである。
//
// なぜ required に "type" しか書けないのか。responseSchema は OpenAPI のサブセットで
// oneOf を持たないため、5 種類のアクションを「type で分岐する 1 種類のオブジェクト」として
// 表すしかなく、どのフィールドも「省略され得る」ことになる。
//
// つまり structured output が保証するのは「この形の JSON であること」までで、
// 「reply には message がある」までは保証しない。実際 {"type":"reply"} はスキーマに適合し、
// そのまま applyActions に渡せば Slack に "undefined" と投稿される。
//
// スキーマで縛りきれない分はコードで縛る。ここが LLM の出力と副作用の間の関所であり、
// 通らなかったものは捨てる（CONCEPT.md 原則 4「安全側に倒す」）。
//
// このファイルは実行時 import を持たない純粋関数なので、Workers を起こさずに手で試せる:
//   node -e "const m = await import('./src/actions.ts'); console.log(m.toAction({type:'reply'}))"

import type { LlmResponseSchema } from "./llm";

/**
 * Agent の行動空間。LLM が取れる行動はこの 5 つだけ（CONCEPT.md 原則 2「LLM は頭脳、コードは手足」）。
 *
 * 能力を足すというのは、この型と ACTIONS_SCHEMA と toAction の分岐、そしてそれを
 * 実行するコードを増やすことであって、LLM に「もっと自由にやっていい」と言うことではない。
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 未検証の値 1 件を Action にする。通らなければ null。
 *
 * キャストせず、type ごとに必要なフィールドを確認して新しいオブジェクトを組み直す。
 * こうすると LLM が勝手に足した余計なフィールドも落ちる。
 * create_event は payload_json に丸ごと保存されるので、ここで削れることに意味がある。
 *
 * 各 case が返すリテラルは Action のどれかの arm を満たさなければならないので、
 * 「必須項目の確認を書き忘れた」は tsc が見つけてくれる。
 */
export function toAction(value: unknown): Action | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== "string") return null;

  switch (value.type) {
    case "reply":
    case "ask_user":
      if (typeof value.message !== "string") return null;
      return { type: value.type, message: value.message };

    case "create_task": {
      if (typeof value.title !== "string") return null;
      const action: Action = { type: "create_task", title: value.title };
      if (value.priority === "low" || value.priority === "medium" || value.priority === "high") {
        action.priority = value.priority;
      }
      if (typeof value.due_at === "string" || value.due_at === null) {
        action.due_at = value.due_at;
      }
      if (typeof value.requires_user_approval === "boolean") {
        action.requires_user_approval = value.requires_user_approval;
      }
      return action;
    }

    case "create_event": {
      // 外部作用を持つ唯一のアクション。title と start が欠けたものは実行できない。
      if (typeof value.title !== "string" || typeof value.start !== "string") return null;
      const action: Action = { type: "create_event", title: value.title, start: value.start };
      if (typeof value.end === "string" || value.end === null) {
        action.end = value.end;
      }
      if (typeof value.location === "string") {
        action.location = value.location;
      }
      return action;
    }

    case "show_task":
      if (typeof value.task_id !== "string") return null;
      return { type: "show_task", task_id: value.task_id };

    // 語彙に無い type は捨てる。LLM が新しい能力を勝手に発明しても、ここで止まる。
    default:
      return null;
  }
}

/**
 * generate に渡す検証関数。{ actions: [...] } を検証済みの Action[] にする。
 *
 * 不正な要素があっても全体を捨てない。1 件の欠落で正常な返信まで失うのは、
 * 安全側ではなく単に無反応なだけ。落としたものは呼び出し側がログに出せるよう返す。
 */
export function parseActionsResponse(value: unknown): { actions: Action[]; dropped: unknown[] } {
  // actions が配列でなければ（"none" のような文字列でも）1 件も取れない。
  if (!isRecord(value) || !Array.isArray(value.actions)) {
    return { actions: [], dropped: [value] };
  }

  const actions: Action[] = [];
  const dropped: unknown[] = [];
  for (const item of value.actions) {
    const action = toAction(item);
    if (action) {
      actions.push(action);
    } else {
      dropped.push(item);
    }
  }
  return { actions, dropped };
}
