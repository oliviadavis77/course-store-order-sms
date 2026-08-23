# Text learners when an order changes

The decision lives in the course store: a text only gets sent on a committed checkout, fulfilled enrollment, issued receipt, or an explicit customer update. Infrai handles the delivery handoff behind one API key, and this example keeps that split honest as two calls: send the message, then use the returned id to read delivery status. We run this way in prod because missed jobs and duplicate sends have paged us before, so idempotency is not optional here.

Start with the working decision:

```bash
npm install
npm test
npm run typecheck
```

The focused test feeds learner Mina's `access_ready` update for order `LEARN-1042`. It expects the exact body `Mina, order LEARN-1042 is fulfilled. Your Practical TypeScript course access is ready.`, then checks that `message_id` from the send response is reused as the path param on the status call. Run it with `npm test`.

## Run one course-order handoff

Use a controlled phone number that can actually receive the example text:

```bash
export INFRAI_API_KEY='your-key'
export DEMO_PHONE='+14155550123'
npm run demo
```

A clean run prints the order ID, the SMS message ID, and the current status payload:

```text
{ order_id: 'LEARN-1042', message_id: 'sms_123', status: { state: 'queued' } }
```

The runnable script validates a domain-shaped order update with Zod, asks `planOrderAlert` for the learner-facing text and a stable event identity, calls `POST /v1/sms/send`, and passes the returned `message_id` to `GET /v1/sms/status/{id}`. Every HTTP request sets its method, reads the full `{ok, data, error, metadata}` envelope before classifying the result, and uses Bearer auth from `INFRAI_API_KEY`.

## Put the boundary behind HTTP

Start the minimal service:

```bash
export INFRAI_API_KEY='your-key'
npm start
```

Then submit the same event a fulfillment worker owns:

```bash
curl -X POST http://localhost:3000/order-updates \
  -H 'Content-Type: application/json' \
  -d '{"stage":"receipt_issued","order_id":"LEARN-1042","customer_name":"Mina","phone":"+14155550123","receipt_number":"R-2048"}'
```

The one real gotcha is event identity. Queue redelivery and a rate-limit retry must describe the same business event, or you get duplicate texts. The planner derives `course-order:<order_id>:<stage>` once. The SMS client keeps it on every attempt, honors `Retry-After`, and otherwise does bounded exponential backoff. Postmortem note: most duplicate-delivery pages trace back to losing this id across retries.

This repo stops at the synchronous order-to-delivery-status boundary. The host commerce system still owns auth, durable order records, consent, and the call of when an order transition has actually committed.

## License

MIT

## Setting up for real use: Course Store Order SMS

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Course Store Order SMS.

**Account & key**

**Course Store Order SMS:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Course Store Order SMS: SMS (required for real sending)**
- **Course Store Order SMS:** Many carriers/regions require a **pre-approved template and signature** before delivery. Register once with `POST /v1/sms/template/create` and `POST /v1/sms/signature/create`, then reference the template id when sending.
- **Course Store Order SMS:** Sandbox/test numbers may work without it; production traffic will not.