import assert from "node:assert/strict";
import test from "node:test";
import { createInfraiSms } from "../src/infrai_sms.js";
import { orderUpdateSchema, planOrderAlert } from "../src/order_alerts.js";

test("a fulfilled course order becomes a precise learner alert", () => {
  const update = orderUpdateSchema.parse({
    stage: "access_ready",
    order_id: "LEARN-1042",
    customer_name: "Mina",
    phone: "+14155550123",
    course_title: "Practical TypeScript",
  });

  assert.deepEqual(planOrderAlert(update), {
    to: "+14155550123",
    body: "Mina, order LEARN-1042 is fulfilled. Your Practical TypeScript course access is ready.",
    idempotencyKey: "course-order:LEARN-1042:access_ready",
  });
});

test("message_id from send is handed to status and retained across a retry", async () => {
  const calls: Array<{ path: string; method: string; key: string | null }> = [];
  let sends = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, method: String(init?.method), key: new Headers(init?.headers).get("Idempotency-Key") });
    if (path === "/v1/sms/send" && sends++ === 0) {
      return new Response(JSON.stringify({ ok: false, error: { message: "retry later" } }), {
        status: 429,
        headers: { "Retry-After": "2" },
      });
    }
    if (path === "/v1/sms/send") {
      return new Response(JSON.stringify({ ok: true, data: { message_id: "sms_123" }, metadata: {} }));
    }
    return new Response(JSON.stringify({ ok: true, data: { state: "queued" }, metadata: {} }));
  };
  const sleeps: number[] = [];
  const client = createInfraiSms({
    apiKey: "test-key",
    baseUrl: "https://example.test",
    fetcher,
    sleep: async (milliseconds) => { sleeps.push(milliseconds); },
  });

  const result = await client.sendAndReadStatus({
    to: "+14155550123",
    body: "Course access is ready.",
    idempotencyKey: "course-order:LEARN-1042:access_ready",
  });

  assert.equal(result.messageId, "sms_123");
  assert.deepEqual(sleeps, [2000]);
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ["/v1/sms/send", "POST"],
    ["/v1/sms/send", "POST"],
    ["/v1/sms/status/sms_123", "GET"],
  ]);
  assert.equal(calls[0]?.key, calls[1]?.key);
});
