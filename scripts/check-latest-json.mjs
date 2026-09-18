#!/usr/bin/env node
// Check the updater manifest that is about to be published.
//
// latest.json tells every installed copy what it may download and hand to the
// Windows installer. A portable ZIP in it would be an update that cannot be
// applied; a stale version would be an update loop. So the generator's output
// is asserted on directly rather than trusted.
//
//   node scripts/check-latest-json.mjs dist/latest.json v1.0.0

import { readFileSync } from "node:fs";

const [path, tag] = process.argv.slice(2);
if (!path || !tag) {
  console.error("usage: check-latest-json.mjs <latest.json> <tag>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path, "utf8"));
const expected = tag.replace(/^v/, "");
let failures = 0;
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failures += 1;
  }
};

check("the manifest names this release's version", manifest.version === expected, manifest.version);
check(
  "it describes at least one platform",
  manifest.platforms && Object.keys(manifest.platforms).length > 0,
  Object.keys(manifest.platforms ?? {}).join(", "),
);

for (const [platform, entry] of Object.entries(manifest.platforms ?? {})) {
  const url = entry.url ?? "";
  check(`${platform} has a signature`, Boolean(entry.signature), `${(entry.signature ?? "").length} chars`);
  check(`${platform} points at this release`, url.includes(`/download/${tag}/`), url);
  check(
    `${platform} names an installer, not a portable build`,
    /x64-setup\.exe$/i.test(decodeURIComponent(url)),
    decodeURIComponent(url).split("/").pop(),
  );
  check(
    `${platform} is not a portable ZIP`,
    !/portable/i.test(url),
    /portable/i.test(url) ? "a portable asset is named" : "no portable asset named",
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed. Refusing to publish this manifest.`);
  process.exit(1);
}
console.log("\nThe updater manifest is safe to publish.");
