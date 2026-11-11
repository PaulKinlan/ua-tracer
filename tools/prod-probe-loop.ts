// ON-DEMAND production end-to-end probe-hit loop (ua-tracer-68d, promoted by ua-tracer-grg).
//
// THIS SCRIPT IS IN NO GATE TIER, DELIBERATELY. It drives one headless Chrome against the
// LIVE site, so it needs the public network and it creates real (ordinary) traffic: a gate
// that ran it would make every landing depend on production being up, and would pollute
// production KV from CI. map_one() in tools/fast-gate.sh maps it to tests/gate_mapping_test.ts
// - the guards own the gate contract, not this harness - and tests/gate_mapping_test.ts
// asserts it never enters a tier.
//
//   deno run --allow-net --allow-env --allow-run=google-chrome --allow-read \
//     --allow-write=artifacts tools/prod-probe-loop.ts [--origin <url>]
//
// What it proves, per assertion:
//   A issued    - a real engine issuing the probe requests (Network.responseReceived)
//   B recorded  - the server recorded one hit per served probe response
//   C rendered  - the trace page renders each hit row + the "what this UA did" verdicts
//   D counts    - hits reconcile as page-visible probe responses + browser-delivered reports
//   E negative  - a gated/oversized probe id 404s, adds no hit row, and never 5xx
//
// Evidence (summary.json + screenshots) lands in artifacts/prod-probe-loop/, which is
// gitignored. One browser, closed in a `finally`; whole run ~15 s, hard-bounded by the
// caller (use `timeout -k 20 300`). Never set Deno.exit() here: it skips the `finally` and
// orphans the browser (learned the hard way in 68d).

// Repo root is the parent of tools/, so evidence lands next to the code that produced it
// wherever the checkout lives.
const REPO_ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

function flagValue(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}
if (Deno.args.includes("--help") || Deno.args.includes("-h")) {
  console.log(
    "usage: deno run --allow-net --allow-env --allow-run=google-chrome --allow-read " +
      "--allow-write=artifacts tools/prod-probe-loop.ts [--origin <url>]\n" +
      "  On-demand production check; NOT part of any gate tier (see the header comment).",
  );
  Deno.exit(0);
}
const ORIGIN = flagValue("--origin") ?? Deno.env.get("PROD_ORIGIN") ?? "https://uatracer.com";
const UA = "ua-tracer-prod-probe-loop/1.0 (+https://uatracer.com/traces)";
const ARTIFACT_DIR = `${REPO_ROOT}/artifacts/prod-probe-loop`;
const CHROME = Deno.env.get("CHROME_BIN") ?? "google-chrome";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

class Cdp {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  #waiters = new Map<string, ((params: Record<string, unknown>) => void)[]>();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => this.#dispatch(JSON.parse(ev.data as string) as CdpMessage);
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () => reject(new Error(`CDP websocket failed: ${url}`));
    });
  }

  #dispatch(msg: CdpMessage) {
    if (msg.id !== undefined) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    const key = msg.method ?? "";
    for (const fn of [...(this.#waiters.get(key) ?? [])]) fn(msg.params ?? {});
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    const id = this.#nextId++;
    const payload: CdpMessage = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#ws.send(JSON.stringify(payload));
    return p;
  }

  once(method: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        timeoutMs,
      );
      const list = this.#waiters.get(method) ?? [];
      const fn = (params: Record<string, unknown>) => {
        clearTimeout(timer);
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        resolve(params);
      };
      list.push(fn);
      this.#waiters.set(method, list);
    });
  }

  listen(method: string, fn: (params: Record<string, unknown>) => void) {
    const list = this.#waiters.get(method) ?? [];
    list.push(fn);
    this.#waiters.set(method, list);
  }

  close() {
    this.#ws.close();
  }
}

async function launchChrome(profileDir: string) {
  const child = new Deno.Command(CHROME, {
    args: [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      `--user-agent=${UA}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();

  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 30_000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const m = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) return { child, wsUrl: m[1] };
    }
  } finally {
    reader.releaseLock();
  }
  try {
    child.kill("SIGKILL");
  } catch { /* already gone */ }
  throw new Error(`chrome never reported a DevTools endpoint. stderr:\n${buffered.slice(-2000)}`);
}

const checks: { id: string; claim: string; ok: boolean; detail: unknown }[] = [];
function check(id: string, claim: string, ok: boolean, detail: unknown) {
  checks.push({ id, claim, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${claim} :: ${JSON.stringify(detail).slice(0, 400)}`);
}

const ev = async (cdp: Cdp, sessionId: string, expression: string) => {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  ) as { result: { value: unknown }; exceptionDetails?: { text?: string } };
  if (r.exceptionDetails) {
    throw new Error(`evaluate failed: ${r.exceptionDetails.text} :: ${expression}`);
  }
  return r.result.value;
};

const shot = async (cdp: Cdp, sessionId: string, name: string) => {
  const s = await cdp.send(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: true },
    sessionId,
  ) as {
    data: string;
  };
  const path = `${ARTIFACT_DIR}/${name}`;
  await Deno.writeFile(path, Uint8Array.from(atob(s.data), (c) => c.charCodeAt(0)));
  return path;
};

// Asset name -> the kind label the trace page renders for it (views.ts KIND_LABEL,
// keyed here by the probe file name so an issued request can be traced to a row).
const ASSET_KIND_LABEL: Record<string, string> = {
  "style.css": "CSS",
  "main.js": "JS",
  "module.js": "ES module",
  "js-ran.gif": "JS executed beacon",
  "module-ran.gif": "ES module executed",
  "photo.png": "image",
  "font.woff2": "font (HTML)",
  "css-bg.png": "CSS background-image",
  "css-font.woff2": "CSS @font-face",
  "import.css": "CSS @import (nested stylesheet)",
  "favicon.ico": "favicon",
  "apple-touch-icon.png": "apple-touch-icon",
  "manifest.json": "web app manifest",
  "manifest-icon.png": "manifest icon",
  "preload.png": "preload (image)",
  "prefetch.png": "prefetch",
  "og-image.png": "Open Graph image",
  "twitter-image.png": "Twitter card image",
  "iframe": "iframe document",
  "iframe-img.png": "image inside iframe",
  "timing": "client timing POST",
  "csp-report": "CSP violation report (POST)",
  "report": "Reporting API report (POST)",
};

// Kinds the "what this UA did" verdict block renders, keyed by the label it shows.
const VERDICTS = [
  "fetched CSS",
  "fetched JS",
  "fetched image",
  "fetched font (HTML)",
  "fetched favicon",
  "fetched web manifest",
  "fetched iframe document",
  "descended into iframe (loaded inner image)",
  "followed CSS background-image",
  "followed CSS @font-face",
  "followed CSS @import",
  "EXECUTED classic JS",
  "EXECUTED ES module",
  "posted client timing",
];

async function main() {
  await Deno.mkdir(ARTIFACT_DIR, { recursive: true });
  const profileDir = await Deno.makeTempDir({ dir: ARTIFACT_DIR, prefix: "chrome-profile-" });
  let cdp: Cdp | null = null;
  let child: Deno.ChildProcess | null = null;

  try {
    const launched = await launchChrome(profileDir);
    child = launched.child;
    cdp = await Cdp.connect(launched.wsUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }) as {
      targetId: string;
    };
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }) as {
      sessionId: string;
    };
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId);

    // Every response the engine received, with status: "issued" evidence.
    const responses: { url: string; status: number; type: string }[] = [];
    cdp.listen("Network.responseReceived", (params) => {
      const r = params.response as { url?: string; status?: number } | undefined;
      const type = (params.type as string | undefined) ?? "";
      if (r?.url) responses.push({ url: r.url, status: r.status ?? 0, type });
    });

    // ---- 1. mint a trace by loading the homepage in the real engine ----
    const homeLoaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/` }, sessionId);
    await homeLoaded;
    const homeShot = await shot(cdp, sessionId, "01-homepage.png");

    const cookie = await ev(cdp, sessionId, "document.cookie") as string;
    const traceId = /ua-tracer-trace=([A-Za-z0-9_-]+)/.exec(cookie)?.[1] ?? "";
    check(
      "A1",
      "the homepage minted a trace in a real browser (cookie)",
      /^[0-9A-Za-z_-]{4,64}$/.test(traceId),
      {
        traceId,
        cookie,
      },
    );

    // main.js posts its resource-timing payload 600ms after load; let the whole
    // sub-resource + beacon set settle before reading anything back.
    await new Promise((r) => setTimeout(r, 4000));

    // ---- 2. what the engine ISSUED ----
    const probePrefix = `/r/${traceId}/`;
    const issued = responses.filter((r) => r.url.includes(probePrefix));
    const issuedAssets = issued.map((r) => new URL(r.url).pathname.split("/").pop() ?? "");
    const issuedStatus = issued.map((r) => `${r.status} ${issuedAssets[issued.indexOf(r)]}`);
    const notOk = issued.filter((r) => {
      const asset = new URL(r.url).pathname.split("/").pop() ?? "";
      return r.status !== (/^(csp-report|report)$/.test(asset) ? 204 : 200);
    });
    check("A2", "the engine issued probe requests for the trace", issued.length >= 10, {
      count: issued.length,
      assets: issuedAssets,
    });
    check(
      "A3",
      "every issued probe response was served (200, or 204 for the report endpoints)",
      notOk.length === 0,
      {
        bad: notOk.map((r) => `${r.status} ${r.url}`),
        statuses: issuedStatus,
      },
    );
    for (
      const asset of [
        "style.css",
        "main.js",
        "js-ran.gif",
        "module-ran.gif",
        "iframe",
        "iframe-img.png",
        "timing",
      ]
    ) {
      check(`A4:${asset}`, `the engine issued the ${asset} probe`, issuedAssets.includes(asset), {
        seen: issuedAssets.includes(asset),
      });
    }

    // ---- 3. read the trace page back: recorded + rendered ----
    const detailLoaded = cdp.once("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: `${ORIGIN}/trace/${traceId}` }, sessionId);
    await detailLoaded;
    await new Promise((r) => setTimeout(r, 500));
    const traceShot = await shot(cdp, sessionId, "02-trace-page.png");

    const page = await ev(
      cdp,
      sessionId,
      `(() => {
      const rows = [...document.querySelectorAll("table tbody tr")].filter(tr => tr.querySelector(".badge.kind"));
      const kinds = rows.map(tr => tr.querySelector(".badge.kind").textContent.trim());
      const verdicts = [...document.querySelectorAll(".kinds .badge")].map(b => ({
        text: b.textContent.trim(), yes: b.classList.contains("yes"),
      }));
      const heading = (document.querySelector("h2") || {}).textContent || "";
      const waterfall = [...document.querySelectorAll("h2")].map(h => h.textContent.trim());
      const emptyNote = !!document.querySelector("p.empty");
      return { rowCount: rows.length, kinds, verdicts, heading, waterfall, emptyNote,
               bodyText: document.body.innerText.slice(0, 400) };
    })()`,
    ) as {
      rowCount: number;
      kinds: string[];
      verdicts: { text: string; yes: boolean }[];
      heading: string;
      waterfall: string[];
      emptyNote: boolean;
      bodyText: string;
    };

    // ---- Recorded: one hit row per served probe response ----
    // The page's network log does NOT contain every hit: a report-uri/report-to report
    // is delivered by the BROWSER, out of band, so Chrome records a report hit that
    // never appears as a page sub-request. That is why the gate's own journey expects
    // "20 hits / 19 probe responses": 19 page-visible probes + 1 browser-delivered
    // report. So the sound assertion is not rows == 1 + issued; it is (a) every issued
    // probe is recorded, (b) no phantom kinds, and (c) the only unexplained extra rows
    // are report deliveries.
    const kindLabels = new Set(Object.values(ASSET_KIND_LABEL));
    const issuedLabels = issuedAssets.map((a) => ASSET_KIND_LABEL[a]).filter(Boolean);
    const unrecorded = issuedLabels.filter((label) => !page.kinds.includes(label));
    const phantomKinds = page.kinds.filter((k) => k !== "homepage" && !kindLabels.has(k));
    const rowLabels = page.kinds.filter((k) => k !== "homepage");
    const reportRows = rowLabels.filter((k) =>
      k === ASSET_KIND_LABEL["csp-report"] || k === ASSET_KIND_LABEL["report"]
    );
    const pageVisibleReports = issuedAssets.filter((a) =>
      a === "csp-report" || a === "report"
    ).length;
    const outOfBandReports = reportRows.length - pageVisibleReports;
    const hits = page.rowCount - 1;
    check(
      "B1",
      "every probe the engine issued is recorded on the trace page",
      unrecorded.length === 0,
      {
        unrecorded,
        issuedLabels,
        kindsShown: page.kinds,
      },
    );
    check(
      "B2",
      "no hit row has a kind the probe contract does not define",
      phantomKinds.length === 0,
      {
        phantomKinds,
      },
    );
    check(
      "B3",
      "hits == page-visible probe responses + browser-delivered reports (only reports are out of band)",
      hits === issued.length + outOfBandReports && outOfBandReports >= 0 &&
        hits - reportRows.length === issued.length - pageVisibleReports,
      {
        hits,
        pageVisibleProbes: issued.length,
        reportRows: reportRows.length,
        pageVisibleReports,
        outOfBandReports,
        rowCount: page.rowCount,
      },
    );
    check(
      "B4",
      "the homepage request itself is recorded on the trace",
      page.kinds.includes("homepage"),
      {
        kinds: page.kinds,
      },
    );
    check(
      "B5",
      "the trace page is not an empty/not-found page",
      !page.emptyNote && page.rowCount > 0,
      {
        emptyNote: page.emptyNote,
        rowCount: page.rowCount,
        heading: page.heading,
      },
    );

    // Rendered: every verdict label exists, and the ones the engine earned are ✓.
    const verdictText = page.verdicts.map((v) => v.text.replace(/^[✓✗]\s*/, ""));
    const missingVerdicts = VERDICTS.filter((v) => !verdictText.includes(v));
    check(
      "C1",
      "the 'what this UA did' block renders every verdict label",
      missingVerdicts.length === 0,
      {
        missing: missingVerdicts,
      },
    );
    const verdictOf = (label: string) =>
      page.verdicts.find((v) => v.text.replace(/^[✓✗]\s*/, "") === label);
    const expectYes = [
      "fetched CSS",
      "fetched JS",
      "followed CSS background-image",
      "followed CSS @font-face",
      "followed CSS @import",
      "EXECUTED classic JS",
      "EXECUTED ES module",
      "posted client timing",
      "descended into iframe (loaded inner image)",
    ];
    const wrongVerdicts = expectYes.filter((label) => !verdictOf(label)?.yes);
    check(
      "C2",
      "every probe the engine performed renders as a ✓ verdict",
      wrongVerdicts.length === 0,
      {
        notYes: wrongVerdicts.map((l) => ({ label: l, rendered: verdictOf(l) })),
        verdicts: page.verdicts,
      },
    );
    check(
      "C3",
      "the client-side resource waterfall is rendered",
      page.waterfall.some((h) => h.includes("Client-side resource waterfall")),
      {
        sections: page.waterfall,
      },
    );

    // ---- 4. negative case: gated / oversized probe ids ----
    const negatives = [
      { label: "oversized id (65 chars)", path: `/r/${"a".repeat(65)}/style.css` },
      { label: "crafted id (quote + brace, percent-encoded)", path: `/r/abc%7D%22/style.css` },
      { label: "id with a dot", path: "/r/abc.def/style.css" },
    ];
    const negativeResults: {
      label: string;
      path: string;
      status: number;
      body: string;
      ct: string;
    }[] = [];
    for (const n of negatives) {
      const out = await ev(
        cdp,
        sessionId,
        `(async () => {
        const r = await fetch(${JSON.stringify(n.path)}, { cache: "no-store" });
        return { status: r.status, ct: r.headers.get("content-type") || "", body: (await r.text()).slice(0, 40) };
      })()`,
      ) as { status: number; ct: string; body: string };
      negativeResults.push({ label: n.label, path: n.path, ...out });
    }
    check(
      "E1",
      "a bogus/oversized probe id is rejected with 404 (never 5xx) and reflects nothing",
      negativeResults.every((r) => r.status === 404 && r.body.trim() === "Not found"),
      negativeResults,
    );
    const negativeShot = await shot(cdp, sessionId, "03-negative-404.png");

    // No hit row added: reload the trace page and compare the row count.
    const afterLoaded = cdp.once("Page.loadEventFired");
    await cdp.send(
      "Page.navigate",
      { url: `${ORIGIN}/trace/${traceId}?after=negative` },
      sessionId,
    );
    await afterLoaded;
    await new Promise((r) => setTimeout(r, 400));
    const after = await ev(
      cdp,
      sessionId,
      `(() => {
      const rows = [...document.querySelectorAll("table tbody tr")].filter(tr => tr.querySelector(".badge.kind"));
      return { rowCount: rows.length };
    })()`,
    ) as { rowCount: number };
    const afterShot = await shot(cdp, sessionId, "04-trace-page-after-negative.png");
    check("E2", "the rejected probes created no hit row", after.rowCount === page.rowCount, {
      before: page.rowCount,
      after: after.rowCount,
    });

    // ---- 5. artifact summary ----
    const summary = {
      bead: "ua-tracer-68d",
      ranAt: new Date().toISOString(),
      origin: ORIGIN,
      userAgent: UA,
      traceId,
      traceUrl: `${ORIGIN}/trace/${traceId}`,
      issued: {
        count: issued.length,
        assets: issuedAssets,
        statuses: issuedStatus,
        reportEndpoints: issued.filter((r) =>
          /\/(csp-report|report)$/.test(new URL(r.url).pathname)
        ).length,
      },
      recorded: {
        rowCount: page.rowCount,
        hits,
        kinds: page.kinds,
        unrecorded,
        phantomKinds,
        outOfBandReports,
      },
      rendered: {
        verdicts: page.verdicts,
        waterfallSections: page.waterfall,
        bodyTextPreview: page.bodyText,
      },
      negative: { results: negativeResults, rowsBefore: page.rowCount, rowsAfter: after.rowCount },
      checks,
      artifacts: { homeShot, traceShot, negativeShot, afterShot },
      notes: [
        "The probe font (css-font.woff2) is still undecodable in the deployed build dp4mdf2bayrb: ua-tracer-hik is fixed on fleet/verify-fix but not landed. The FETCH is still issued and recorded, so 'followed CSS @font-face' is ✓; only the font face fails to render.",
        "hits (rows - homepage) exceeds page-visible probe responses by the number of browser-delivered CSP/Reporting reports: report-uri/report-to delivery happens outside the page's network log. This reproduces the gate's documented 20 hits / 19 probe responses pattern.",
      ],
    };
    await Deno.writeTextFile(`${ARTIFACT_DIR}/summary.json`, JSON.stringify(summary, null, 2));

    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    console.log(
      `evidence: ${ARTIFACT_DIR}/summary.json, ${
        [homeShot, traceShot, negativeShot, afterShot].map((p) => p.split("/").pop()).join(", ")
      }`,
    );
    if (failed.length) {
      console.error(`FAILED: ${failed.map((f) => f.id).join(", ")}`);
      // NOT Deno.exit(): that terminates immediately and skips the `finally`, which
      // is how a stray headless Chrome outlived one run of this script.
      Deno.exitCode = 1;
    }
  } finally {
    cdp?.close();
    if (child) {
      try {
        child.kill("SIGKILL");
        await child.status;
      } catch { /* already gone */ }
    }
    await Deno.remove(profileDir, { recursive: true }).catch(() => {});
  }
}

await main();
