// Google Calendar 連携（サービスアカウント方式）。
//
// 外部サービスとの境界＝信頼と認証の設計。個人アシスタントに OAuth の同意画面を
// くぐらせるのは大げさなので、サービスアカウントにカレンダーを共有する方式を取る。
// ブラウザもリフレッシュトークンの保管も要らず、Worker から直接呼べる。
//
// 事前準備:
//   1. GCP でサービスアカウントを作成し、JSON 鍵をダウンロード
//   2. Google Calendar の設定 →「特定のユーザーと共有」に
//      サービスアカウントのメール (xxx@yyy.iam.gserviceaccount.com) を追加し、
//      「予定の変更権限」を付与
//   3. シークレットを登録:
//      GOOGLE_SERVICE_ACCOUNT_EMAIL = client_email
//      GOOGLE_PRIVATE_KEY           = private_key（PEM、改行込み）
//      GOOGLE_CALENDAR_ID           = 共有したカレンダーの ID（通常は自分のメールアドレス）

const TOKEN_URL = "https://oauth2.googleapis.com/token";
// calendar.events は予定の読み取り + 書き込みの両方を許可する。
// 書き込みは承認済みタスクの実行で使う。
const SCOPE = "https://www.googleapis.com/auth/calendar.events";

export type GoogleEnv = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CALENDAR_ID: string;
};

export type CalendarEvent = {
  id: string;
  summary: string;
  description?: string;
  start?: string;
  end?: string;
  location?: string;
};

// アクセストークンの簡易メモリキャッシュ（状態の第 3 層）。
// isolate のライフタイム内でしか生きないが、それでよい。永続化する価値のあるものではない。
let cachedToken: { token: string; expiresAt: number } | null = null;

// JWT は URL セーフな base64 を要求する（+/ を -_ に置換し、末尾のパディングを外す）。
function base64url(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  // secret に \n がエスケープされて入っている場合に備えて正規化する。
  // 外部連携で一番よく踏む地雷なので、ここで吸収しておく。
  const normalized = pem.replace(/\\n/g, "\n");
  const b64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

/**
 * サービスアカウントの秘密鍵で JWT を自前署名し、アクセストークンと交換する。
 * ライブラリは使わない（Workers は Node ランタイムではないので Web Crypto で完結させる）。
 */
async function getAccessToken(env: GoogleEnv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.token;
  }

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(env.GOOGLE_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: now + data.expires_in };
  return data.access_token;
}

/**
 * 直近の予定を取得する。「今」から先のものを時刻順に。
 */
export async function listUpcomingEvents(
  env: GoogleEnv,
  opts: { maxResults?: number } = {},
): Promise<CalendarEvent[]> {
  const token = await getAccessToken(env);
  const calendarId = encodeURIComponent(env.GOOGLE_CALENDAR_ID);
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    // 繰り返し予定を 1 件ずつに展開する。展開しないと「毎週の定例」が 1 件に見えてしまう。
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(opts.maxResults ?? 10),
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Calendar API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    items?: {
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }[];
  };

  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(無題)",
    description: e.description,
    // 終日予定は dateTime ではなく date に入る。
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location,
  }));
}
