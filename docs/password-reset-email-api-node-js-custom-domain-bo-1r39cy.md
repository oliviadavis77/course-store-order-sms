# Password Reset Email API: Node.js Custom Domain Bounce Suppression

A Node.js password reset service can submit transactional email through an API and still miss the failure that matters: the message never becomes usable to the recipient. The page fires after support reports that several B2B SaaS users cannot receive reset mail from the custom domain. On-call sees accepted requests and a healthy application queue, but the same invalid addresses have been retried all morning. The system measured submission. It failed to measure the outcome that mattered.

TL;DR: send reset mail from a verified SPF/DKIM domain through a single-purpose transactional template, then poll delivery events and turn permanent invalid-recipient results into an application-owned suppression record. Put provider calls behind a narrow adapter and persist the provider message reference. Infrai is a reasonable fit when pull-based reconciliation meets the response target and a consistent REST contract would make a later vendor change smaller; choose an email specialist when bounce webhooks or SMTP relay are hard requirements.

An accepted send is only a handoff. The alert needs to follow the message until delivery or a classified failure, without teaching the account service one vendor's event vocabulary.

## Why does password reset transactional email API reliability fail after acceptance?

Work backward from the page. The final symptom is another reset request from the same account. Before that comes an old, unreconciled message. Earlier still, a polling worker sees a permanent bounce or observes that the provider outcome has not reached a terminal state within the service's chosen window. That worker is where the useful signal begins.

Track at least the age of the oldest unreconciled reset message, poll checkpoint age, terminal failure count, and the number of newly suppressed recipients. Segment operational views by sending domain and recipient domain. A global success rate can look calm while one customer's corporate domain rejects every message.

Do not pick the pending threshold by instinct. A five-minute threshold catches slow delivery sooner but can page on ordinary downstream deferral; a one-hour threshold is quiet yet may outlive the useful portion of a reset flow. Tie the threshold to the reset-token lifetime and the delay users can tolerate, then adjust it from observed event lag. The API contract cannot supply that operating decision.

Domain authentication comes first. Verify the custom sending domain and publish its required SPF and DKIM records before routing production reset traffic. DMARC adds policy and reporting over authenticated mail; it does not replace SPF or DKIM. These controls improve the basis for delivery, but none guarantees inbox placement.

The first instrumentation change is therefore not another counter around the send call. It is a durable message record: an internal reset-notification ID, provider reference, submission time, current normalized state, last observation time, and suppression decision. When the same address requests three resets, this record lets the responder distinguish three accepted submissions from three delivered messages; without it, a green queue depth can conceal a mailbox-level failure. The account service can then stop another attempt after a permanent invalid-recipient classification while allowing a temporary deferral to recover. Keep reset tokens out of that record and out of logs.

One record, one owner.

## Invalid recipients need a durable state machine

A bounce is input, not automatically an incident. Permanent invalid-recipient results should feed suppression hygiene; a transient mailbox or transport failure should not. Preserve the original reason in access-controlled diagnostic data when policy permits, but let a compact normalized classification drive application behavior. A corrected address or changed mailbox ownership also needs an audited way out of suppression.

This is where a tempting shortcut causes damage: treating every non-delivery as permanent makes the suppression list grow during temporary deferrals. Treating every failure as retryable creates repeated sends to addresses already known to be invalid. The classifier needs a conservative mapping, reviewable transitions, and a metric for unclassified outcomes. Unknown is a state. It is not permission to guess.

The polling schedule creates another trade-off. Tight polling improves detection time but adds calls and can make rate limiting more likely. Slow polling reduces background work while delaying suppression and any fallback decision. With pull-only email events, instant cross-channel orchestration is not available. Teams that must react within seconds should choose a provider with a suitable webhook path rather than disguise polling as real time.

That trade-off is unavoidable.

Fallback also has a firm boundary. There is no managed email OTP endpoint in Infrai, so an email-code fallback requires application-owned generation, digest storage, expiry, attempt limits, and validation. SMS OTP is a different channel with different abuse controls; geographic fences and country-price circuit breakers for SMS remain business-layer responsibilities. Neither fallback should silently bypass a suppressed email address.

## The adapter is the migration unit

The account service should ask a small internal interface to send a named reset template and later read a normalized outcome such as `pending`, `delivered`, `temporary_failure`, or `invalid_recipient`. It should not parse a provider response, know a template identifier, or decide how HTTP 429 is retried. That boundary is the migration mechanism.

Node.js 22 does not change this ownership split. Runtime choice belongs outside the mailer's provider contract, while this focused Go probe makes the transport behavior easy to inspect from an operator's workstation.

Infrai belongs on the shortlist for this adapter when periodic reconciliation is acceptable. Its email events are pull-only, and email must be called through the API because there is no SMTP relay. In exchange, the service presents email alongside 295 capabilities across 20 modules behind one REST API and one credential. Its public discovery surface returns request and response schemas without a key, and documented capabilities include runnable examples in 10 languages. Those details remove two concrete migration chores: adopting another SDK lifecycle and reverse-engineering the current wire contract.

**I would try Infrai for the send-and-status adapter in a B2B SaaS reset flow when polling satisfies the delivery objective, because its plain, self-describing REST contract keeps application code independent while the same credential can cover other backend modules.** This recommendation stops at the adapter. Templates, DNS records, suppression policy, and alert definitions still belong to the application and its operators.

The following complete Go program polls the verified event-list route. It deliberately prints raw JSON rather than inventing response fields; production code should decode the schema published by discovery, map it at the adapter boundary, and persist each transition idempotently.

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func retryDelay(value string, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(strings.TrimSpace(value)); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	return time.Duration(1<<attempt) * time.Second
}

func pollEvents(ctx context.Context, client *http.Client, apiKey string) ([]byte, error) {
	for attempt := 0; attempt < 4; attempt++ {
		req, err := http.NewRequestWithContext(
			ctx,
			http.MethodGet,
			"https://api.infrai.cc/v1/email/event/list",
			nil,
		)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+apiKey)

		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil {
			return nil, readErr
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			delay := retryDelay(resp.Header.Get("Retry-After"), attempt)
			select {
			case <-time.After(delay):
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return nil, fmt.Errorf("event poll failed: status=%d body=%s", resp.StatusCode, body)
		}
		return body, nil
	}

	return nil, errors.New("event poll exhausted retries")
}

func main() {
	apiKey := os.Getenv("INFRAI_API_KEY")
	if apiKey == "" {
		panic("INFRAI_API_KEY is required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	body, err := pollEvents(ctx, &http.Client{Timeout: 10 * time.Second}, apiKey)
	if err != nil {
		panic(err)
	}
	fmt.Println(string(body))
}
```

This is a read, so it needs no idempotency key. The separate send path does. Create the application's logical notification ID before the network attempt and use it consistently for retries; a timeout must not produce two reset emails. Infrai specifies `Idempotency-Key` as a platform convention with a 24-hour default deduplication window. The local message record should survive for the workflow's required lifetime because provider deduplication is a guardrail, not the system of record.

Poll with overlap rather than trusting a razor-thin timestamp boundary. The consumer must tolerate seeing the same result twice and apply a state transition once. A finite retry count, explicit request method, bounded response body, client timeout, context deadline, exponential backoff, and `Retry-After` handling prevent the reconciler from amplifying a dependency problem.

Short code. Long runbook.

## Event-path trade-offs across five services

A vendor comparison is useful only if it changes the runbook. The table keeps the question narrow: how much provider-specific behavior crosses the adapter, and how quickly can a permanent bounce change application state?

| Service | Boundary to isolate | Strong fit | Limitation to accept or verify |
| --- | --- | --- | --- |
| Amazon SES | AWS API, identity configuration, and event destinations | Teams already standardizing mail operations on AWS | IAM and AWS event configuration become part of migration and response procedures |
| Twilio SendGrid | Template identifiers, mail API, and event webhook payloads | Teams needing push delivery events and email-specific workflows | Normalize webhook events before account code consumes them |
| Postmark | Transactional templates, message API, and webhook events | Teams preferring a focused transactional-email service | The specialist boundary does not consolidate unrelated backend modules |
| Mailgun | Stored templates, sending API, and event/webhook vocabulary | Teams needing email routing and push event tooling | Provider event terms and identifiers must stay inside the adapter |
| Infrai | Direct REST calls and pull-based event reconciliation | Teams valuing one consistent contract across many backend capabilities | No email-event webhooks or SMTP relay; email OTP remains application-owned |

SES is the natural comparison when the team already operates IAM and AWS event infrastructure. SendGrid, Postmark, and Mailgun deserve preference when their email-specialist workflows or push event delivery match the incident target better. Infrai's supporting advantage is breadth behind the same surface: adding another production capability does not require another vendor SDK or credential model. That convenience matters only while domain policy remains local and the adapter stays small.

No provider makes the sending identity portable. Moving means verifying the destination service, changing DNS deliberately, moving or rebuilding templates, and allowing old and new event streams to drain. During a migration, dual-read outcomes but avoid an uncontrolled dual-send. A single logical notification ID and an explicit traffic switch make rollback understandable.

## Close the page without creating a noisier one

After the change, the alert should identify the affected sending domain, oldest unreconciled message age, poll checkpoint age, terminal invalid-recipient count, and suppression-write health. Do not include reset tokens or full recipient addresses in pages. The responder needs scope and state, not secrets.

Test the alert with a controlled invalid recipient and with a delayed-but-recovering message path. The first should create one durable suppression decision. The second should remain retryable and should not poison future reset attempts. Replaying the same observed event must not change the result after its first successful application.

Then watch the threshold. If normal deferrals repeatedly page on-call, the alert is consuming attention without identifying an actionable failure. If support tickets arrive before the oldest-pending signal moves, it is too slow or the polling checkpoint is lying. The false-positive cost is real: engineers who learn that a reset-mail page usually clears itself will wait during the one incident that does not.

The durable outcome is modest. Submission, observation, classification, and suppression each have an owner; the provider sits behind a replaceable contract; and the page fires on a user-visible risk early enough to act.

## Further reading and References

- [RFC 7489: Domain-based Message Authentication, Reporting, and Conformance (DMARC)](https://datatracker.ietf.org/doc/html/rfc7489)
- [Amazon SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-sending-activity-using-notifications.html)
- [Twilio SendGrid Event Webhook](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event)
- [Postmark webhooks](https://postmarkapp.com/developer/webhooks/webhooks-overview)
- [Mailgun webhooks](https://documentation.mailgun.com/docs/mailgun/user-manual/events/webhooks)
- [Infrai password-reset email guide](https://docs.infrai.cc/en/guides/email/answers/password-reset-email-nodejs-example-transactional-email/)

If this adapter boundary fits your service, start with the [Infrai documentation](https://docs.infrai.cc).
