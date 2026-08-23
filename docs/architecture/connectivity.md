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
| online | available | reachable | GET /up returned HTTP 200 with status up. |

The health probe is intentionally separate from DesktopApiClient. It is unauthenticated, contains
no device UUID, and never sends an API envelope, response body, exception text, URL, or headers
through IPC. It is the documented exception to the desktop API namespace because Laravel registers
/up as an unauthenticated, side-effect-free readiness endpoint.

lastBackendReachableAt is diagnostic only. It must never be used as license validation time, next
validation time, or a server-time anchor.

## Timing and lifecycle

All timing dependencies are injected for Node tests:

| Knob | Default |
| --- | --- |
| Probe timeout | 5 seconds |
| Healthy polling | 30 seconds |
| Failure backoff | 5 seconds, exponential to 60 seconds |
| Backoff jitter | plus or minus 20 percent |
| Manual retry minimum gap | 2 seconds |

Startup, Electron resume, renderer online hints, a real business-request transport failure, and the
Retry button request a recheck. An in-flight probe is shared by concurrent callers; duplicate
manual retries inside the minimum gap return the current snapshot. Shutdown clears timers, aborts
the active probe, and removes the power-monitor listener.

Only meaningful state changes are pushed to live windows. Timestamp refreshes do not flood IPC.
Any HTTP status from a real desktop API request proves a transport path exists; it refreshes the
diagnostic timestamp but does not replace /up as the authoritative backend-health decision.

## IPC and renderer behavior

The typed preload surface exposes only connectivity getState, checkNow, and onChanged. Both invoke
handlers accept only undefined; the renderer cannot choose a URL, headers, timeout, or status. The
subscription is fixed to one shared channel and returns an unsubscribe closure.

The Pinia store does not optimistically write connectivity state. It presents a persistent offline
or backend-unavailable warning, delays checking copy for two seconds, and shows a four-second
restored notice only for an actual offline-to-online transition. It also exposes an internal
onBackendRestored hook for a future sync orchestrator; this phase subscribes no sync behavior.

## Future policy vocabulary

connectivityPolicy.contract.ts defines online_required, offline_capable_with_business_guards, and
local_only. Its helper is necessary but never authorization. License/commercial access, RBAC,
device binding, shift state, and local integrity remain separate main-process guards.
