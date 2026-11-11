// Pure probe contract: paths, kinds and generated response bodies remain stable.
import {
  assetBase,
  assetKind,
  cssBody,
  cssSafeSegment,
  jsBody,
  manifestBody,
  moduleBody,
  WOFF2_FONT,
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

// The probe font must be a decodable WOFF2 container (ua-tracer-hik). The engine
// check that matters most - "does OTS accept it" - needs a browser, so this pins
// the two structural properties that make it fail: a WOFF2 is rejected outright
// when its glyf table reconstructs to ZERO bytes ("OTS parsing error: glyf:
// zero-length table"), which is what a font whose every glyph is empty produces.
// Decompression is not available in this runtime, so the container's own lengths
// are checked for consistency instead; the mutation check is the old body, whose
// glyf entry declared origLength 0.
const WOFF2_KNOWN_TAGS = [
  "cmap",
  "head",
  "hhea",
  "hmtx",
  "maxp",
  "name",
  "OS/2",
  "post",
  "cvt ",
  "fpgm",
  "glyf",
  "loca",
  "prep",
  "CFF ",
];

function woff2DirectoryBytes(
  font: Uint8Array,
): { total: number; entries: { tag: string; origLength: number }[] } {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const signature = String.fromCharCode(...font.subarray(0, 4));
  if (signature !== "wOF2") throw new Error(`probe font is not a WOFF2 (signature ${signature})`);
  const declared = view.getUint32(8);
  if (declared !== font.byteLength) {
    throw new Error(`WOFF2 declares ${declared} bytes, body is ${font.byteLength}`);
  }
  const numTables = view.getUint16(12);
  let at = 48;
  const readBase128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = font[at++];
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("malformed base128 length in the WOFF2 table directory");
  };
  const entries: { tag: string; origLength: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = font[at++];
    const tagIndex = flags & 0x3f;
    const version = (flags >> 6) & 0x3;
    let tag: string;
    if (tagIndex === 63) {
      tag = String.fromCharCode(...font.subarray(at, at + 4));
      at += 4;
    } else {
      tag = WOFF2_KNOWN_TAGS[tagIndex];
      if (tag === undefined) throw new Error(`unknown WOFF2 known-tag index ${tagIndex}`);
    }
    const origLength = readBase128();
    const glyfOrLoca = tag === "glyf" || tag === "loca";
    const transformed = glyfOrLoca ? version === 0 : version !== 0;
    if (transformed) readBase128();
    entries.push({ tag, origLength });
  }
  const totalCompressedSize = view.getUint32(20);
  const dataEnd = at + totalCompressedSize;
  // The compressed block may be followed by up to three bytes of 4-byte alignment
  // padding (no metadata or private block in this font).
  if (dataEnd > font.byteLength || font.byteLength - dataEnd > 3) {
    throw new Error(
      `WOFF2 container inconsistent: directory ends at ${at}, compressed size ${totalCompressedSize}, body ${font.byteLength}`,
    );
  }
  return { total: at, entries };
}

Deno.test("the probe font is a WOFF2 with a non-empty glyf table", () => {
  const { entries } = woff2DirectoryBytes(WOFF2_FONT);
  const glyf = entries.find((e) => e.tag === "glyf");
  if (!glyf) throw new Error("probe font has no glyf table");
  if (glyf.origLength < 10) {
    throw new Error(
      `probe font glyf table is ${glyf.origLength} bytes; every OTS engine rejects a zero-length glyf`,
    );
  }
  // A font with an outline must also carry loca sized for its glyphs.
  const loca = entries.find((e) => e.tag === "loca");
  if (!loca || loca.origLength < 4) {
    throw new Error("probe font loca table is missing or too short");
  }
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
