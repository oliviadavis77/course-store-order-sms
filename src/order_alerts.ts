import { z } from "zod";

export const orderUpdateSchema = z.discriminatedUnion("stage", [
  z.object({
    stage: z.literal("checkout_confirmed"),
    order_id: z.string().min(1),
    customer_name: z.string().min(1),
    phone: z.string().min(8),
    course_title: z.string().min(1),
  }),
  z.object({
    stage: z.literal("access_ready"),
    order_id: z.string().min(1),
    customer_name: z.string().min(1),
    phone: z.string().min(8),
    course_title: z.string().min(1),
  }),
  z.object({
    stage: z.literal("receipt_issued"),
    order_id: z.string().min(1),
    customer_name: z.string().min(1),
    phone: z.string().min(8),
    receipt_number: z.string().min(1),
  }),
  z.object({
    stage: z.literal("customer_update"),
    order_id: z.string().min(1),
    customer_name: z.string().min(1),
    phone: z.string().min(8),
    update_text: z.string().min(1).max(240),
  }),
]);

export type OrderUpdate = z.infer<typeof orderUpdateSchema>;

export type AlertPlan = {
  to: string;
  body: string;
  idempotencyKey: string;
};

export function planOrderAlert(update: OrderUpdate): AlertPlan {
  const prefix = `${update.customer_name}, order ${update.order_id}`;
  let body: string;

  switch (update.stage) {
    case "checkout_confirmed":
      body = `${prefix} is confirmed for ${update.course_title}.`;
      break;
    case "access_ready":
      body = `${prefix} is fulfilled. Your ${update.course_title} course access is ready.`;
      break;
    case "receipt_issued":
      body = `${prefix} receipt ${update.receipt_number} is ready.`;
      break;
    case "customer_update":
      body = `${prefix}: ${update.update_text}`;
      break;
  }

  return {
    to: update.phone,
    body,
    idempotencyKey: `course-order:${update.order_id}:${update.stage}`,
  };
}
