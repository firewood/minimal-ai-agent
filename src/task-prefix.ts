// 行頭プレフィックスによる「明示的なタスク登録コマンド」の解析。
//
// LLM は頭脳、コードは手足——ただし例外がある。決まった書式で書かれたコマンドは、
// ユーザーが書式を選んだ時点で意思表示が済んでおり、意図を推定する余地がない。
// そこに LLM を挟むと、確認の問いかけやタイトルの言い換えが混ざって不確実になるだけ。
// だからここは自由文の解釈（LLM の仕事）ではなく、機械的に拾う純粋関数にする。
//
// 例: 「TODO: 資料をまとめる」「やること：請求書を送る」

// 認めるプレフィックス（大小文字は無視）。区切りは半角 ':' または全角 '：'。
const TASK_PREFIXES = ["todo", "task", "タスク", "やること"];

// 1 メッセージから作るタスクの上限（貼り付け事故で台帳を溢れさせない）。
const MAX_TASKS_PER_MESSAGE = 10;
// タスク名の上限（Slack のチェックボックスラベル上限にも収まる長さ）。
const MAX_TITLE_LEN = 200;

const PREFIX_RE = new RegExp(`^(?:${TASK_PREFIXES.join("|")})[:：]\\s*(.+)$`, "i");

/**
 * 各行を見て、プレフィックス付きの行からタスク名を取り出す。
 * 複数行書けば複数タスクになる。1 件も無ければ空配列（＝通常の会話として扱う）。
 */
export function parseTaskLines(text: string): string[] {
  if (!text) return [];
  const titles: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      // Slack のメンション（<@U123> / <!here> 等）は本文ではないので除く。
      .replace(/<[@!#][^>]*>/g, " ")
      // 箇条書き記号・引用記号を除く。
      .replace(/^[\s>*・•-]+/, "")
      .trim();
    const matched = line.match(PREFIX_RE);
    if (!matched) continue;
    const title = matched[1].trim().slice(0, MAX_TITLE_LEN);
    if (title) titles.push(title);
    if (titles.length >= MAX_TASKS_PER_MESSAGE) break;
  }
  return titles;
}
