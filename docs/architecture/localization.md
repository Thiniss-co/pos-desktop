# Localization Foundation

The renderer bundles English and Arabic message catalogs with vue-i18n; language changes work
without a network connection. All visible shell, startup, activation, bootstrap, sync, settings,
company-user, and connectivity strings use catalog keys. Backend codes are localized by stable
code, never by comparing English messages.

## Supported locales

localeRegistry.ts is the single renderer registry:

| Code | Direction | Native name |
| --- | --- | --- |
| en | LTR | English |
| ar | RTL | العربية |

Adding a language means adding a JSON catalog and one registry row. Locale-specific presentation
uses Intl.NumberFormat and Intl.DateTimeFormat; money, quantity, tax arithmetic, database/API
identifiers, SKUs, permission codes, and logs remain locale-independent.

## Resolution and persistence

Locale preferences are stored only in main-process app_settings under ui.locale, via the
allowlisted preferences get-locale and set-locale IPC channels. The renderer never uses
localStorage or sessionStorage.

Initial resolution is:

1. Valid saved ui.locale.
2. Future authenticated-user preference; the backend contract has no locale field today.
3. Supported base language from navigator.language.
4. English.

A corrupt persisted locale resolves safely to English. If the IPC read fails, startup also uses
English rather than blocking the cashier. Before Vue mounts, main.ts applies the selected locale
and sets document.documentElement.lang and dir; this prevents an RTL flash.

## Error display

localizeAppError maps known backendCode values to errors.CODE, then maps transport and
configuration categories to local messages, then falls back to the sanitized backend message, then
to the localized generic error. Only displayed text changes; error category, retryability, backend
code, and trace ID retain their original values.

In practice the main-process normalizer (apiError.ts) only ever sets backendCode for a code this
app recognizes (isKnownApiErrorCode); a genuinely unrecognized backend code arrives with no
backendCode at all and is shown via its sanitized message, not the generic fallback. The
generic-fallback branch inside localizeAppError exists to guard a different, currently unreachable
case: a known code (apiErrorCodes.ts) added before its en/ar catalog entry. Both paths are covered
by tests, but they answer different questions — do not read "unknown backend code" test coverage as
proof of what a real unrecognized code renders.

The language switcher appears in both public and authenticated shells. CSS uses logical properties
so Arabic layout order and borders remain correct without mirroring the brand or non-directional
icons.
