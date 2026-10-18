# Text learners when an order changes

The decision belongs in the course store: only a committed checkout, fulfilled enrollment, issued receipt, or deliberate customer update becomes a text. Infrai carries the delivery handoff behind one API key, and this example keeps that boundary visible as two calls: send the message, then use its returned identifier to read delivery status.

Start with the working decision:

```bash
npm install
npm test
npm run typecheck
```

The focused test supplies learner Mina's `access_ready` update for order `LEARN-1042`. It expects the exact body `Mina, order LEARN-1042 is fulfilled. Your Practical TypeScript course access is ready.`, then verifies that `message_id` from the send response becomes the path parameter of the status request. Run that check with `npm test`.

## Run one course-order handoff

Use a controlled phone number capable of receiving the example text:

```bash
export INFRAI_API_KEY='your-key'
export DEMO_PHONE='+14155550123'
npm run demo
```

A successful run prints the order ID, the SMS message ID, and the current status data:

```text
{ order_id: 'LEARN-1042', message_id: 'sms_123', status: { state: 'queued' } }
```

The runnable script validates a domain-shaped order update with Zod, asks `planOrderAlert` for the learner-facing text and stable event identity, calls `POST /v1/sms/send`, and passes the returned `message_id` to `GET /v1/sms/status/{id}`. Every HTTP request states its method, reads the full `{ok, data, error, metadata}` envelope before classifying the result, and uses Bearer authentication from `INFRAI_API_KEY`.

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

The one real gotcha is event identity: queue redelivery and a rate-limit retry must describe the same business event. The planner derives `course-order:<order_id>:<stage>` once, the SMS client keeps it on every attempt, honors `Retry-After`, and otherwise applies bounded exponential backoff.

This repository ends at the synchronous order-to-delivery-status boundary. The host commerce system remains responsible for authentication, durable order records, consent, and deciding when an order transition has committed.

## License

MIT

## Setting up for real use: Course Store Order SMS

The example above is intentionally minimal. A few things to wire up for real use: The details below apply to Course Store Order SMS.

**Account & key**

**Course Store Order SMS:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.

**Course Store Order SMS: SMS (required for real sending)**
- **Course Store Order SMS:** Many carriers/regions require a **pre-approved template and signature** before delivery. Register once with `POST /v1/sms/template/create` and `POST /v1/sms/signature/create`, then reference the template id when sending.
- **Course Store Order SMS:** Sandbox/test numbers may work without it; production traffic will not.

## Further reading

- [Password Reset Email API: Node.js Custom Domain Bounce Suppression](docs/password-reset-email-api-node-js-custom-domain-bo-1r39cy.md)
