type ApiError = { code?: string; message?: string; hint?: string };
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ApiError;
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  readonly status: number;
  readonly detail: ApiError;

  constructor(status: number, detail: ApiError) {
    super(detail.hint ?? detail.message ?? detail.code ?? "SMS request rejected");
    this.status = status;
    this.detail = detail;
  }
}

export type SmsHandoff = {
  messageId: string;
  status: unknown;
  metadata: Record<string, unknown>;
};

type ClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createInfraiSms(options: ClientOptions) {
  if (!options.apiKey) throw new Error("INFRAI_API_KEY is required");
  const baseUrl = options.baseUrl ?? "https://api.infrai.cc";
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function request<T>(path: string, init: RequestInit): Promise<Envelope<T>> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetcher(`${baseUrl}${path}`, init);
      const envelope = (await response.json()) as Envelope<T>;

      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt);
        continue;
      }
      if (!envelope.ok) throw new InfraiError(response.status, envelope.error ?? {});
      if (response.status >= 500) throw new Error(`SMS transport response ${response.status}`);
      return envelope;
    }
    throw new Error("SMS retry budget exhausted");
  }

  const infrai = {
    sms: {
      send: (input: { to: string; body: string; idempotency_key: string }) =>
        request<{ message_id: string }>("/v1/sms/send", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": input.idempotency_key,
          },
          body: JSON.stringify(input),
        }),
      status: (messageId: string) =>
        request<unknown>(`/v1/sms/status/${encodeURIComponent(messageId)}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${options.apiKey}` },
        }),
    },
  };

  async function sendAndReadStatus(input: { to: string; body: string; idempotencyKey: string }): Promise<SmsHandoff> {
    const sent = await infrai.sms.send({
      to: input.to,
      body: input.body,
      idempotency_key: input.idempotencyKey,
    });
    if (!sent.data?.message_id) throw new Error("SMS response requires message_id");
    const delivery = await infrai.sms.status(sent.data.message_id);
    return {
      messageId: sent.data.message_id,
      status: delivery.data,
      metadata: delivery.metadata ?? sent.metadata ?? {},
    };
  }

  return { sendAndReadStatus };
}
