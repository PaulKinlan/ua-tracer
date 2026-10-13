// Pure-contract unit tests: formatting/parsing helpers that every page render
// and every classification depends on. No KV, no network, no request handling —
// if one of these fails, the failure is here, not in a fixture.

import {
  cidrContains4,
  clientIp,
  escapeHtml,
  fmtDelta,
  fmtTs,
  ipv4ToInt,
  uaHeadline,
  verificationIp,
} from "../server.ts";

Deno.test("escapeHtml neutralises the five HTML-significant characters", () => {
  const got = escapeHtml(`<a href="x">&'`);
  if (got !== "&lt;a href=&quot;x&quot;&gt;&amp;&#39;") {
    throw new Error(`escapeHtml mismatch: ${got}`);
  }
  if (escapeHtml("plain text") !== "plain text") throw new Error("escapeHtml altered plain text");
});

Deno.test("fmtTs renders an ISO instant in the UTC label the pages show", () => {
  const got = fmtTs(0);
  if (got !== "1970-01-01 00:00:00.000 UTC") throw new Error(`fmtTs(0) = ${got}`);
});

Deno.test("fmtDelta picks ms / s / m / h bands at the boundaries", () => {
  const cases: [number, string][] = [
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.0s"],
    [1500, "1.5s"],
    [59999, "60.0s"],
    [60000, "1m"],
    [3599999, "59m"],
    [3600000, "1h 0m"],
    [3900000, "1h 5m"],
  ];
  for (const [ms, want] of cases) {
    const got = fmtDelta(ms);
    if (got !== want) throw new Error(`fmtDelta(${ms}) = ${got}, want ${want}`);
  }
});

Deno.test("uaHeadline prefers the 'compatible;' bot token", () => {
  const ua = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  if (uaHeadline(ua) !== "Googlebot/2.1") throw new Error(uaHeadline(ua));
  const bing = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
  if (uaHeadline(bing) !== "bingbot/2.0") throw new Error(uaHeadline(bing));
});

Deno.test("uaHeadline prefers the browser token over engine noise", () => {
  const chrome =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  if (uaHeadline(chrome) !== "Chrome/120.0.0.0") throw new Error(uaHeadline(chrome));
  const firefox = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
  if (uaHeadline(firefox) !== "Firefox/121.0") throw new Error(uaHeadline(firefox));
});

Deno.test("uaHeadline falls back to the last token, then the first word", () => {
  if (uaHeadline("curl/8.0.1") !== "curl/8.0.1") throw new Error(uaHeadline("curl/8.0.1"));
  if (uaHeadline("Mozilla/5.0") !== "Mozilla/5.0") throw new Error(uaHeadline("Mozilla/5.0"));
});

Deno.test("uaHeadline labels a missing user-agent explicitly", () => {
  if (uaHeadline("") !== "(no user-agent)") throw new Error(uaHeadline(""));
});

/** Connection metadata as `Deno.serve` supplies it: the peer address. */
function peer(hostname: string): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname, port: 443 },
    completed: Promise.resolve(),
  } as unknown as Deno.ServeHandlerInfo;
}

Deno.test("clientIp is the connection peer, not a claim the request makes about itself", () => {
  // A client-supplied x-forwarded-for must not override the real peer.
  const spoofed = clientIp(
    new Request("https://uatracer.com/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8", "x-real-ip": "9.9.9.9" },
    }),
    peer("203.0.113.7"),
  );
  if (spoofed !== "203.0.113.7") throw new Error(`peer lost to a header -> ${spoofed}`);

  // IPv4-mapped peers are normalised so cidrContains4 can match them.
  const mapped = clientIp(new Request("https://uatracer.com/"), peer("::ffff:203.0.113.7"));
  if (mapped !== "203.0.113.7") throw new Error(`IPv4-mapped peer -> ${mapped}`);

  // Without connection metadata the claimed address is still recorded, in the
  // documented order, so a handler called without `info` logs something useful.
  const claimed = clientIp(
    new Request("https://uatracer.com/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    }),
  );
  if (claimed !== "1.2.3.4") throw new Error(`claimed x-forwarded-for -> ${claimed}`);

  const real = clientIp(
    new Request("https://uatracer.com/", { headers: { "x-real-ip": "9.9.9.9" } }),
  );
  if (real !== "9.9.9.9") throw new Error(`claimed x-real-ip -> ${real}`);

  const none = clientIp(new Request("https://uatracer.com/"));
  if (none !== "unknown") throw new Error(`no address -> ${none}`);
});

Deno.test("verificationIp only ever returns the peer, so a header cannot decide a verdict", () => {
  if (verificationIp(peer("66.249.66.1")) !== "66.249.66.1") {
    throw new Error("peer not used for verification");
  }
  // No connection metadata, however loud the request is about its own address.
  const noPeer = verificationIp();
  if (noPeer !== "unknown") throw new Error(`headers influenced the verdict IP -> ${noPeer}`);
  // "unknown" is not a dotted quad, so it can never match a published range.
  if (ipv4ToInt(noPeer) !== null) throw new Error("the no-peer verdict IP is matchable");
});

Deno.test("ipv4ToInt rejects anything that is not a dotted quad", () => {
  if (ipv4ToInt("1.2.3.4") !== 0x01020304) throw new Error("1.2.3.4");
  if (ipv4ToInt("0.0.0.0") !== 0) throw new Error("0.0.0.0");
  if (ipv4ToInt("255.255.255.255") !== 4294967295) throw new Error("255.255.255.255");
  for (const bad of ["1.2.3", "1.2.3.4.5", "256.1.1.1", "-1.2.3.4", "a.b.c.d", ""]) {
    if (ipv4ToInt(bad) !== null) throw new Error(`expected null for ${JSON.stringify(bad)}`);
  }
});

Deno.test("cidrContains4 matches inside a prefix and misses outside it", () => {
  const in24 = ipv4ToInt("66.249.66.5")!;
  if (!cidrContains4("66.249.66.0/24", in24)) throw new Error("in /24");
  if (cidrContains4("66.249.66.0/24", ipv4ToInt("66.249.67.5")!)) throw new Error("outside /24");

  // A /32 is a single host; a /0 matches everything.
  if (!cidrContains4("1.2.3.4/32", ipv4ToInt("1.2.3.4")!)) throw new Error("/32 match");
  if (cidrContains4("1.2.3.4/32", ipv4ToInt("1.2.3.5")!)) throw new Error("/32 miss");
  if (!cidrContains4("0.0.0.0/0", ipv4ToInt("203.0.113.9")!)) throw new Error("/0");
});

Deno.test("cidrContains4 fails closed on malformed prefixes", () => {
  const ip = ipv4ToInt("1.2.3.4")!;
  for (const bad of ["1.2.3.0/33", "1.2.3.0/-1", "1.2.3.0/x", "999.2.3.0/24", ""]) {
    if (cidrContains4(bad, ip)) throw new Error(`expected false for ${JSON.stringify(bad)}`);
  }
  // No slash: the implementation compares the literal to the integer.
  if (!cidrContains4("16909060", 16909060)) throw new Error("literal-integer host form");
  if (cidrContains4("1.2.3.4", ip)) throw new Error("dotted quad without a slash must not match");
});
