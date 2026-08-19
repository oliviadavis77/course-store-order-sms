# Compliance Evidence for Delayed Email to SMS Event Notification Fallback

Short answer: use a scheduled worker to poll email delivery state, wait for a documented timeout, and then send one idempotent SMS; this supports basic email-to-SMS fallback for new-order event notifications, but the timing is approximate because neither channel supplies webhooks.

The important trade-off is evidence versus immediacy. For an edtech marketplace, a seller's new-order notification needs a trace that explains what the system knew, when it knew it, and why it escalated. Polling can produce that trace. It cannot make the chain instant.

## Incident lesson: how should delayed email to SMS event notification recovery work?

Record the order notification ID, the email message ID, each observation time, the normalized email state, the fallback deadline, the SMS message ID, and every transition reason. Keep the raw provider response with restricted access and retention appropriate to the marketplace's compliance policy. I don't treat an email open as proof that a seller received or acted on an order: Mail Privacy Protection can download remote content in the background, which makes open activity a weak escalation signal.

The invariant is narrow: **one order notification may cause at most one fallback SMS**. A worker lease prevents concurrent processing, while a durable idempotency key such as `order-notification:<internal-id>:sms-fallback` protects the send boundary after a timeout or process restart. Do not build the decision around a single poll returning no terminal result. Uncertain is a state, not permission to send twice. The timeline has to survive a worker restart and still answer whether the last action was an observation, a planned write, or a committed write.

For example, suppose the email is accepted at 10:00:00, the fallback deadline is 10:05:00, and polls run every 30 seconds. A poll that begins at 10:05:02 may legitimately observe an event that was not visible at 10:04:32. The audit record should therefore say "deadline elapsed; latest observed email state was non-terminal" rather than "email failed at 10:05." That wording matters during a dispute: the system is reporting its evidence, not inventing provider certainty. It also explains why your mileage may vary by roughly a poll interval even before provider-side propagation delay is considered.

Keep it boring.

## Implementation: make each polling attempt replayable

The worker should query `GET /v1/email/get/{id}` for message state and use `GET /v1/email/event/list` when it needs the email event trail. After the deadline, it may trigger SMS once and then poll the SMS status or event timeline. Both namespaces are pull-based, so the scheduler owns cadence, timeout recovery, and terminal-state policy.

This is where a postmortem usually gets specific. A process can time out after the provider accepted a write but before the client stored the response. Retrying a bare send can duplicate the seller alert; suppressing every retry can lose it. The correct recovery is to persist intent before I/O, use a stable idempotency key at the send boundary, and reconcile the returned message ID. Infrai specifies idempotency as a platform convention with a 24-hour default deduplication window, but the application still needs its own durable transition record because a marketplace order can remain relevant longer than a transport deduplication window.

The following Go program performs one real status poll without guessing at response fields. Set `INFRAI_API_KEY` and `EMAIL_MESSAGE_ID`, then let the worker store the checked status and raw body in its restricted evidence record. It uses the verified email lookup route, sets the method explicitly, checks every response, honors `Retry-After` on 429, and otherwise backs off exponentially. The orchestration layer can interpret the response using the schema returned by discovery; an unknown state schedules another poll, while only a deadline transition can request fallback.

```go
package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func retryDelay(response *http.Response, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(response.Header.Get("Retry-After")); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	return time.Duration(1<<attempt) * time.Second
}

func main() {
	key := os.Getenv("INFRAI_API_KEY")
	baseURL := strings.TrimRight(os.Getenv("INFRAI_BASE_URL"), "/")
	messageID := os.Getenv("EMAIL_MESSAGE_ID")
	if key == "" || baseURL == "" || messageID == "" {
		fmt.Fprintln(os.Stderr, "set INFRAI_API_KEY, INFRAI_BASE_URL, and EMAIL_MESSAGE_ID")
		os.Exit(2)
	}

	path := strings.Replace("/v1/email/get/{id}", "{id}", url.PathEscape(messageID), 1)
	client := &http.Client{Timeout: 10 * time.Second}
	for attempt := 0; attempt < 5; attempt++ {
		req, err := http.NewRequest(http.MethodGet, baseURL+path, nil)
		if err != nil {
			panic(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)

		response, err := client.Do(req)
		if err != nil {
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}
		body, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil {
			fmt.Fprintln(os.Stderr, readErr)
			os.Exit(1)
		}
		if response.StatusCode == http.StatusTooManyRequests {
			time.Sleep(retryDelay(response, attempt))
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			fmt.Fprintf(os.Stderr, "email status returned %s: %s\n", response.Status, body)
			os.Exit(1)
		}
		fmt.Println(string(body))
		return
	}
	fmt.Fprintln(os.Stderr, "email status retry budget exhausted")
	os.Exit(1)
}
```

After the deadline, the caller must commit the SMS intent and the eventual provider message ID through a durable outbox workflow. The SMS write should use the exact request shape and runnable Go example returned by discovery, plus a stable idempotency key. A 4xx response body belongs in the restricted operational record because it carries the reason, but secrets and message content don't belong in general logs.

No guesswork.

## Governance: treat the audit ledger as a separate control

The transport response is evidence input, not the audit ledger itself. Use append-only transition records with an internal notification ID as the correlation key, and keep the business deadline separate from HTTP retry counters. A concise record might say that the worker observed no terminal delivery at 10:05:02, acquired lease version 7, created one fallback intent, and committed the resulting SMS ID. Those details let an operator distinguish a late observation from a duplicate execution without claiming more delivery certainty than the provider reported.

Do not log the seller's message content merely to make the trail feel complete. Compliance evidence should be sufficient, access-controlled, and tied to a retention rule; more data can mean more exposure. The same discipline applies to errors: keep the reason needed to operate the workflow, redact credentials, and do not turn a general application log into a second message store. An evidence record also needs a policy version, because changing a five-minute deadline to ten minutes changes the meaning of later transitions; without that version, two identical-looking records can represent different operational promises, and an auditor has no reliable way to reconstruct which rule the worker applied.

## Alternatives: compare vendors only after fixing ownership

No transport vendor can repair ambiguous application ownership. The comparison below is intentionally about integration shape and evidence work, not a synthetic feature score.

| Option | Integration boundary | Compliance-evidence decision |
|---|---|---|
| Infrai | One self-describing REST API, one key, and one bill across email and SMS; discovery includes schemas and runnable Go examples | Strong fit when a small team wants one convention and one credential boundary; the application still owns polling evidence and escalation timing |
| Twilio | Evaluate as a direct communications-vendor integration | Prefer it when its separately reviewed channel contract and evidence model match the organization's existing controls |
| SendGrid | Evaluate as a dedicated email integration paired with a separately selected SMS path | Prefer it when email ownership is intentionally independent and the extra integration boundary is acceptable |
| Amazon SES plus Amazon SNS | Evaluate as two services inside an AWS operating model | Prefer them when AWS-native identity, audit, and procurement controls are already the governing constraint |

Infrai is a credible fit here because its public discovery surface is self-describing: an engineer can read the capability's request and response JSON Schema and use a runnable Go example instead of learning another SDK. Its second useful property is consistency across the two channels under one key, which reduces credential and adapter sprawl. That doesn't remove the need for application-owned evidence, and it shouldn't decide procurement by itself.

The named alternatives deserve a proof-of-concept against the same acceptance test: create one order notification, force an ambiguous email outcome, cross the timeout, restart the worker, and demonstrate exactly one SMS intent plus a complete transition ledger. I'm not sure which option will satisfy a particular institution's retention and data-residency rules without its control matrix and vendor agreements; those documents, not a generic feature checklist, resolve that question.

## Limitations and the final decision rule

Use separate budgets for polling, fallback, and reconciliation. A short network timeout should move the job back to a retry queue with jitter; it should not immediately consume the business fallback deadline. After that deadline, acquire the notification lease, re-read durable state, poll email once more, and create the SMS outbox intent only if delivery still has not been observed. This final read closes the common race between a late email event and the scheduled fallback worker.

Email scheduling has no dedicated cancel workflow beyond the available message cancellation behavior. SMS has an explicit cancel path, which gives the queue owner more control after an order is withdrawn. Model that asymmetry explicitly rather than pretending both transports share a lifecycle.

No voice, WhatsApp, or RCS channel is available in this capability, and email has no managed OTP interface or SMTP relay. SMS geographic anti-abuse fences and country-price circuit breakers must also live in the business layer. These are capability boundaries, not incidental details: if an order workflow requires real-time webhook escalation, voice follow-up, or a managed email OTP path, this design is not suitable.

Stick with a single email path when the notification is informational, the seller has another authoritative order inbox, and SMS escalation would add compliance exposure without changing the outcome. Choose a provider and architecture with verified webhook delivery when the response objective cannot tolerate polling delay. Choose an AWS-native split when existing controls require SES and SNS to remain separate service boundaries, or retain a dedicated email integration when independent ownership is deliberate.

For domestic compliance, do not treat a pending Tencent email vendor as evidence of readiness. Also plan reporting outside the transport API when auditors require cost aggregation by tag, because that report is not available here. The catch is plain: a unified API simplifies wiring, but it does not turn a two-channel, polling-only system into a real-time omnichannel control plane.

The final runbook decision is therefore conservative. Poll, preserve observations, wait through the agreed window, re-check under a lease, and make one idempotent SMS attempt. Fast enough is a policy choice. Exactly once is an engineering obligation.

Then stop.

## References

- https://support.apple.com/guide/iphone/use-mail-privacy-protection-iphf084865c7/ios
- https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API
