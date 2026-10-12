// Pure probe contract: paths, kinds and generated response bodies remain stable.
import { assetBase, assetKind, cssBody, jsBody, manifestBody, moduleBody } from "../probes.ts";

Deno.test("new and legacy probe URLs retain their distinct base paths", () => {
  if (assetBase("id", "secret") !== "/r/id/secret" || assetBase("id") !== "/r/id") {
    throw new Error("probe URL contract changed");
  }
  if (assetKind("style.css") !== "css" || assetKind("module-ran.gif") !== "module-ran") {
    throw new Error("probe hit kind changed");
  }
  if (assetKind("unknown") !== undefined) throw new Error("unknown asset was accepted");
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
