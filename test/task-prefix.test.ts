// 行頭プレフィックスの解析テスト。
//
// ここは LLM を通さずに台帳へ書き込む唯一の経路なので、
// 「拾うべきものを拾う」だけでなく「拾ってはいけないものを拾わない」が要る。

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTaskLines } from "../src/task-prefix.ts";

test("認めるプレフィックスを拾う（大小文字・全角コロン）", () => {
  assert.deepEqual(parseTaskLines("TODO: 資料をまとめる"), ["資料をまとめる"]);
  assert.deepEqual(parseTaskLines("todo:資料をまとめる"), ["資料をまとめる"]);
  assert.deepEqual(parseTaskLines("Task: 請求書を送る"), ["請求書を送る"]);
  assert.deepEqual(parseTaskLines("タスク：請求書を送る"), ["請求書を送る"]);
  assert.deepEqual(parseTaskLines("やること：ゴミを出す"), ["ゴミを出す"]);
});

test("プレフィックスが無い行は拾わない（＝通常の会話）", () => {
  assert.deepEqual(parseTaskLines("明日の予定を教えて"), []);
  assert.deepEqual(parseTaskLines("TODO リストを見せて"), []); // 区切りが無い
  assert.deepEqual(parseTaskLines("これは todo ではない"), []); // 行頭でない
  assert.deepEqual(parseTaskLines(""), []);
});

test("メンションと箇条書き記号を落としてから判定する", () => {
  assert.deepEqual(parseTaskLines("<@U123> TODO: 資料をまとめる"), ["資料をまとめる"]);
  assert.deepEqual(parseTaskLines("- TODO: 資料をまとめる"), ["資料をまとめる"]);
  assert.deepEqual(parseTaskLines("・タスク：資料をまとめる"), ["資料をまとめる"]);
  assert.deepEqual(parseTaskLines("> TODO: 引用の中"), ["引用の中"]);
});

test("複数行なら複数タスクになる", () => {
  assert.deepEqual(parseTaskLines("TODO: A\n雑談\nタスク：B"), ["A", "B"]);
});

test("題名が空の行は捨てる", () => {
  assert.deepEqual(parseTaskLines("TODO:"), []);
  assert.deepEqual(parseTaskLines("TODO:   "), []);
});

test("1 メッセージ 10 件で打ち切る（貼り付け事故で台帳を溢れさせない）", () => {
  const text = Array.from({ length: 15 }, (_, i) => `TODO: task${i}`).join("\n");
  const titles = parseTaskLines(text);
  assert.equal(titles.length, 10);
  assert.equal(titles[0], "task0");
  assert.equal(titles[9], "task9");
});

test("題名は 200 文字で切る（Slack のラベル上限に収める）", () => {
  const titles = parseTaskLines(`TODO: ${"あ".repeat(300)}`);
  assert.equal(titles.length, 1);
  assert.equal(titles[0]?.length, 200);
});
