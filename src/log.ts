// ログレベル付きの薄いロガー。
//
// エージェントの不具合は「何を受け取り、LLM がどう解釈し、何を実行しようとしたか」が
// 見えないと切り分けられない。verbose ではその 3 段をすべて出す。
//
// 出力先は console だけでよい。wrangler.jsonc で observability を有効にしてあるので
// Cloudflare 側に保存され、問題が起きた後からダッシュボードで検索できる
// （wrangler tail は流れているものしか見えない）。自前で貯める仕組みは要らない。
//
// 注意: verbose はカレンダーの内容やタスク名をそのまま含む。既定は info にしておき、
// 調査するときだけ上げること。

export type LogLevel = "error" | "info" | "verbose";

const ORDER: Record<LogLevel, number> = { error: 0, info: 1, verbose: 2 };

// 迷ったら静かな方に倒す。verbose を既定にすると個人情報が常時ログに出続ける。
const DEFAULT_LEVEL: LogLevel = "info";

// 1 行が長すぎるとログ基盤側で切られるので、こちらで先に丸めて全長を添える。
const MAX_DETAIL_CHARS = 2000;

export type Logger = {
  readonly level: LogLevel;
  error(event: string, detail?: unknown): void;
  info(event: string, detail?: unknown): void;
  verbose(event: string, detail?: unknown): void;
};

function parseLevel(raw: string | undefined): LogLevel {
  const value = raw?.trim().toLowerCase();
  if (value === "error" || value === "info" || value === "verbose") return value;
  if (value) {
    console.warn(`invalid LOG_LEVEL=${JSON.stringify(raw)}; falling back to ${DEFAULT_LEVEL}`);
  }
  return DEFAULT_LEVEL;
}

function format(detail: unknown): string {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  if (typeof text !== "string") return String(detail);
  return text.length > MAX_DETAIL_CHARS
    ? `${text.slice(0, MAX_DETAIL_CHARS)}…(全 ${text.length} 文字)`
    : text;
}

/**
 * env の LOG_LEVEL（wrangler.jsonc の vars）からロガーを作る。
 * 未設定・不正値は既定の info に倒す。
 */
export function createLogger(rawLevel: string | undefined): Logger {
  const level = parseLevel(rawLevel);

  const emit = (want: LogLevel, event: string, detail?: unknown) => {
    if (ORDER[want] > ORDER[level]) return;
    // イベント名は "領域.出来事" で揃える。あとで絞り込みやすくするため。
    const text = detail === undefined ? undefined : format(detail);
    const line = text === undefined ? `[${want}] ${event}` : `[${want}] ${event} ${text}`;
    if (want === "error") console.error(line);
    else console.log(line);
  };

  return {
    level,
    error: (event, detail) => emit("error", event, detail),
    info: (event, detail) => emit("info", event, detail),
    verbose: (event, detail) => emit("verbose", event, detail),
  };
}
