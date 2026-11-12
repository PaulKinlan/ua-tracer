# THREAT_MODEL.md — ua-tracer

Bootstrapped from the code at `2932de4`, refs re-derived against `4a7888c` (2026-11-11). Every claim
below is grounded in the current source with `file:line` refs, and the refs are checked: a guard in
`tests/gate_mapping_test.ts` fails if a cited line leaves its file or if a backticked symbol on that
line is no longer beside the citation, so drift surfaces as a red gate rather than as a stale
pointer. Update this file whenever a trust boundary, input surface or mitigation moves. The guarded
counterpart to the product description in [README.md](README.md); gate mechanics live in
[docs/speed.md](docs/speed.md); AGENTS.md's "Request invariants" states the same contract in prose
for lanes.

## 1. System overview

ua-tracer answers "when a user agent fetches a page, what does it actually fetch and does it run the
JS?". It is a single Deno Deploy app (live at uatracer.com):

- `server.ts` is the only entrypoint (`handler`, server.ts:1051). `import.meta.main` guards the
  `Deno.serve` call (server.ts:1079-1085), so importing the file in a script or a test starts
  nothing. It routes every request, mints one trace per homepage GET, serves probe assets under
  `/r/{id}/{secret}/{asset}`, and applies response headers.
- `storage.ts` persists traces, hits and probe logs in Deno KV (schema at storage.ts:95-131).
- `bot-verification.ts` classifies claimed bots against operator-published CIDR ranges.
- `views.ts` renders all HTML; `probes.ts` generates the probe asset bodies.
- `crons.ts` registers an hourly snapshot-repair pass; `backfill.ts` / `backfill-verified.ts` are
  operator-run maintenance CLIs; `deploy-check.ts` is an operator-run deploy probe. Nothing imports
  these from the request path.
- No authentication, no accounts, no admin surface: every endpoint is public by design and the
  recorded corpus is public. There are no user secrets in the system (credential-shaped request
  headers are redacted before storage, storage.ts:22-31).

## 2. Trust boundaries and actors

```
Anonymous internet client (any UA, any headers, any URL, any POST body)
        │  HTTPS
        ▼
Deno Deploy edge ──► handler/routeHandler (server.ts:922,1051) ──► Deno KV (storage.ts)
        │                    │
        │                    ├─► operator-published bot-range feeds (HTTPS GET,
        │                    │   bot-verification.ts:117) — external data a verdict reads
        │                    └─► views.ts HTML ──► back to any client (public corpus)
Operator workstation ──► backfill CLIs / deno deploy (trusted; holds DENO_KV_URL)
```

Actors:

| Actor                                                             | Trust                        | Notes                                                                                            |
| ----------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Anonymous client                                                  | **Untrusted**                | Chooses UA, headers, cookies, URL path, POST bodies.                                             |
| Crawling UA's browser                                             | **Untrusted**                | Executes first-party probe JS we serve; its reports/timings are client-authored data.            |
| Bot-range feed operators (Google, OpenAI, Bing, Anthropic, Apple) | Trusted for verdict _inputs_ | Pinned HTTPS URLs (bot-verification.ts:11-49); their data decides `verified`.                    |
| Deno Deploy runtime                                               | Trusted infrastructure       | `info?.remoteAddr` (the connection peer) is the only address nobody can forge (server.ts:74-86). |
| Operator (Paul)                                                   | Trusted                      | Runs the backfill CLIs and deploys; holds KV credentials.                                        |

## 3. Explicitly trusted (non-threats — do not flag these)

- **The connection peer from `Deno.serve` info** (`peerIp`, server.ts:74): the runtime-reported TCP
  peer. It is the sole address a bot verdict may use; treat it as ground truth.
- **Server-minted identifiers**: `shortId()` (storage.ts:168, `crypto.getRandomValues`, 8 bytes over
  a 62-char alphabet) and the per-trace secret minted beside it (server.ts:573-574). Interpolating
  these into HTML or generated probe bodies is safe by construction.
- **Server-owned constants in templates**: `AssetKind` labels (`KIND_LABEL`, views.ts:944), badge
  classes, the inline stylesheet, and the fixed route strings. Only client-derived values need
  escaping (see invariant I3).
- **Inline `<style>` in page chrome and `style-src 'unsafe-inline'`** (views.ts:132, server.ts:116):
  deliberate; the probe page's report-only CSP violation is the experiment, not a defence gap.
- **The per-trace `Content-Security-Policy-Report-Only` header** (server.ts:643-665): it is a probe
  instrument to detect CSP-reporting UAs, never a security control.
- **The enforced baseline CSP on every response** (server.ts:107-134): first-party-only
  `default-src 'self'` (server.ts:107-134); the `data:` img-src and `unsafe-inline` style-src
  entries intentional and narrow.
- **Operator-local execution**: `deno task backfill*`, `deploy-check.ts`, tests (hermetic `:memory:`
  KV per tests/testenv.ts). Local KV and `DENO_KV_URL` are operator-held.
- **`/api/health` disclosures** (server.ts:934-961): build id, repair schedule state, timestamps —
  deliberately non-secret deploy-verification signals.
- **Probe assets served for unknown traces** (server.ts:411-417): serving a static asset body to a
  bot without recording a hit is intentional (probe reachability), not an information leak — the
  bodies are fixed or derived only from the (validated) path segments.

## 4. Untrusted attack surfaces

### 4.1 Claimed User-Agent (header; any bytes)

- Recorded on every trace/hit (server.ts:322, storage.ts:98), and on each hit (storage.ts:151);
  indexed as a KV key segment via `normUa` (storage.ts:212), which caps the segment itself
  (`MAX_TRACE_UA_CHARS = 200`, storage.ts:293) so a client-supplied lookup filter (`?ua=`,
  ua-tracer-72c) cannot mint an oversized key either; the stored field is also bounded before write
  (`boundSeedRecord` storage.ts:312, `boundRecord` storage.ts:402). An unbounded UA once broke the
  atomic on the key-size limit (ua-tracer-dpb shape).
- Rendered on every public page only through `escapeHtml` (views.ts:53) — attribute-safe (`"`, `'`
  escaped) in `title=` attributes and `<a>` hrefs that use `encodeURIComponent`.
- Drives bot classification by case-insensitive substring match (bot-verification.ts:173, 226): a
  fake UA can only ever obtain the verdict model's honest answers — `unverified` when ranges exist
  and the peer is outside them, else `unverifiable` (that verdict is returned at
  bot-verification.ts:160; the families with no published ranges are listed at
  bot-verification.ts:49-52, and the range-match rules are bot-verification.ts:90-99).

### 4.2 Claimed addresses: `x-forwarded-for`, `x-real-ip`

- Deno Deploy sets no forwarding header of its own; a client-supplied `x-forwarded-for` arrives
  verbatim (server.ts:82-87 comment, measured live 2026-10-13). So:
  - `clientIp` (server.ts:89) prefers the **connection peer**; claimed headers are recorded only
    when no peer exists, and then only as **recorded context, never verdict input**.
  - Verdicts use `peerIp(info)` exclusively: `classifyBot` is called with the peer address
    (server.ts:581); `classifyBot` documents `ip` must be the trusted peer,
    bot-verification.ts:156-161).
  - `backfill-verified.ts` refuses to republish `verified` for a stored trace whose IP matches a
    forwarding header in its own recorded headers (`storedIpSource`, backfill-verified.ts:94-105;
    case-insensitive compare via `sameAddress`, backfill-verified.ts:74, ua-tracer-4c9 and 9df9b9e)
    — re-tagging `unverifiable` instead.
- Accepted residual: a claimed address may be _stored_ and _displayed_ as data (bounded to 64 chars,
  storage.ts:279). It must never decide anything.

### 4.3 Probe URL segments: `/r/{id}[/{secret}]/{asset}`

- **Method contract** (ua-tracer-9jp): `allowedMethodsFor` (server.ts:807) is consulted before
  dispatch, so `OPTIONS` gets `204` + `Allow` and a method a path does not serve gets `405` +
  `Allow` instead of being run through a handler that serves the resource. Nothing about the request
  is reflected in either answer, it does not depend on whether an id exists, and no trace or hit is
  written. `/api/health` is answered above the gate and accepts any method.
- Router regexes split the path (server.ts:992-1007); `handleAsset` then gates both `id` and
  `secret` against `PROBE_SEGMENT = /^[0-9a-zA-Z_-]{1,64}$/` (server.ts:301-310) — exactly the
  alphabet `shortId()` mints — before any KV lookup, logging, or body generation. A crafted segment
  gets the same 404 a missing trace gets: nothing is reflected, nothing is logged (invariant I6 /
  ua-tracer-82v). The `/trace/{id}` read applies the same gate before its own lookup (server.ts:768)
  for the same reason the probe routes do: a segment that could not have been minted must never
  become a KV key part (ua-tracer-6v1).
- The secret check (server.ts:325-347) returns **404 indistinguishable from not-found** for a
  wrong/missing secret on a secret-bearing trace, and legacy `/r/{id}/…` URLs are refused for
  secret-bearing traces — probes cannot enumerate traces or secrets.
- Generated bodies that reflect `id`/`secret` (CSS url()/comments, JS, manifest, iframe HTML) do so
  only after `PROBE_SEGMENT` and, belt-and-braces, `cssSafeSegment` (probes.ts:22-35), which
  hex-escapes everything outside the alphabet so a segment can never close a CSS comment or string.

### 4.4 Trace cookie on `GET /` (`ua-tracer-trace`)

- The cookie is client-controlled text; only an id-shaped claim (`[a-zA-Z0-9_-]+`, ≤64 chars,
  server.ts:553-565) may become a KV key part, and a claim that misses simply mints a fresh trace.
  Reuse is an anti-spam measure (server.ts:543-570), not an auth mechanism. The cookie is
  `SameSite=Lax`, `Secure` on https (server.ts:661-665).

### 4.5 POST bodies: `/r/{id}/{secret}/timing`, `csp-report`, `report`

- The **read** is bounded first (`readBoundedBody`, server.ts:161; 32 KiB, below KV's 64 KiB value
  cap; declared-length refused pre-read, streaming abandoned mid-read → 413, server.ts:203-208). An
  over-limit post costs the payload, never the probe record (ua-tracer-0ms).
- `boundTiming` (server.ts:260) projects each attacker-shaped timing entry onto six known fields
  with per-field char caps and drops/truncates the rest, reporting the truncation into the reserved
  evidence namespace (`timingTruncated` evidence key, server.ts:382; the literal
  `x-timing-truncated` lives at storage.ts:68).
- CSP/Reporting bodies are stored under the reserved `x-report-body` key, sliced to 4000 chars
  (server.ts:407), and rendered escaped in the trace view (views.ts:985-1001 region).
- Malformed JSON is ignored (`catch`), never reflected raw.

### 4.6 Arbitrary request headers (all names, all values)

- Reach a record only through `clientHeaders` (storage.ts:85):
  - the **reserved evidence namespace** `x-report-*`, `x-timing-*`, `x-payload-` (storage.ts:44-58)
    is stripped — a client can never write a "server said" annotation (ua-tracer-0l9,
    ua-tracer-egg);
  - credential-shaped names are redacted (`SENSITIVE_HEADER_NAME`, storage.ts:22-31).
- The strip is **re-applied at the persistence boundary** (`withEvidence`, storage.ts:652-666), and
  evidence may enter only through the explicit `evidence` argument keyed by `EVIDENCE_KEYS`
  (storage.ts:61-71), stored lowercase (ua-tracer-t8v/bns). `tests/gate_mapping_test.ts` fails if a
  reserved name is written as a literal outside tests.
- Long header values are truncated (4096 chars, storage.ts:374) and the whole record is kept under
  `MAX_RECORD_BYTES` (48 KiB, storage.ts:287) with loud, non-fatal degradation (`boundRecord`,
  storage.ts:402; `storeRecordAlone`, storage.ts:594) so a KV rejection can never escape as a 500
  (ua-tracer-emp, ua-tracer-6zl).

### 4.7 Stored corpus rendered publicly (stored-XSS surface)

- Everything client-derived in KV (UA, header names/values, timing names, report bodies, probe
  paths, bot notes) is rendered through `escapeHtml` (views.ts:53) in every view; numeric fields are
  numbers; `kinds` come from the fixed `AssetKind` union. Probe-path display and filter links slice
  to the stored bounds first (views.ts:778-779, 842-843) — legacy unbounded rows predate the write
  bound.
- The waterfall (`traceDetailHtml`, views.ts:971) renders `escapeHtml(e.name)` etc.
  (views.ts:1080-1088).

### 4.8 External bot-range feeds (verdict inputs)

- Fetched only from pinned operator URLs (bot-verification.ts:11-49) with a 5 s timeout
  (bot-verification.ts:66), parsed leniently (`ipv4Prefix`/`ipv6Prefix` only,
  bot-verification.ts:141-143), cached in KV for 24 h (bot-verification.ts:65, 153-155).
- A hostile/compromised feed can only shift verdicts within the published model (make `unverified`
  look `verified` for its own family). It cannot inject code, records or HTML. A failed fetch
  degrades to `unverifiable` — never to `verified` (fail-closed, lines 156-161), and an empty set is
  never cached (lines 156-160).

### 4.9 Availability and write cost (unauthenticated writes)

- Every `GET /` mints a trace and every asset hit writes a record; there is no rate limit. The
  cookie-reuse path (4.4) caps one human browser's pollution. Per-record bounds (4.5, 4.6) cap the
  cost of any single write; listing endpoints are bounded scans (`recentTraces(200)`,
  `recentProbes(400)`; `searchTracesByUa` collects ≤2000, storage.ts:740-742).
- Counter updates use deadline-bounded compare-and-set (`casRetry`, storage.ts:269, 2 s budget) plus
  a single-transaction record+increment fold (`commitHit`, storage.ts:478), so concurrent hits
  cannot silently lose counts; losses degrade loudly and are repairable by `deno task backfill`
  (storage.ts:390-400 comment chain; ua-tracer-3re, -plx, -6sn).

## 5. Bug-shape hints from history

Past fixes concentrate on a few recurring shapes. The standing verification question for any new
change: **"was the fix applied at the boundary (storage/write path), and does the same shape recur
at the next ingress?"**

Git shas are backticked; `ua-tracer-*` ids are beads. Standing question: **"was the fix applied at
the boundary, and does the same shape recur at the next ingress?"** (it did recur — twice for the
evidence namespace, three times for address normalisation).

| Shape                                                  | Past instances (sha / bead)                                                                                                                                                                     | Guard today                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verdict minted from a forwarding header                | `6032598` (ua-tracer-8i2); backfill re-publishing stored client IPs `ed2d342` (ua-tracer-4c9)                                                                                                   | `peerIp`-only verdicts (server.ts:74); `storedIpSource` provenance re-tagging (backfill-verified.ts:94)                                                                          |
| Verdict falsehood from unchecked addresses             | `6041a17` ("unknown" → spoof), `c627bd1` (ua-tracer-917 IPv6 peer), `c3625c7` (ua-tracer-505), ua-tracer-94u (unfalsifiable bots)                                                               | fail-closed `unverifiable` branches (bot-verification.ts:163-225)                                                                                                                |
| Case/normalisation drift (`::FFFF:`, header spellings) | ua-tracer-5k6, then the third copy regressed as ua-tracer-7si (`9df9b9e`)                                                                                                                       | `unmapIpv4` case-insensitive (server.ts:67); `sameAddress` (backfill-verified.ts:74)                                                                                             |
| Reserved evidence name forged from the wire            | ua-tracer-0l9 (`d6f730c`); bypassed by new write paths → ua-tracer-egg (`d1e90d8`); mixed-case slip ua-tracer-fm6/t8v (`b7d1b0a`, `6beecc6`); bare truncation literal ua-tracer-4dh (`d43a4db`) | `EVIDENCE_KEYS` (storage.ts:44-58, 65) + `clientHeaders` (storage.ts:85) + `withEvidence` at the write (storage.ts:660); guard tests                                             |
| Stored XSS / reflection                                | ua-tracer-4p0 (P1, `368d463`: unescaped `initiatorType`, forwarded host poisoning og/twitter meta); ua-tracer-82v (`d981466`: crafted `/r/` segment reflected as text/css)                      | `escapeHtml` everywhere (views.ts:53); canonical/og meta URLs from `CANONICAL_ORIGIN` (views.ts:433, 599-600); `PROBE_SEGMENT` (server.ts:301) + `cssSafeSegment` (probes.ts:22) |
| Credential disclosure via stored headers               | ua-tracer-780 (P2, `7e28686`: Authorization/Cookie persisted and rendered)                                                                                                                      | redaction at ingest, at write, and re-applied on read (storage.ts:22-31)                                                                                                         |
| Unbounded unauthenticated writes / enumeration         | ua-tracer-0l8 (`97b0e6f`: orphan hits for unknown traces); ua-tracer-9v6 (wrong secret writes nothing)                                                                                          | unknown-trace probes serve but persist nothing (server.ts:411-417); indistinguishable 404s (server.ts:325-347); per-trace secret `5f5a472`                                       |
| Oversized client input → unhandled 500 / lost record   | ua-tracer-dpb (cookie key), ua-tracer-6zl (identity fields), ua-tracer-emp (rejected record), ua-tracer-0ms/`c6c1081` (bodies at the read), ua-tracer-6v1 (`/trace/{id}` key)                   | bounds before write + loud record-alone fallback (storage.ts:279-304, 394, 586; server.ts:158-208), and `PROBE_SEGMENT` before an id becomes a KV key (server.ts:301, 768)       |
| Silent counter loss under concurrency                  | ua-tracer-3re, -plx, -5ub, -6sn, -swf; accuracy-over-latency trade ua-tracer-c02                                                                                                                | CAS deadline + record/increment fold + unique hit keys (storage.ts:248-270, 470, 632)                                                                                            |
| Security headers on some exits only                    | ua-tracer-8mc (`f4ba76d` baseline, then `01c168d`/2932de4 at every exit)                                                                                                                        | `securityHeaders` at the `handler` wrapper (server.ts:1004-1017) and in `noStore`                                                                                                |

Still open, tracked (listed here so the gap is modelled, not rediscovered): **ua-tracer-sgz** —
legacy records already carrying a forged verdict in KV still render "verified" until a
`backfill-verify` run, because TraceStats has no provenance field to fail the display closed.

Closed after the bootstrap: **ua-tracer-uct** — a throw inside `routeHandler` used to escape as
Deno's bare default 500, which carries none of the baseline headers. `handler` now wraps the route
in a try/catch, substitutes a plain 500 on a throw and sets the baseline on it, and sets the
baseline on every other exit too (server.ts:1004-1017), so I9 holds for thrown requests as well.

## 6. Security invariants for auditors

- **I1 — Peer-only verdicts.** `classifyBot` is called with the connection peer (`peerIp`) or
  `null`, never with `clientIp`'s claimed-header fallback. A stored `verified` must be republishable
  only when `storedIpSource` says `"peer"` (backfill-verified.ts:94).
- **I2 — Reserved evidence namespace.** A header named `x-report-*` / `x-timing-*` / `x-payload-`
  can never enter a record from the wire; new annotations go into `EVIDENCE_KEYS` (storage.ts:65)
  and are written only via `logHit`'s `evidence` argument, stored lowercase. Never as literals at
  call sites (`gate_mapping_test` enforces).
- **I3 — Escape at render.** Every client-derived string in HTML passes `escapeHtml` (views.ts:53);
  attribute contexts additionally use `encodeURIComponent` for hrefs. Only server-minted ids and
  fixed enums interpolate raw. Generated CSS/JS reflect path segments only after `PROBE_SEGMENT` +
  `cssSafeSegment`.
- **I4 — Unenumerable secrets.** Wrong/missing secret and not-found are byte-identical 404s; legacy
  URLs are refused on secret-bearing traces (server.ts:325-347).
- **I5 — Bounded writes, loud degradation.** Every client-shaped field is bounded before a KV write
  (storage.ts:279-304, 374, 394); a record KV would reject must fall back to smaller forms with a
  warning, never throw off the request path.
- **I6 — Fail-closed verdicts.** An unresolvable range check (fetch failure, no peer, IPv6 peer, no
  published ranges) yields `unverifiable`, never `verified` (bot-verification.ts:163-225).
- **I7 — Credential redaction.** Credential-shaped header names are `[redacted]` before storage
  (storage.ts:22-31), re-applied at render (views.ts trace detail re-redacts).
- **I8 — Probe loss is loud.** Any dropped payload/truncated record is visible in the trace
  (reserved markers) and in warnings, and counts are re-derivable with `deno task backfill`.
- **I9 — Headers at every exit.** The defensive baseline (`securityHeaders`, server.ts:107) is
  applied at the `handler` wrapper for every response including errors/404s; `HEAD` returns GET's
  headers with an empty body.

## 7. Explicit exclusions (accepted risks / wontfix)

- **No authentication or rate limiting anywhere.** The public corpus _is_ the product; anyone may
  mint traces and hit probes at will. Mitigation is bounded write cost, not access control.
- **UA spoofing is undetectable in general.** For bots that publish no ranges (e.g. ChatGPT-User)
  the honest verdict is `unverifiable` by design; a `verified` claim is only as strong as the
  operator's published feed.
- **Claimed forwarding addresses are stored and shown as data** (never verdict input). Storing
  attacker-chosen text in a clearly-labelled field is intentional.
- **IPv6 peers are not range-matched** (verdict `unverifiable`, not "spoofed"): known, documented
  limitation (bot-verification.ts:186-199), fixed shape referenced as
  `tm-bot-verdict-ipv6-false-spoof`.
- **Inline `<style>` + `style-src 'unsafe-inline'`** for page chrome, and `img-src 'self' data:` in
  the enforced baseline: deliberate, narrow, reviewed here so scanners don't re-flag them.
- **Probe JS runs in arbitrary visitors' browsers**: first-party code only, no credentials or user
  data exist to steal; a hostile client "attacking itself" is out of scope.
- **`/api/health` reveals build id and repair state**: intentional deploy-verification surface, no
  secrets (server.ts:886-913).
- **IPs are recorded but not displayed** in list views today; surfacing them later must respect I7's
  redaction rules and the stored-bounds (I5).
- **The KV corpus is operator-visible via `DENO_KV_URL`**: trusted-operator surface, out of scope
  for the public threat model.
- **Legacy forged annotations/verdicts already in KV are not retro-scrubbed** (ua-tracer-egg
  deferred the legacy `x-report-*` rows; ua-tracer-sgz owns the display-side fail-close). New writes
  are clean; old rows are corrected by running `deno task backfill-verify`, not by code.
