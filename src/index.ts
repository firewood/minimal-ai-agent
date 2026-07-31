import { routeAgentRequest } from "agents";
import { PersonalAssistantAgent, type Env } from "./agent";

// wrangler.jsonc の durable_objects.bindings.class_name と対応させるため、
// Worker のエントリポイントから Agent クラスを re-export する必要がある。
export { PersonalAssistantAgent };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // いまは Agents SDK 標準のルーティングだけ。
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
