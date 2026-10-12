// Pure view contract: rendering must not open KV or start the HTTP server.
import { homepageHtml, traceDetailHtml } from "../views.ts";
import type { HitRecord, TraceRecord } from "../storage.ts";

Deno.test("homepage HTML keeps the per-trace secret in nested probe URLs", () => {
  const html = homepageHtml({
    id: "trace-id",
    secret: "private-secret",
    traces: [],
    uaGroups: new Map(),
    uaFilter: "",
    totalTraces: 0,
    origin: "https://uatracer.com",
  });
  if (!html.includes("/r/trace-id/private-secret/style.css")) {
    throw new Error("secret probe path missing");
  }
  if (!html.includes('rel="canonical"')) throw new Error("canonical missing");
});

Deno.test("trace detail escapes request data and renders the JS waterfall", () => {
  const trace: TraceRecord = {
    id: "safe",
    ts: 1000,
    ip: "192.0.2.1",
    ua: "<img src=x>",
    method: "GET",
    headers: {},
  };
  const hits: HitRecord[] = [{
    id: "safe",
    kind: "timing",
    ts: 1100,
    ip: "192.0.2.1",
    ua: "test",
    method: "POST",
    headers: {},
    timing: [{
      name: "https://example.test/style.css",
      entryType: "resource",
      startTime: 1,
      duration: 2,
    }],
  }];
  const html = traceDetailHtml(trace, hits);
  if (html.includes("<img src=x>") || !html.includes("&lt;img src=x&gt;")) {
    throw new Error("UA was not escaped");
  }
  if (!html.includes("Client-side resource waterfall") || !html.includes("style.css")) {
    throw new Error("timing waterfall missing");
  }
});
