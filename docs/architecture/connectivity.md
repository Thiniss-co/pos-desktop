# Connectivity Monitoring

Connectivity is main-process-owned diagnostic state. It tells the UI whether the operating system
reports network access and whether the configured Laravel backend answers its public health probe.
It does not authorize sales, sync, authentication, or another business action.

## State and probe

| Status | Network | Backend | Meaning |
| --- | --- | --- | --- |
| checking | unknown or available | unknown | Startup or recheck in progress. |
| offline | unavailable | unknown | The OS reports no network connection. |
| backend_unreachable | available | unreachable | The backend health probe did not succeed. |
| online | available | reachable | GET /up returned HTTP 200 with status up, or a real desktop API request was answered. |

The health probe is intentionally separate from DesktopApiClient. It is unauthenticated, contains
no device UUID, and never sends an API envelope, response body, exception text, URL, or headers
through IPC. It is the documented exception to the desktop API namespace because Laravel registers
/up as an unauthenticated, side-effect-free readiness endpoint. A 3xx response is never followed —
the probe uses `redirect: 'manual'` so a redirected host cannot make itself look healthy.

The probe and DesktopApiClient share the same fetch implementation (Electron's `net.fetch`,
Chromium's stack) so they agree about system-proxy and OS-certificate-store behavior; if they used
different stacks, the banner could show `online` while every real request fails at transport, or
the reverse.

lastBackendReachableAt is diagnostic only. It must never be used as license validation time, next
validation time, or a server-time anchor. checkedAt reflects only the last actual /up probe — a
business-request outcome refreshes lastBackendReachableAt but never checkedAt, so the two fields
keep one unambiguous meaning each.

## Demand-driven probing

**There is no healthy polling loop.** A healthy device issues exactly one /up probe at startup and
then goes quiet: with hundreds of installed devices, a periodic health poll is pure, permanently
scaling backend load that buys nothing an actual request would not already reveal. A fresh verdict
is produced only when something is about to depend on it. (The one deliberate periodic request, the
signed-in [device heartbeat](#device-heartbeat), is presence reporting, not a health poll.)

A probe is issued when:

- the app starts;
- the machine resumes from sleep (`powerMonitor`);
- the main window regains focus **and** the current verdict is already stale;
- the renderer reports an OS `online` event, or the operator presses Retry;
- a real desktop API request fails at transport, or returns 5xx while the state is not `online`;
- `ensureFresh()` is called and the verdict is unsettled or older than the freshness TTL;
- the backend is unreachable and the backoff retry falls due.

`ensureFresh(maxAgeMs?)` is the entry point for "I am about to talk to the backend". It returns the
cached snapshot when the last observation is younger than the TTL, so calling it on every
backend-facing interaction costs no extra requests.

All timing dependencies are injected for Node tests:

| Knob | Default |
| --- | --- |
| Probe timeout | 5 seconds |
| Healthy polling | none — demand-driven only |
| Verdict freshness TTL | 60 seconds |
| Failure backoff | 5 seconds, exponential to 5 minutes |
| Backoff jitter | plus or minus 20 percent |
| Manual retry minimum gap | 2 seconds |

An in-flight probe is shared by concurrent callers; duplicate manual retries inside the minimum gap
return the current snapshot. Only startup, resume, and an explicit user retry bypass the minimum gap
(`force`); a request-driven or `ensureFresh` recheck still respects it, so a burst of failing
requests cannot drive the probe rate past the documented backoff. Backoff jitter is applied before
the cap is enforced, so the delay never exceeds the configured maximum. The retry-throttle and
freshness clocks are both monotonic (`performance.now()`), so a backward wall-clock adjustment
cannot re-open or extend either window. Shutdown clears timers, aborts the active probe, and removes
the power-monitor listener.

Only meaningful state changes are pushed to live windows. Timestamp refreshes do not flood IPC.

## Real traffic as the health observation

A desktop API response below HTTP 500 proves this device reached the backend with its own
credentials — stronger evidence than an unauthenticated /up probe. It therefore settles the state to
`online` (reason `request_observed`), refreshes the freshness window, and cancels any pending backoff
retry. This is what keeps an actively used device at zero probe traffic: its own requests are the
health signal, and /up is only the fallback for when there is no traffic to observe.

A 5xx is not a health verdict — it proves a transport path exists, so it refreshes the diagnostic
timestamp only, and leaves the decision to a throttled /up probe when the state is not already
`online`. `checkedAt` still reflects only an actual /up probe; `request_observed` never writes it, so
each field keeps one unambiguous meaning.

## Device heartbeat

`POST /api/v1/desktop/device/heartbeat` is **the deliberate, presence-only exception to "no
polling"**. It exists so the company dashboard can show which workstations are running while the
cashier is idle — something no demand-driven request can report, because by definition nothing is
being demanded. It is owned by the main process (`src/main/services/deviceHeartbeat.service.ts`,
wired in `src/main/app/deviceHeartbeatWiring.ts`); the renderer can neither trigger nor observe it.

It grants, denies and refreshes nothing: no local authority, license, permission or connectivity
verdict is derived from its outcome. Its responses pass through `DesktopApiClient`, so they are
observed by connectivity exactly like any other desktop request, and a session-ending answer ends
the session through the client's existing `onAuthenticatedFailure` hook.

**Signed-in only.** The endpoint is authenticated with the per-login desktop token
(`Authorization: Bearer` + `X-Device-UUID`). With no cashier session there is no credential, so a
logged-out device sends nothing and the dashboard shows it as last seen at logout. This is a known,
accepted limitation. Eligibility — authenticated session, device UUID and token all present — is
re-proven immediately before every send, and no request is ever made without a token. Page and shift
state are irrelevant.

| Rule | Value |
| --- | --- |
| First beat | Immediately when a session becomes eligible (login, or app start with a persisted session) |
| Interval after success | 120 seconds, plus or minus 10 percent |
| Minimum gap between request starts | 30 seconds, on every path |
| Failure backoff (transport, 5xx, 429/503 without a usable Retry-After) | 15 s × 2^(n−1), capped at 600 s, randomized to [0.5, 1] of that window |
| 429 / 503 with a valid `Retry-After` | Honored **in full** — no upper clamp (a 3-hour instruction waits 3 hours) |
| 403-class denial or `DESKTOP_TOKEN_DEVICE_MISMATCH` | Slow probe every 15 minutes, plus or minus 10 percent |
| Session-ending code (`SESSION_REVOKED`, `UNAUTHENTICATED`, ...) | Nothing further; the session hook ends the session |
| In flight | At most one request; at most one timer |

Every path that can send is bounded below by

```text
notBefore = max(lastStart + 30 s, retryAfterUntil, backoffUntil (backoff only), deniedProbeAt (denied only))
```

and only a *verified* access change while denied may lift the `deniedProbeAt` term (never the
others).

**Retry-After.** The central client parses `Retry-After` on every 429 and 503
(`parseRetryAfter` in `src/main/http/apiError.ts`) and exposes it as
`PublicAppError.retryAfterSeconds` alongside `httpStatus`. Delta-seconds are honored in full up to
`Number.MAX_SAFE_INTEGER / 1000`; an IMF-fixdate is measured against the response's own `Date` header
when present (so a skewed local clock cannot shorten the wait), otherwise against local time; a past
date means 0; anything malformed or negative is ignored and the normal backoff applies. A wait longer
than `setTimeout` allows (~24.8 days) is chained, never truncated. `Retry-After` and the 30-second
floor survive logout/login — a new session cannot bypass a server instruction.

**Nudges.** Resume and a connectivity transition into `online` may pull the next beat earlier, but
only in active mode, and never below `notBefore`. During backoff, Retry-After or denial they change
nothing.

**Access changes.** `CommercialAccessPublisher.onPublished` is a hint, not proof. While denied, an
early probe is sent only if a SHA-256 access fingerprint — session epoch, user/company/device binding,
registered device status, bootstrap permission list, and the current sell/sync decisions — differs
from the one recorded when the denial arrived. A connectivity-only denial is normalized out of the
fingerprint, so going online or offline is never mistaken for an access change. The fingerprint is
compared in memory only; it is never sent, logged or persisted.

**Suspend and resume.** Suspend drops the timer handle and keeps every deadline. Resume re-arms at
the stored deadlines and, in active mode only, requests an early probe (still ≥ `notBefore`).
Backoff, Retry-After and denied deadlines are unchanged by a sleep. A request that was on the wire
when the machine slept and then fails at transport does not escalate the backoff; it is rescheduled
at the current level. All timing uses a monotonic clock (`performance.now()`): where that clock does
not advance during sleep, a pending window is extended by the sleep duration — conservative, never
earlier.

**Sessions.** A new session epoch, or a change in eligibility, starts a new generation with a fresh
backoff and an immediate first beat (still subject to `notBefore`). A response that belongs to an
earlier generation — for example one that was in flight across logout/login — is ignored entirely.
Shutdown clears the timer, unsubscribes the power-monitor and access listeners, and ignores late
responses.

Logs are categorical only, never a token, UUID or fingerprint:
`[pos-heartbeat] event=... mode=... level=... next_in_s=...`. A healthy device logs its first beat
and each recovery, not every beat.

## IPC and renderer behavior

The typed preload surface exposes only connectivity getState, checkNow, and onChanged. Both invoke
handlers accept only undefined; the renderer cannot choose a URL, headers, timeout, or status. The
subscription is fixed to one shared channel and returns an unsubscribe closure.

The Pinia store does not optimistically write connectivity state. It presents a persistent offline
or backend-unavailable warning, delays checking copy for two seconds, and shows a four-second
restored notice only for an actual offline-to-online transition. Probe-driven recovery passes
through an intermediate `checking` snapshot on its way back to `online` (a `request_observed`
recovery jumps straight there), so the store tracks the last non-`checking` status rather than the
immediately preceding one — otherwise the toast, and the onBackendRestored hook exposed for a future
sync orchestrator, would never fire on the probe path. A `getState()` or
`checkNow()` reply is discarded if a pushed snapshot already landed while it was in flight, so a
slow initial read can never overwrite a newer broadcast state. This phase subscribes no sync
behavior to onBackendRestored.

## Future policy vocabulary

connectivityPolicy.contract.ts defines online_required, offline_capable_with_business_guards, and
local_only. Its helper is necessary but never authorization. License/commercial access, RBAC,
device binding, shift state, and local integrity remain separate main-process guards.
