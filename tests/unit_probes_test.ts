// Pure probe contract: paths, kinds and generated response bodies remain stable.
import {
  assetBase,
  assetKind,
  cssBody,
  cssSafeSegment,
  jsBody,
  manifestBody,
  moduleBody,
} from "../probes.ts";

Deno.test("new and legacy probe URLs retain their distinct base paths", () => {
  if (assetBase("id", "secret") !== "/r/id/secret" || assetBase("id") !== "/r/id") {
    throw new Error("probe URL contract changed");
  }
  if (assetKind("style.css") !== "css" || assetKind("module-ran.gif") !== "module-ran") {
    throw new Error("probe hit kind changed");
  }
  if (assetKind("unknown") !== undefined) throw new Error("unknown asset was accepted");
});

Deno.test("cssBody escapes segments that could break out of CSS strings or comments", () => {
  // Belt-and-braces under invariant I6 (ua-tracer-82v): the router gate admits
  // only [0-9a-zA-Z_-]{1,64}, so real traffic never carries quotes or comment
  // closers in a segment — this pins the escape layer itself, so a future
  // caller that skips the gate still cannot inject CSS syntax through an
  // interpolated id or secret.
  const css = cssBody(`a"b*/c`, `s"e`);
  // No hostile byte survives verbatim: a quote cannot terminate a url("...")
  // string and `*/` cannot close the trace comment early, because each arrives
  // as a hex escape instead.
  if (css.includes(`a"b*/c`)) throw new Error("hostile id was reflected verbatim");
  if (!css.includes("for trace a\\22 b\\2a \\2f c */")) {
    throw new Error("trace comment did not escape the hostile id");
  }
  if (!css.includes(`url("/r/a\\22 b\\2a \\2f c/s\\22 e/import.css")`)) {
    throw new Error("@import url did not escape the hostile segments");
  }
  // In-alphabet segments pass through untouched.
  if (cssSafeSegment("Az09_-x") !== "Az09_-x") throw new Error("identity escaping broke");
});

Deno.test("generated CSS/JS/module/manifest keep their nested secret paths", () => {
  const base = "/r/id/secret";
  for (
    const [name, body, expected] of [
      ["CSS", cssBody("id", "secret"), `${base}/css-bg.png`],
      ["JS", jsBody("id", "secret"), `${base}/js-ran.gif`],
      ["module", moduleBody("id", "secret"), `${base}/module-ran.gif`],
      ["manifest", manifestBody("id", "secret"), `${base}/manifest-icon.png`],
    ]
  ) {
    if (!body.includes(expected)) throw new Error(`${name} missing ${expected}`);
  }
});
