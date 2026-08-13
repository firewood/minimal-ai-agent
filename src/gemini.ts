// Gemini API (Google AI Studio) の薄いラッパー。llm.ts の契約 Generate の実装。
// structured output (responseSchema) で JSON を強制し、検証済みオブジェクトを返す。
// https://ai.google.dev/gemini-api/docs/structured-output
//
// LLM への依存をこの 1 ファイルに隔離しておくと、モデルを差し替えるときに
// ここと同じ形のファイルを 1 つ書くだけで済む（型・契約は llm.ts にある）。

import type { Generate } from "./llm";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Gemini を呼び、返ってきた JSON を parse に通して検証済みの値を返す。
 *
 * 型注釈が Generate なのは、契約から外れたら tsc が止めるようにするため。
 * opts の型はそこから流れてくるので、ここに書く必要はない。
 */
export const generate: Generate = async (opts) => {
  const model = opts.model ?? DEFAULT_MODEL;
  const url = `${ENDPOINT}/${model}:generateContent`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    // schema を渡すと「JSON で返せ」ではなく「この形の JSON しか返せない」になる。
    // 自然文をパースする必要が消え、LLM の出力がプログラムで扱えるデータになる。
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    },
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": opts.apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned no text");
  }

  // JSON.parse の戻りは any。いったん unknown で受け直してから parse に渡す。
  // any のまま渡すと「検証したつもり」でどんな型にも通ってしまう。
  const raw: unknown = JSON.parse(text);
  return opts.parse(raw);
};
