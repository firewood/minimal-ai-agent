// Slack の署名検証（Web Crypto のみ。Node 依存なし）
// https://api.slack.com/authentication/verifying-requests-from-slack
//
// エージェント本体ではなく「入口の門番」として独立させている。
// Worker はここを通ったリクエストしか Agent に渡さない。

export type VerifyResult = { ok: true; body: string } | { ok: false };

const FIVE_MINUTES = 60 * 5;

export async function verifySlackRequest(
  request: Request,
  signingSecret: string,
): Promise<VerifyResult> {
  // シークレット未設定なら「通す」ではなく「拒否する」（fail-closed / CONCEPT.md 原則 4「安全側に倒す」）。
  if (!signingSecret) {
    console.error(
      "SLACK_SIGNING_SECRET is not set. Run `wrangler secret put SLACK_SIGNING_SECRET` and redeploy.",
    );
    return { ok: false };
  }

  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");
  if (!timestamp || !signature) return { ok: false };

  // リプレイ攻撃対策: 5 分以上前のリクエストは拒否
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > FIVE_MINUTES) return { ok: false };

  const body = await request.text();
  const basestring = `v0:${timestamp}:${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(basestring),
  );
  const expected = "v0=" + bufferToHex(mac);

  if (!timingSafeEqual(expected, signature)) return { ok: false };
  return { ok: true, body };
}

function bufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 比較にかかる時間から署名を推測されないよう、常に全桁を比較する。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
