// Slack 署名検証のテスト。唯一の認証境界なので、fail-closed が壊れていないかを見る。
//
// ここが逆に倒れると「誰でも Agent を叩ける」状態になるが、正常系だけ見ていると
// 気づけない（通ってしまう方向の壊れ方は、動作としては成功に見える）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { verifySlackRequest } from "../src/slack.ts";

const SECRET = "8f742231b10e8dc64b1e64c9c0e6b4f9";
const BODY = "token=xyz&team_id=T1&event=message";

/** Slack と同じ手順（v0:timestamp:body の HMAC-SHA256）で署名を作る。 */
async function sign(body: string, timestamp: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `v0=${hex}`;
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://example.com/slack/events", { method: "POST", headers, body });
}

const nowSec = () => Math.floor(Date.now() / 1000).toString();

test("正しい署名なら通り、body をそのまま返す", async () => {
  const ts = nowSec();
  const req = request(BODY, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(BODY, ts),
  });
  assert.deepEqual(await verifySlackRequest(req, SECRET), { ok: true, body: BODY });
});

test("body が 1 文字でも違えば拒否する", async () => {
  const ts = nowSec();
  const signature = await sign(BODY, ts);
  const req = request(BODY + "x", {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": signature,
  });
  assert.deepEqual(await verifySlackRequest(req, SECRET), { ok: false });
});

test("別のシークレットで署名されていれば拒否する", async () => {
  const ts = nowSec();
  const req = request(BODY, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(BODY, ts, "wrong-secret"),
  });
  assert.deepEqual(await verifySlackRequest(req, SECRET), { ok: false });
});

test("5 分より古いリクエストは拒否する（リプレイ対策）", async () => {
  const ts = (Math.floor(Date.now() / 1000) - 6 * 60).toString();
  const req = request(BODY, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(BODY, ts), // 署名自体は正しい
  });
  assert.deepEqual(await verifySlackRequest(req, SECRET), { ok: false });
});

test("未来方向に 5 分を超えるものも拒否する", async () => {
  const ts = (Math.floor(Date.now() / 1000) + 6 * 60).toString();
  const req = request(BODY, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(BODY, ts),
  });
  assert.deepEqual(await verifySlackRequest(req, SECRET), { ok: false });
});

test("ヘッダが欠けていれば拒否する", async () => {
  const ts = nowSec();
  const signature = await sign(BODY, ts);
  assert.deepEqual(
    await verifySlackRequest(request(BODY, { "x-slack-signature": signature }), SECRET),
    { ok: false },
  );
  assert.deepEqual(
    await verifySlackRequest(request(BODY, { "x-slack-request-timestamp": ts }), SECRET),
    { ok: false },
  );
  assert.deepEqual(await verifySlackRequest(request(BODY, {}), SECRET), { ok: false });
});

// fail-closed の確認。未設定を「検証できないので通す」に倒すと誰でも Agent を叩けるので、
// 署名が正しくても拒否する側に倒れていることを固定する。
test("シークレット未設定なら、署名が正しくても拒否する", async () => {
  const ts = nowSec();
  const req = request(BODY, {
    "x-slack-request-timestamp": ts,
    "x-slack-signature": await sign(BODY, ts),
  });
  assert.deepEqual(await verifySlackRequest(req, ""), { ok: false });
});
