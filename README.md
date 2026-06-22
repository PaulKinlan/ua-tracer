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

| Probe                    | Referenced from                                                             | Hitting it proves…                                     |
| ------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `/r/{id}/css-bg.png`     | `background-image:` inside `style.css`                                      | the UA parsed the CSS and followed a URL inside it     |
| `/r/{id}/css-font.woff2` | `@font-face { src: }` inside `style.css`                                    | the UA resolved a CSS `@font-face` source              |
| `/r/{id}/js-ran.gif`     | `new Image().src = …` inside `main.js`, at runtime                          | the UA **executed** the JS (not merely downloaded it)  |
| `/r/{id}/timing`         | a `POST` from `main.js` carrying `performance.getEntriesByType('resource')` | a real engine ran and produced a client-side waterfall |

A plain downloader will fetch the HTML and maybe the directly-referenced assets. A CSS-aware fetcher
will additionally hit `css-bg.png` / `css-font.woff2`. Only a UA that runs JavaScript will ever hit
`js-ran.gif` or post to `timing`.

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
["trace", id]                  -> homepage TraceRecord
["hit",   id, tsKey]           -> each asset HitRecord (listed in receive order)
["recent", reverseTsKey, id]   -> recent-traces index (newest first)
```

Deno Deploy isolates restart frequently, so state lives entirely in Deno KV — never in in-memory
maps.

## Run locally

```sh
deno task dev      # http://localhost:8000
```

## Deploy

Deployed to Deno Deploy. The entrypoint is `server.ts`; it needs `--allow-net` and Deno KV
(available automatically on Deno Deploy).

## License

MIT © Paul Kinlan
