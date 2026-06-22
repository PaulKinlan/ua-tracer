# ua-tracer

A tiny instrument for answering a deceptively hard question: **when a user agent fetches a web page,
what does it actually do?** Does it download the CSS, JS, images, and fonts? Does it follow
resources that are _linked from_ those assets (a `background-image` or `@font-face` buried inside a
CSS file)? And does it actually **execute** the JavaScript — or just download the `.js` file and
stop?

This matters most for crawlers — ClaudeBot, GPTBot, Googlebot, Bingbot, and the long tail of AI
scrapers. ua-tracer lets you point any user agent at a URL and see, request by request, exactly how
far it went.

Built with Deno + Deno KV, hosted on Deno Deploy. Styled after [aifoc.us](https://aifoc.us).

## How it works

Every `GET /` mints a unique **trace id** and renders an HTML page whose assets all carry that id in
their path:

```
/r/{id}/style.css     real stylesheet
/r/{id}/main.js       real script
/r/{id}/photo.png     real PNG  (referenced by <img>)
/r/{id}/font.woff2    real woff2 (preloaded + used via CSS)
```

Because the id is unique per page load, **every** later asset request can be tied back to the exact
homepage hit and the User-Agent that made it.

On top of that, the assets reference _further_ probes — and this is where the interesting signal
comes from:

| Probe                          | Referenced from                                                             | Hitting it proves…                                                     |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `/r/{id}/css-bg.png`           | `background-image:` on a rendered element, inside `style.css`               | the UA parsed the CSS, rendered the box, and followed a URL inside it  |
| `/r/{id}/css-font.woff2`       | `@font-face { src: }` used by rendered text, inside `style.css`             | the UA resolved a CSS `@font-face` source                              |
| `/r/{id}/manifest.json`        | `<link rel="manifest">`                                                     | the UA fetched the web app manifest                                    |
| `/r/{id}/manifest-icon.png`    | `icons[].src` inside `manifest.json`                                        | the UA **parsed the manifest** and followed an icon linked from it     |
| `/r/{id}/favicon.ico`          | `<link rel="icon">`                                                         | the UA fetched the favicon                                             |
| `/r/{id}/apple-touch-icon.png` | `<link rel="apple-touch-icon">`                                             | the UA fetched the iOS home-screen icon                                |
| `/r/{id}/preload.png`          | `<link rel="preload" as="image">`                                           | the UA honoured a speculative preload hint                             |
| `/r/{id}/prefetch.png`         | `<link rel="prefetch">`                                                     | the UA honoured a speculative prefetch hint                            |
| `/r/{id}/og-image.png`         | `<meta property="og:image">`                                                | a social unfurler fetched the Open Graph image                         |
| `/r/{id}/twitter-image.png`    | `<meta name="twitter:image">`                                               | a social unfurler fetched the Twitter card image                       |
| `/r/{id}/js-ran.gif`           | `new Image().src = …` inside `main.js`, at runtime                          | the UA **executed** classic JS (not merely downloaded it)              |
| `/r/{id}/module-ran.gif`       | a runtime beacon inside an ES module (`<script type="module">`)             | the UA **executed an ES module** (some run classic JS but not modules) |
| `/r/{id}/timing`               | a `POST` from `main.js` carrying `performance.getEntriesByType('resource')` | a real engine ran and produced a client-side waterfall                 |

A plain downloader will fetch the HTML and maybe the directly-referenced assets. A CSS-aware fetcher
will additionally hit `css-bg.png` / `css-font.woff2`. A UA that parses the manifest reaches
`manifest-icon.png`. Social unfurlers (facebookexternalhit, Twitterbot, Slackbot, Discordbot,
LinkedInBot) tend to fetch the `og:image` / `twitter:image`. Only a UA that runs JavaScript will
ever hit `js-ran.gif` / `module-ran.gif` or post to `timing`.

Each asset endpoint logs the hit (trace id, asset kind, UA, IP, method, full request headers,
server-receive timestamp) to **Deno KV**, then serves a real, valid response of the correct
content-type (real CSS/JS, a real PNG/GIF, a real woff2 — all generated/embedded with
`TextEncoder`/`Uint8Array`/`atob`, no Node `Buffer`).

## Pages

- **`/`** — mints a fresh trace on every load, and shows a table of all past homepage requests
  (newest first): timestamp, User-Agent, IP, count of assets fetched, and a "JS ran?" indicator.
  Each row links to its trace.
- **`/trace/{id}`** — full detail for one homepage hit: a server-side waterfall of every sub-request
  in receive order (with delta-ms from the homepage hit, asset kind, UA, and headers), a summary of
  which asset _types_ were fetched, whether the CSS-linked resources were followed, whether JS
  executed, and — if JS ran — the client-side resource-timing waterfall it posted back.
- **`/api/health`** — `{ "ok": true }`.

## How to use it

1. Open `/` in a browser (or `curl` it) to mint a trace. Note the trace id it shows, or just watch
   the table.
2. Point the user agent you want to test at the **same** homepage URL — e.g.
   `curl -A "ClaudeBot/1.0" https://ua-tracer.example/` — each load is its own trace.
3. Open `/trace/{id}` to read the result. The badges tell you at a glance what that UA fetched,
   whether it followed CSS-linked resources, and whether it executed JavaScript.

> Note: a fresh trace from `curl` will only ever show the homepage hit, because `curl` does not
> parse HTML/CSS or run JS. That _is_ the signal — compare it to a headless browser or a crawler and
> the difference is the whole point.

## Storage (Deno KV)

```
["trace", id]                  -> homepage TraceRecord (UA, IP, full headers)
["hit",   id, tsKey]           -> each asset HitRecord (listed in receive order)
["recent", reverseTsKey, id]   -> recent-traces index; value is a denormalized
                                  TraceStats snapshot (asset count, jsRan, kinds)
```

The recent-index value holds a denormalized `TraceStats` snapshot so the homepage can render the
list **and** the per-user-agent running counts from a single `list()` — it never lists every trace's
hits. Sub-request hits bump that snapshot via an **atomic compare-and-set** (versionstamp) retry
loop, because many sub-requests for one trace arrive concurrently and a plain get→set would race and
lose updates. This is what keeps the Deno KV connection pool from being exhausted under crawler load
(which otherwise surfaces as `POOL_DEPLETED` 503s).

Deno Deploy isolates restart frequently, so state lives entirely in Deno KV — never in in-memory
maps.

## Filtering by user agent

The homepage shows a **By user agent** table with running request counts (and how many ran JS) per
UA. Click any row, or hit `/?ua=<substring>`, to filter the recent-requests list to matching user
agents — handy for isolating ClaudeBot / GPTBot / Googlebot activity.

## Run locally

```sh
deno task dev      # http://localhost:8000
```

## Deploy

Deployed to Deno Deploy (`ua-tracer.paulkinlan-ea.deno.net`). The entrypoint is `server.ts` (dynamic
runtime). It requires a **Deno KV database provisioned and assigned to the app** — `Deno.openKv()`
is not auto-available; without it the build fails at the warmup step. Provision and bind it once:

```sh
deno deploy database provision ua-tracer-kv --kind denokv --org <org>
deno deploy database assign  ua-tracer-kv --org <org> --app ua-tracer
```

Then deploy from a local checkout:

```sh
deno deploy --org <org> --app ua-tracer --prod
```

## License

MIT © Paul Kinlan
