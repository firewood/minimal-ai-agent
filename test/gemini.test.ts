// Gemini ラッパーのテスト。fetch を差し替えて「契約どおり呼び、検証を通してから返すか」を見る。
// 実際の API は叩かない（鍵も要らないし、結果が非決定的なのでテストに向かない）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { generate, DEFAULT_MODEL } from "../src/gemini.ts";
import type { LlmResponseSchema } from "../src/llm.ts";

const SCHEMA: LlmResponseSchema = {
  type: "object",
  properties: { actions: { type: "array", items: { type: "object" } } },
  required: ["actions"],
};

type Captured = { url: string; init: RequestInit };

/** fetch を差し替え、呼ばれた内容を記録しつつ固定の応答を返す。 */
function stubFetch(reply: { ok?: boolean; status?: number; body: unknown }): {
  calls: Captured[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: reply.ok ?? true,
      status: reply.status ?? 200,
      json: async () => reply.body,
      text: async () => (typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)),
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Gemini の応答エンベロープ（candidates[].content.parts[].text）を組む。 */
const envelope = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test("structured output を必ず要求し、渡したスキーマをそのまま送る", async () => {
  const { calls, restore } = stubFetch({ body: envelope(`{"actions":[]}`) });
  try {
    await generate({
      apiKey: "k",
      prompt: "p",
      schema: SCHEMA,
      parse: (v) => v,
    });
  } finally {
    restore();
  }

  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0]?.init.body));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseSchema, SCHEMA);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "p" }] }]);
  // 既定モデルが URL に入り、API キーはヘッダで渡す（クエリに出さない）。
  assert.ok(calls[0]?.url.includes(DEFAULT_MODEL), calls[0]?.url);
  assert.equal((calls[0]?.init.headers as Record<string, string>)["x-goog-api-key"], "k");
});

test("systemInstruction は渡したときだけ載る / model は上書きできる", async () => {
  const a = stubFetch({ body: envelope(`{"actions":[]}`) });
  try {
    await generate({ apiKey: "k", prompt: "p", schema: SCHEMA, parse: (v) => v });
  } finally {
    a.restore();
  }
  assert.equal(JSON.parse(String(a.calls[0]?.init.body)).systemInstruction, undefined);

  const b = stubFetch({ body: envelope(`{"actions":[]}`) });
  try {
    await generate({
      apiKey: "k",
      prompt: "p",
      schema: SCHEMA,
      systemInstruction: "あなたは秘書です",
      model: "gemini-3-pro",
      parse: (v) => v,
    });
  } finally {
    b.restore();
  }
  assert.deepEqual(JSON.parse(String(b.calls[0]?.init.body)).systemInstruction, {
    parts: [{ text: "あなたは秘書です" }],
  });
  assert.ok(b.calls[0]?.url.includes("gemini-3-pro"), b.calls[0]?.url);
});

// これが parse を必須にした理由そのもの。生テキストではなくパース済みの値を渡す。
test("parse にはパース済みの値が渡り、その戻り値が結果になる", async () => {
  const { restore } = stubFetch({ body: envelope(`{"actions":[{"type":"reply"}]}`) });
  try {
    const seen: unknown[] = [];
    const result = await generate({
      apiKey: "k",
      prompt: "p",
      schema: SCHEMA,
      parse: (value) => {
        seen.push(value);
        return { count: (value as { actions: unknown[] }).actions.length };
      },
    });
    // 文字列ではなくオブジェクトが渡ること（string が来ていたら .actions が undefined になる）
    assert.deepEqual(seen, [{ actions: [{ type: "reply" }] }]);
    // 戻り値は parse が返したものそのまま（キャストではなく検証結果が型になる）
    assert.deepEqual(result, { count: 1 });
  } finally {
    restore();
  }
});

test("HTTP エラーは投げる（status と本文を残す）", async () => {
  const { restore } = stubFetch({ ok: false, status: 429, body: "rate limited" });
  try {
    await assert.rejects(
      () => generate({ apiKey: "k", prompt: "p", schema: SCHEMA, parse: (v) => v }),
      /Gemini API error 429: rate limited/,
    );
  } finally {
    restore();
  }
});

test("テキストが無い応答は投げる（parse は呼ばれない）", async () => {
  // safety フィルタなどで candidates が空になることがある。
  const { restore } = stubFetch({ body: { candidates: [] } });
  try {
    let parseCalled = false;
    await assert.rejects(
      () =>
        generate({
          apiKey: "k",
          prompt: "p",
          schema: SCHEMA,
          parse: (v) => {
            parseCalled = true;
            return v;
          },
        }),
      /Gemini returned no text/,
    );
    assert.equal(parseCalled, false);
  } finally {
    restore();
  }
});
