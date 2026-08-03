import { routeAgentRequest, getAgentByName } from "agents";
import { PersonalAssistantAgent, type Env } from "./agent";
import { verifySlackRequest } from "./slack";
import { createLogger } from "./log";

// wrangler.jsonc の durable_objects.bindings.class_name と対応させるため、
// Worker のエントリポイントから Agent クラスを re-export する必要がある。
export { PersonalAssistantAgent };

// 個人利用なので Agent instance は固定名 "ai-agent" を使う。
// 1 ユーザー = 1 インスタンス（詳細は CONCEPT.md 原則 1）。
const AGENT_NAME = "ai-agent";

/**
 * Worker はゲートウェイに徹する。
 * 署名検証と URL ルーティングだけを担当し、検証済みの payload だけを Agent に渡す。
 * ビジネスロジックは一切ここに置かない。
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // --- Slack Events API: メッセージ・メンションの受信 ---
    if (url.pathname === "/slack/events" && request.method === "POST") {
      const verified = await verifySlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!verified.ok) {
        return new Response("Unauthorized", { status: 401 });
      }

      const payload = JSON.parse(verified.body);

      // Slack Events API の URL 検証チャレンジ（初回登録時のみ）
      if (payload.type === "url_verification") {
        return Response.json({ challenge: payload.challenge });
      }

      // Slack がリトライしてきたかどうかは、この 2 ヘッダにしか現れない。
      // 同じ発言が二重に処理される類の不具合は、まずここを見て切り分ける。
      createLogger(env.LOG_LEVEL).verbose("slack.http", {
        event_id: payload.event_id,
        retry: request.headers.get("x-slack-retry-num"),
        reason: request.headers.get("x-slack-retry-reason"),
      });

      const agent = await getAgentByName<Env, PersonalAssistantAgent>(
        env.PersonalAssistantAgent,
        AGENT_NAME,
      );
      // Slack の 3 秒ルール対策: 即 200 を返し、実処理は背後で続ける。
      // 3 秒以内に応答しないと Slack はリトライしてくるので、
      // LLM 呼び出しをレスポンスの手前に置いてはいけない。
      ctx.waitUntil(agent.handleSlackEvent(payload));
      return Response.json({ ok: true });
    }

    // --- Slack Interactivity: ボタン押下（承認/却下）---
    if (url.pathname === "/slack/interactivity" && request.method === "POST") {
      const verified = await verifySlackRequest(request, env.SLACK_SIGNING_SECRET);
      if (!verified.ok) {
        return new Response("Unauthorized", { status: 401 });
      }

      // interactivity の body は application/x-www-form-urlencoded で payload=<JSON>。
      // events とは形式が違うので注意。
      const params = new URLSearchParams(verified.body);
      const raw = params.get("payload");
      if (!raw) return new Response("Bad Request", { status: 400 });
      const payload = JSON.parse(raw);

      const agent = await getAgentByName<Env, PersonalAssistantAgent>(
        env.PersonalAssistantAgent,
        AGENT_NAME,
      );
      // 即 200（空ボディ）。Slack はこれで元メッセージを変えない。
      // 元メッセージの差し替えは Agent 側が response_url で行う。
      ctx.waitUntil(agent.handleSlackInteraction(payload));
      return new Response("", { status: 200 });
    }

    // --- それ以外は Agents SDK のルーティングへ ---
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
