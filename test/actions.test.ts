// 行動空間の検証テスト。LLM の出力が副作用に届く前の関所を守る。
//
// テストランナーは Node 組み込みの node:test だけ（依存ゼロ）。
// actions.ts は実行時 import を持たない純関数なので、Workers を起こさずに読める。
//   pnpm test

import { test } from "node:test";
import assert from "node:assert/strict";

import { ACTIONS_SCHEMA, toAction, parseActionsResponse } from "../src/actions.ts";

/**
 * type ごとの「最小の妥当な値」と「必須フィールド」。
 *
 * この表がアクション語彙の台帳になっている。6 種目を増やしたときに
 * ここを足し忘れると、次の「語彙の対応」テストが落ちる。
 */
const CASES: Record<string, { minimal: Record<string, unknown>; required: string[] }> = {
  reply: {
    minimal: { type: "reply", message: "了解です" },
    required: ["message"],
  },
  ask_user: {
    minimal: { type: "ask_user", message: "どちらにしますか？" },
    required: ["message"],
  },
  create_task: {
    minimal: { type: "create_task", title: "請求書を送る" },
    required: ["title"],
  },
  create_event: {
    minimal: { type: "create_event", title: "打合せ", start: "2026-08-15T10:00:00+09:00" },
    required: ["title", "start"],
  },
  show_task: {
    minimal: { type: "show_task", task_id: "t_1" },
    required: ["task_id"],
  },
};

test("語彙の対応: スキーマの enum と検証の分岐がずれていない", () => {
  const enumTypes = ACTIONS_SCHEMA.properties?.actions.items?.properties?.type.enum;
  assert.ok(enumTypes, "ACTIONS_SCHEMA から type の enum が読めない");
  // スキーマにあるのにテストの表に無い（＝検証を書き忘れた可能性）を検出する。
  assert.deepEqual([...enumTypes].sort(), Object.keys(CASES).sort());
});

test("語彙の対応: enum の全 type が toAction を通る", () => {
  for (const [type, { minimal }] of Object.entries(CASES)) {
    assert.ok(toAction(minimal), `${type} の最小の値が toAction を通らない`);
  }
});

test("必須フィールドが欠けたら捨てる", () => {
  for (const [type, { minimal, required }] of Object.entries(CASES)) {
    for (const key of required) {
      const broken = { ...minimal };
      delete broken[key];
      assert.equal(toAction(broken), null, `${type} から ${key} を抜いても通ってしまう`);
    }
  }
});

test("必須フィールドの型が違ったら捨てる", () => {
  assert.equal(toAction({ type: "reply", message: 42 }), null);
  assert.equal(toAction({ type: "show_task", task_id: null }), null);
  assert.equal(toAction({ type: "create_event", title: "x", start: 1755000000 }), null);
});

// これが本命の回帰テスト。スキーマの required は ["type"] だけなので
// {"type":"reply"} は structured output を通ってしまう。素通しすると
// applyActions が message === undefined を Slack に投稿する。
test("回帰: message の無い reply は Slack まで届かない", () => {
  assert.equal(toAction({ type: "reply" }), null);
});

test("知らない type は捨てる", () => {
  assert.equal(toAction({ type: "send_email", to: "x@example.com" }), null);
  assert.equal(toAction({ type: 42 }), null);
  assert.equal(toAction({ message: "type がない" }), null);
});

test("オブジェクトでない値は捨てる", () => {
  for (const value of [null, undefined, "reply", 42, [], [{ type: "reply", message: "x" }]]) {
    assert.equal(toAction(value), null, `${JSON.stringify(value)} が通ってしまう`);
  }
});

test("余計なフィールドは落ちる（payload_json に混ぜない）", () => {
  // create_event の payload はそのまま SQLite に保存され、承認後に読み戻される。
  // LLM が勝手に足したフィールドを持ち込まないよう、組み直して返している。
  assert.deepEqual(toAction({ type: "reply", message: "ok", danger: "<script>" }), {
    type: "reply",
    message: "ok",
  });
  assert.deepEqual(
    toAction({ type: "show_task", task_id: "t_1", note: "余計", nested: { a: 1 } }),
    { type: "show_task", task_id: "t_1" },
  );
});

test("省略可能フィールド: 妥当なものだけ残る", () => {
  assert.deepEqual(
    toAction({
      type: "create_task",
      title: "t",
      priority: "high",
      due_at: null,
      requires_user_approval: true,
    }),
    { type: "create_task", title: "t", priority: "high", due_at: null, requires_user_approval: true },
  );
  // enum 外の priority と、真偽値でない承認フラグは黙って落とす（title は生きる）。
  assert.deepEqual(toAction({ type: "create_task", title: "t", priority: "urgent" }), {
    type: "create_task",
    title: "t",
  });
  assert.deepEqual(toAction({ type: "create_task", title: "t", requires_user_approval: "yes" }), {
    type: "create_task",
    title: "t",
  });
});

test("応答全体: actions が配列でなければ 1 件も取れない", () => {
  // {"actions":"none"} を素通しすると for...of が文字列を 1 文字ずつ回してしまう。
  assert.deepEqual(parseActionsResponse({ actions: "none" }), {
    actions: [],
    dropped: [{ actions: "none" }],
  });
  assert.deepEqual(parseActionsResponse({}), { actions: [], dropped: [{}] });
  assert.deepEqual(parseActionsResponse(null), { actions: [], dropped: [null] });
  assert.deepEqual(parseActionsResponse("ただのテキスト"), {
    actions: [],
    dropped: ["ただのテキスト"],
  });
});

test("応答全体: 空配列は正常（誤検知しない）", () => {
  // 「何もしない」は失敗ではない。ここで dropped が増えると
  // llm.actions.invalid が鳴り続けて、本物の異常が埋もれる。
  assert.deepEqual(parseActionsResponse({ actions: [] }), { actions: [], dropped: [] });
});

test("応答全体: 不正な要素だけ捨てて残りは実行する", () => {
  const result = parseActionsResponse({
    actions: [
      { type: "reply", message: "了解です" },
      { type: "reply" }, // message 欠落
      { type: "show_task", task_id: "t_1" },
      "こわれた要素",
    ],
  });
  assert.deepEqual(result.actions, [
    { type: "reply", message: "了解です" },
    { type: "show_task", task_id: "t_1" },
  ]);
  assert.deepEqual(result.dropped, [{ type: "reply" }, "こわれた要素"]);
});
