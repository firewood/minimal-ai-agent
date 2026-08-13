// LLM との契約（汎用インターフェース）。型だけを置き、実装は gemini.ts などのアダプタ側。
//
// スキーマ型をベンダのファイルに置くと、行動空間を定義する actions.ts が Gemini に依存する。
// 差し替えたいのは gemini.ts の方なので、契約をここに出して依存を一方向にする。
//
//   llm.ts ←（型のみ）── gemini.ts（実装） / actions.ts（スキーマ）

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

/** 受け取った「まだ何者でもない値」を検証して T にする関数。失敗の扱いは渡す側が決める。 */
export type ResponseParser<T> = (value: unknown) => T;

export type GenerateOptions<T> = {
  apiKey: string;
  prompt: string;
  systemInstruction?: string;
  // schema は必須。生テキストを返す道は用意しない（そこだけ非決定的な出力を相手にすることになる）。
  schema: LlmResponseSchema;
  model?: string;
  // parse も必須。ここを通してしか値が出てこない形にすると、T は「検証した結果の型」になり、
  // as T のようなキャストが 1 つも要らなくなる（CONCEPT.md 原則 4「安全側に倒す」）。
  parse: ResponseParser<T>;
};

/**
 * LLM アダプタが満たすべき関数の形。
 * 差し替え先も `export const generate: Generate = ...` と書けば、契約から外れた時点で tsc が止める。
 */
export type Generate = <T>(opts: GenerateOptions<T>) => Promise<T>;
