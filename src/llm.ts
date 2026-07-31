// LLM との契約（汎用インターフェース）。型だけを置き、実装は gemini.ts などのアダプタ側。
//
// スキーマ型をベンダのファイルに置くと、呼び出し側が Gemini というベンダに依存する。
// 差し替えたいのは gemini.ts の方なので、契約をここに出して依存を一方向にする。
//
//   llm.ts ←（型のみ）── gemini.ts（実装）

/**
 * responseSchema に渡せるスキーマ（OpenAPI のサブセット）。
 *
 * oneOf/anyOf は無い。そのためスキーマは union ではなく「type で分岐する 1 種類のオブジェクト」に寄せる。
 * 各社の structured output はいずれも JSON Schema の上位互換なので、この狭い共通部分なら移植しても通る。
 */
export type LlmResponseSchema = {
  type: string;
  description?: string;
  enum?: string[];
  nullable?: boolean;
  items?: LlmResponseSchema;
  properties?: Record<string, LlmResponseSchema>;
  required?: string[];
};

export type GenerateOptions = {
  apiKey: string;
  prompt: string;
  systemInstruction?: string;
  schema?: LlmResponseSchema;
  model?: string;
};
