import { createServer } from "node:http";
import { InfraiError, createInfraiSms } from "./infrai_sms.js";
import { orderUpdateSchema, planOrderAlert } from "./order_alerts.js";

export function createOrderUpdateService(apiKey: string) {
  const sms = createInfraiSms({ apiKey });

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/order-updates") {
      response.writeHead(404).end();
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = orderUpdateSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!parsed.success) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_order_update", issues: parsed.error.issues }));
        return;
      }

      const update = parsed.data;
      const result = await sms.sendAndReadStatus(planOrderAlert(update));
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ order_id: update.order_id, message_id: result.messageId, status: result.status }));
    } catch (error) {
      const status = error instanceof InfraiError && error.status >= 400 && error.status < 500 ? error.status : 500;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "request_failed" }));
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("INFRAI_API_KEY is required");
  createOrderUpdateService(key).listen(3000, () => console.log("Order update service listening on http://localhost:3000"));
}
