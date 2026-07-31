// Gemini API (Google AI Studio) の薄いラッパー。llm.ts の契約の実装。
// structured output (responseSchema) で JSON を強制し、パース済みオブジェクトを返す。
// https://ai.google.dev/gemini-api/docs/structured-output
//
// LLM への依存をこの 1 ファイルに隔離しておくと、モデルを差し替えるときに
// ここと同じ形のファイルを 1 つ書くだけで済む（型・契約は llm.ts にある）。

import type { GenerateOptions } from "./llm";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Gemini を呼び、structured output ならパース済み JSON、なければ生テキストを返す。
 */
export async function generate<T = unknown>(opts: GenerateOptions): Promise<T> {
  const model = opts.model ?? DEFAULT_MODEL;
  const url = `${ENDPOINT}/${model}:generateContent`;

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
  };
  if (opts.systemInstruction) {
    body.systemInstruction = { parts: [{ text: opts.systemInstruction }] };
  }
  // schema を渡すと「JSON で返せ」ではなく「この形の JSON しか返せない」になる。
  // 自然文をパースする必要が消え、LLM の出力がプログラムで扱えるデータになる。
  if (opts.schema) {
    body.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: opts.schema,
    };
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

  return (opts.schema ? JSON.parse(text) : text) as T;
}
