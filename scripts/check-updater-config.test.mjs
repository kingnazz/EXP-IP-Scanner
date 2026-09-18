// The updater gate decides whether a release publishes a manifest that every
// installed copy will trust, so its "is this a real key" test gets a test.

import { describe, expect, it } from "vitest";
import { PLACEHOLDER, configuredPubkey, looksLikeSigningKey } from "./check-updater-config.mjs";

/** A minisign public key has the shape `tauri signer generate` produces. */
const realKey = Buffer.from(
  "untrusted comment: minisign public key: 36A096D280969E4\nRWTkaQkobQlqA8fLD1GA9lNttOKXsCOEBkqmEXZR1tJNMIntjZ19ubPa\n",
).toString("base64");

describe("looksLikeSigningKey", () => {
  it("accepts a key the Tauri signer produced", () => {
    expect(looksLikeSigningKey(realKey)).toBe(true);
    // Surrounding whitespace from a paste is not a reason to refuse.
    expect(looksLikeSigningKey(`  ${realKey}\n`)).toBe(true);
  });

  it("refuses the placeholder the repository ships with", () => {
    expect(looksLikeSigningKey(PLACEHOLDER)).toBe(false);
  });

  it("refuses an absent or empty key", () => {
    for (const value of ["", "   ", null, undefined, 42, {}]) {
      expect(looksLikeSigningKey(value)).toBe(false);
    }
  });

  it("refuses a truncated paste", () => {
    // The failure this catches would otherwise appear on a technician's
    // machine at update time rather than in the release that caused it.
    expect(looksLikeSigningKey(realKey.slice(0, 60))).toBe(false);
  });

  it("refuses base64 that is not a minisign key", () => {
    const notAKey = Buffer.from("just some text that is long enough to look plausible\n").toString(
      "base64",
    );
    expect(looksLikeSigningKey(notAKey)).toBe(false);
  });

  it("refuses something that is not base64 at all", () => {
    expect(looksLikeSigningKey("not a key, obviously, but reasonably long")).toBe(false);
  });
});

describe("the repository's own configuration", () => {
  it("still ships the placeholder, so no release claims to sign updates", () => {
    // When a maintainer generates a key and replaces this, that is the change
    // that turns updates on -- and this assertion is the reminder to flip it.
    const pubkey = configuredPubkey();
    expect(typeof pubkey).toBe("string");
    if (pubkey !== PLACEHOLDER) {
      // A real key has been configured; it must be a valid one.
      expect(looksLikeSigningKey(pubkey)).toBe(true);
    }
  });
});
