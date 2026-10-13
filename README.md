# ua-tracer

A tiny instrument for answering a deceptively hard question: **when a user agent fetches a web page,
what does it actually do?** Does it download the CSS, JS, images, and fonts? Does it follow
resources that are _linked from_ those assets (a `background-image` or `@font-face` buried inside a
CSS file, an `<img>` inside an `<iframe>`, an `@import`)? Does it actually **execute** the
JavaScript — or just download the `.js` file and stop? And, crucially, **is it really the bot its
User-Agent claims to be**?

This matters most for crawlers — ClaudeBot, GPTBot, Googlebot, Bingbot, Applebot, and the long tail
of AI scrapers. ua-tracer lets you point any user agent at a URL and see, request by request,
exactly how far it went — and checks the source IP against the ranges the bot operator publishes so
you can tell a real crawler from a spoofed User-Agent.

Live at **[uatracer.com](https://uatracer.com)**. Built with Deno + Deno KV, hosted on Deno Deploy.
Styled after [aifoc.us](https://aifoc.us).

## How it works

Every `GET /` mints a unique **trace id** and a per-request **secret**, then renders an HTML page
whose assets all carry both in their path:

```
/r/{id}/{secret}/style.css     real stylesheet
/r/{id}/{secret}/main.js       real script
/r/{id}/{secret}/photo.png     real PNG  (referenced by <img>)
/r/{id}/{secret}/font.woff2    real woff2 (preloaded + used via CSS)
```

The id is unique per page load, so **every** later asset request ties back to the exact homepage hit
and the User-Agent that made it. The secret means only an agent that actually received the one-time
HTML can reach the probes — a crawler guessing `/r/{id}/...` can't fabricate hits. (Traces minted
before secrets existed keep the legacy `/r/{id}/...` form.)

On top of the direct assets, the page and its assets reference _further_ probes — this is where the
interesting signal comes from:

| Probe (`/r/{id}/{secret}/…`)               | Referenced from                                                             | Hitting it proves…                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `css-bg.png`                               | `background-image:` on a rendered element, inside `style.css`               | the UA parsed the CSS, rendered the box, and followed a URL inside it  |
| `css-font.woff2`                           | `@font-face { src: }` used by rendered text, inside `style.css`             | the UA resolved a CSS `@font-face` source                              |
| `import.css`                               | `@import` at the top of `style.css`                                         | the UA followed a CSS `@import`                                        |
| `manifest.json` → `manifest-icon.png`      | `<link rel="manifest">`, then `icons[].src` inside it                       | the UA fetched **and parsed** the web-app manifest                     |
| `favicon.ico` / `apple-touch-icon.png`     | `<link rel="icon">` / `<link rel="apple-touch-icon">`                       | the UA fetched the favicon / iOS home-screen icon                      |
| `preload.png` / `prefetch.png`             | `<link rel="preload" as="image">` / `<link rel="prefetch">`                 | the UA honoured a speculative preload / prefetch hint                  |
| `og-image.png` / `twitter-image.png`       | `<meta property="og:image">` / `<meta name="twitter:image">`                | a social unfurler fetched the Open Graph / Twitter card image          |
| the `<iframe>` document → `iframe-img.png` | `<iframe src>`, then an `<img>` inside that document                        | the UA loaded **and parsed** the subframe                              |
| `js-ran.gif`                               | `new Image().src = …` inside `main.js`, at runtime                          | the UA **executed** classic JS (not merely downloaded it)              |
| `module.js` → `module-ran.gif`             | `<script type="module">`, then a runtime beacon inside it                   | the UA **executed an ES module** (some run classic JS but not modules) |
| `csp-report` / `report`                    | a `report-uri` / `report-to` CSP directive                                  | the UA **enforced CSP** and posted a violation report                  |
| `timing`                                   | a `POST` from `main.js` carrying `performance.getEntriesByType('resource')` | a real engine ran and produced a client-side waterfall                 |

A plain downloader fetches the HTML and maybe the directly-referenced assets. A CSS-aware fetcher
also hits `css-bg.png` / `css-font.woff2` / `import.css`. A UA that parses the manifest reaches
`manifest-icon.png`. Social unfurlers (facebookexternalhit, Twitterbot, Slackbot, Discordbot,
LinkedInBot) tend to fetch the `og:image` / `twitter:image`. Only a UA that runs JavaScript ever
hits `js-ran.gif` / `module-ran.gif` or posts to `timing`.

Each endpoint logs the hit (trace id, asset kind, UA, IP, method, request headers with
credential-bearing values redacted, server timestamp) to **Deno KV**, then serves a real, valid
response of the correct content-type (real CSS/JS, a real PNG/GIF, a real woff2 — all
generated/embedded with `TextEncoder` / `Uint8Array` / `atob`, no Node `Buffer`).

## Is it really that bot? (IP-range verification)

A User-Agent string is trivially spoofable, so "is this really Googlebot?" can only be answered by
checking the source IP against the ranges the operator publishes. ua-tracer fetches and caches those
published CIDR lists daily and tags every bot hit:

- **verified** — the UA claims bot X and the client IP falls inside X's published range.
- **unverified** — the UA claims bot X but the IP is **not** in the range (a likely spoof).
- **unverifiable** — the UA claims a bot whose operator publishes **no** ranges, or its published
  ranges are temporarily unavailable; the claim can't be checked either way. Cold/expired fetches
  have a five-second deadline and retry on the next request without caching failed results.

Operators with published ranges that ua-tracer verifies against: **Googlebot, GPTBot, OAI-SearchBot,
Bingbot, ClaudeBot / Claude-User / Claude-SearchBot** (Anthropic publishes one list for all three),
and **Applebot**. `ChatGPT-User` publishes no ranges, so it is always _unverifiable_. The
[`backfill-verify`](#run-locally) task retroactively re-tags historical traces whenever ranges are
added or refreshed.

## Unsolicited & well-known requests

Beyond the per-trace probes, ua-tracer serves — and logs every request for — the "agent files" and
well-known paths crawlers look for on their own: `robots.txt`, `sitemap.xml`, `llms.txt` /
`llms-full.txt`, `/.well-known/ai.txt`, `security.txt`, `humans.txt`, `ai-plugin.json`,
`apple-app-site-association`, `favicon.ico`. These arrive **unsolicited** (nothing on the page links
them), so they reveal which agents probe for agent-directive files — and which don't. The
`/traces#unsolicited` view lists them, filterable by path.

## Pages

- **`/`** — mints a fresh trace on every load, and shows the recent-requests table (newest first:
  timestamp, User-Agent, IP, verification status, assets-fetched count, "JS ran?") plus a **By user
  agent** leaderboard of per-UA running counts. Filter with `?ua=<substring>`.
- **`/traces`** — the same browse view but **read-only**: it does _not_ mint a new trace or
  reference any probe assets, so you can browse the log without adding noise. Filter with
  `?ua=<substring>`, `?js=1` (only traces where JS ran), and `?path=<path>` (the `#unsolicited`
  well-known log); `#by-user-agent` is the per-UA aggregate, paginated via `?uap=` / `?p=`.
- **`/trace/{id}`** — full detail for one homepage hit: a server-side waterfall of every sub-request
  in receive order (delta-ms from the homepage hit, asset kind, UA, redacted headers), a summary of
  which asset _types_ were fetched, whether CSS-linked resources / the iframe were followed, whether
  classic JS and ES modules executed, the bot verification, and — if JS ran — the client-side
  resource-timing waterfall the page posted back.
- **`/api/health`** — `{ "ok": true, "ts": …, "build": … }`, where `build` is the Deno Deploy build
  id of the running revision (not the git commit sha; null off-platform). It changes on every
  deploy, so it answers "did my landing actually go live" from outside; the build id is mapped to a
  commit in the Deno Deploy console.

## How to use it

1. Open `/` in a browser (or `curl` it) to mint a trace. Note the trace id it shows, or watch
   `/traces`.
2. Point the user agent you want to test at a **freshly minted** homepage URL — e.g.
   `curl -A "ClaudeBot/1.0" https://uatracer.com/` — each load is its own trace.
3. Open `/trace/{id}` to read the result. The badges tell you at a glance what that UA fetched,
   whether it followed CSS-linked resources and the iframe, whether it executed JavaScript, and
   whether its IP verifies against the claimed bot.

> A fresh trace from `curl` only ever shows the homepage hit, because `curl` does not parse HTML/CSS
> or run JS. That _is_ the signal — compare it to a headless browser or a real crawler and the
> difference is the whole point.

## Storage (Deno KV)

State lives entirely in Deno KV (Deno Deploy isolates restart frequently — never in-memory maps):

```
["trace",  id]                 -> homepage TraceRecord (UA, IP, redacted headers, verification)
["hit",    id, tsKey]          -> each asset HitRecord (listed in receive order)
["recent", reverseTsKey, id]   -> recent-traces index; value is a denormalized TraceStats
                                  snapshot (asset count, jsRan, kinds) so the browse list and the
                                  per-UA counts render from a single list()
["ua"/"ua-agg", …]             -> per-user-agent running aggregates
["probe",  …]                  -> unsolicited / well-known request log
["botranges", name]            -> cached published CIDR list per operator (refreshed daily)
["x-report-body", …]           -> CSP violation report payloads
```

Sub-request hits bump the recent-index snapshot via an **atomic compare-and-set** (versionstamp)
retry loop, because many sub-requests for one trace arrive concurrently and a plain get→set would
race and lose updates. That is what keeps the Deno KV connection pool from being exhausted under
crawler load (which otherwise surfaces as `POOL_DEPLETED` 503s).

## Run locally

```sh
deno task dev      # http://localhost:8000, with --watch

deno task backfill         # one-off maintenance over stored traces
deno task backfill-verify  # retroactively re-tag traces with IP-range verification
```

## Tests and the gate

```sh
deno task test:fast    # fmt + lint + typecheck + only the suites a change affects
deno task test:full    # every suite, plus a real headless-Chrome journey
deno task test:file tests/http_test.ts   # one suite
```

Both tiers include `deno task check:all`. The suites are hermetic: they run against an in-memory
Deno KV (`tests/testenv.ts`) with no network, and the browser journey starts its own server
in-process on 127.0.0.1. `tools/fast-gate.sh` maps a changed path to the suites it affects and
**fails closed** — a path nobody has mapped exits non-zero and names the file. Budgets, the mapping
table and the measured timings are in [docs/speed.md](docs/speed.md).

## Deploy

Deployed to Deno Deploy from **GitHub**: the app is linked to this repository, so a push to `main`
builds and deploys, and the canonical domain is **uatracer.com** — requests arriving on the
`*.deno.net` deploy host are 301'd there (the health check is exempt) so search engines never index
the deploy URL. The entrypoint is `server.ts` (dynamic runtime). Include `[skip ci]` or
`[skip deploy]` in a commit message to deploy everything except that commit.

Two things must be true for a deploy to be a _working_ production deployment, and neither is visible
from a green build:

1. **A Deno KV database provisioned and assigned to the app.** `Deno.openKv()` is not
   auto-available; without it the build fails at the warmup step. This is a one-time, per-app step.
2. **`UA_TRACER_CRON=1` set in the app's Production context.** Without it [ua-tracer-2t9]'s hourly
   snapshot repair never registers and `/api/health` still reports `ok: true` — the cron's absence
   is only visible in the `repair` object (see below). The variable belongs to the _app_, not to
   this repository, so it travels with the app across deploys; setting it is a console action (or
   `deno deploy env add UA_TRACER_CRON 1`, which needs a token).

Linking the repository to the app is also a one-time console action (**Deno Deploy → the `ua-tracer`
app → Git integration → connect `PaulKinlan/ua-tracer`, production branch `main`**). The
`deno deploy` CLI cannot do it for an app that already exists — it accepts `--owner`/`--repo` only
when _creating_ an app (`deno deploy create --help`), so a linked app is created by the integration
or by the console, not adopted afterwards.

### If the link is lost, or for a fresh app

The manual path still works and is what a new app or a re-link needs first:

```sh
deno deploy database provision ua-tracer-kv --kind denokv --org <org>
deno deploy database assign    ua-tracer-kv --org <org> --app ua-tracer
deno deploy --org <org> --app ua-tracer --prod
```

The same CLI is the supported path for automatically deploying a _built_ tree from CI, if a build
step is ever needed: authenticate with `DENO_DEPLOY_TOKEN` (an organization token is enough) and
pass `--json --non-interactive` (Deno documents this mode for CI and agents, with stable exit
codes). That requires a long-lived deploy token in the repository's secrets, which is why the plain
GitHub integration above is the default — it needs no credential at all.

## Verifying a deploy

`/api/health` reports the platform's `DENO_DEPLOY_BUILD_ID` as `build` (ua-tracer-xk5), so a bounded
sample of it is enough to tell a deploy that rolled from one that did not — no console access, no
credentials:

```sh
deno run --allow-net deploy-check.ts                     # 5 samples over ~20s; exit 0 once a build id is present
deno run --allow-net deploy-check.ts --expect <build-id> # CHANGED (exit 0) vs UNCHANGED / unknown (exit 1)
```

It prints one line per sample (timestamp, HTTP status, the build value) so the output can be pasted
into a bead, and it exits non-zero while production is still not rolled. What it can and cannot tell
you: a present build id proves a revision that emits the field is serving, **not which commit** —
mapping a build id to a commit happens in the Deno Deploy console. An absent or `null` key on a
readable response means the revision answering predates the field, which is what a lagging or failed
deploy looks like from outside.

`.github/workflows/production-health.yml` runs those two checks on every push to `main`, with no
secrets: it requires a build id to be present (`deploy-check.ts`) **and** `repair.expected` to be
true, and its job summary carries the build id and the whole `repair` object. The second check is
the one that keeps a silent cron failure loud — it fails, naming the missing `UA_TRACER_CRON=1`,
rather than reporting the deployment healthy while the hourly repair has never run.

```sh
curl -fsS https://uatracer.com/api/health | jq '{build, ok, repair}'
# {"build":"…","ok":true,"repair":{"expected":true,"status":"ok","lastRun":…,"ageMs":…}}
```

## License

MIT © Paul Kinlan
