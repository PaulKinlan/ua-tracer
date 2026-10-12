// Real-browser acceptance journey (FULL gate only — it launches Chrome, so it is
// deliberately not part of the fast suites).
//
// Everything above this test is contract-level: it proves the server does the
// right thing when *asked*. This test proves the mechanism works when a real
// engine drives it: a headless Chrome loads the minted homepage, parses the
// stylesheet, follows the CSS-linked probes, descends into the iframe, executes
// the classic script and the ES module, and posts its resource timing — and the
// server records each of those as a distinct hit on the same trace.
//
// Hermeticity: the server runs in this process against the in-memory KV, on
// 127.0.0.1, and Chrome gets a throwaway profile. No production KV, no public
// network, one browser, closed in a `finally`.

import { clearKv, testKv } from "./testenv.ts";
import {
  handler,
  type HitRecord,
  recentIndexKey,
  type TraceRecord,
  type TraceStats,
} from "../server.ts";

const CHROME = Deno.env.get("CHROME_BIN") ?? "google-chrome";
const UA = "ua-tracer-browser-journey/1.0";

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** Minimal CDP client over the browser WebSocket (flattened sessions). */
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
    for (const fn of this.#waiters.get(key) ?? []) fn(msg.params ?? {});
    this.#waiters.delete(key);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const payload: CdpMessage = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const p = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#ws.send(JSON.stringify(payload));
    return p;
  }

  /** Resolve on the next occurrence of a CDP event (optionally session-scoped). */
  once(method: string, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${method}`)),
        timeoutMs,
      );
      const list = this.#waiters.get(method) ?? [];
      list.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      this.#waiters.set(method, list);
    });
  }

  close() {
    this.#ws.close();
  }
}

async function launchChrome(
  profileDir: string,
): Promise<{ child: Deno.ChildProcess; wsUrl: string }> {
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

  // Chrome prints "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/…".
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

Deno.test({
  name: "browser journey: a real engine fetch, parse, follow and execute is fully traced",
  // One browser, one bounded run; never parallel with itself.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await clearKv();
    const kv = await testKv();

    const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, handler);
    const origin = `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`;
    const artifactDir = `artifacts/browser-journey`;
    await Deno.mkdir(artifactDir, { recursive: true });
    // Chrome's profile lives under the (gitignored) artifacts dir in the tree,
    // not /tmp: an orphaned profile then cannot fill a tmpfs, and it is cleaned
    // up next to the evidence it produced.
    const profileDir = await Deno.makeTempDir({ dir: artifactDir, prefix: "chrome-profile-" });

    let cdp: Cdp | null = null;
    let child: Deno.ChildProcess | null = null;
    try {
      const launched = await launchChrome(profileDir);
      child = launched.child;
      cdp = await Cdp.connect(launched.wsUrl);

      const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }) as {
        targetId: string;
      };
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      }) as { sessionId: string };
      await cdp.send("Page.enable", {}, sessionId);
      await cdp.send("Runtime.enable", {}, sessionId);

      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.navigate", { url: `${origin}/` }, sessionId);
      await loaded;

      // main.js posts its timing waterfall 600ms after load; give the whole
      // sub-resource set a bounded moment to settle before asserting.
      await new Promise((r) => setTimeout(r, 2500));

      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId) as {
        data: string;
      };
      await Deno.writeFile(
        `${artifactDir}/screenshot.png`,
        Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)),
      );
      const title = await cdp.send(
        "Runtime.evaluate",
        { expression: "document.title", returnByValue: true },
        sessionId,
      ) as { result: { value: string } };
      if (!title.result.value) throw new Error("page has no title");

      // --- the actual acceptance assertions, read back from the server's KV ---
      const traces: TraceRecord[] = [];
      for await (const entry of kv.list<TraceRecord>({ prefix: ["trace"] })) {
        traces.push(entry.value);
      }
      if (traces.length !== 1) throw new Error(`expected exactly one trace, got ${traces.length}`);
      const trace = traces[0];
      if (trace.ua !== UA) throw new Error(`trace UA ${trace.ua}`);
      if (!trace.secret) throw new Error("trace has no secret");

      const hits: HitRecord[] = [];
      for await (const entry of kv.list<HitRecord>({ prefix: ["hit", trace.id] })) {
        hits.push(entry.value);
      }
      const kinds = new Set(hits.map((h) => h.kind));
      // The probe kinds a real rendering engine must produce. Deliberately
      // excluded: `og-image` / `twitter-image` (only a social unfurler fetches
      // those) and `manifest-icon` (Chrome fetches the manifest but not its icon
      // until an install/icon-usage event) — a rendering engine is not expected
      // to prove them, so asserting them here would be testing the wrong claim.
      const required = [
        "homepage",
        "css",
        "js",
        "img",
        "font",
        "css-bg",
        "css-font",
        "css-import",
        "js-ran",
        "module",
        "module-ran",
        "iframe",
        "iframe-img",
        "favicon",
        "manifest",
        "preload",
        "prefetch",
        "csp-report",
        "report",
        "timing",
      ];
      const missing = required.filter((k) => !kinds.has(k as HitRecord["kind"]));
      if (missing.length) {
        throw new Error(
          `browser did not produce: ${missing.join(", ")} (got ${[...kinds].join(", ")})`,
        );
      }

      const stats = (await kv.get<TraceStats>(recentIndexKey(trace.ts, trace.id))).value;
      if (!stats) throw new Error("no stats snapshot for the browser trace");
      if (!stats.jsRan) throw new Error("stats.jsRan is false although JS executed");
      if (stats.assetCount !== hits.length - 1) {
        throw new Error(`stats.assetCount ${stats.assetCount} != hits ${hits.length - 1}`);
      }

      const timing = hits.find((h) => h.kind === "timing");
      if (!timing?.timing?.length) {
        throw new Error("no client-side resource timing entries were posted");
      }

      const detail = await handler(new Request(`${origin}/trace/${trace.id}`));
      const detailHtml = await detail.text();
      for (const label of ["ES module executed", "image inside iframe", "client timing POST"]) {
        if (!detailHtml.includes(label)) throw new Error(`trace page missing "${label}"`);
      }

      const evidence = {
        ua: trace.ua,
        traceId: trace.id,
        origin,
        hits: hits.length,
        assetCount: stats.assetCount,
        kinds: [...kinds].sort(),
        timingEntries: timing.timing.length,
        timingFirstEntry: timing.timing[0],
      };
      await Deno.writeTextFile(`${artifactDir}/summary.json`, JSON.stringify(evidence, null, 2));
      console.log(
        `[browser-journey] evidence: ${artifactDir}/summary.json ${JSON.stringify(evidence)}`,
      );
    } finally {
      cdp?.close();
      if (child) {
        try {
          child.kill("SIGKILL");
          await child.status;
        } catch { /* already gone */ }
      }
      await server.shutdown();
      await Deno.remove(profileDir, { recursive: true }).catch(() => {});
    }
  },
});
