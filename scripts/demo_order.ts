import { createInfraiSms } from "../src/infrai_sms.js";
import { orderUpdateSchema, planOrderAlert } from "../src/order_alerts.js";

const apiKey = process.env.INFRAI_API_KEY;
const phone = process.env.DEMO_PHONE;
if (!apiKey || !phone) throw new Error("INFRAI_API_KEY and DEMO_PHONE are required");

const update = orderUpdateSchema.parse({
  stage: "access_ready",
  order_id: "LEARN-1042",
  customer_name: "Mina",
  phone,
  course_title: "Practical TypeScript",
});

const result = await createInfraiSms({ apiKey }).sendAndReadStatus(planOrderAlert(update));
console.log({ order_id: update.order_id, message_id: result.messageId, status: result.status });
