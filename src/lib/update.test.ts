import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchLatestRelease,
  isNewerVersion,
  LATEST_RELEASE_API,
  parseStableVersion,
} from "./update";

afterEach(() => vi.unstubAllGlobals());

describe("parseStableVersion", () => {
  it("accepts the stable release formats we publish", () => {
    expect(parseStableVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseStableVersion("v1.2.3")).toEqual([1, 2, 3]);
  });

  it("rejects prereleases and malformed tags", () => {
    expect(parseStableVersion("v1.2.3-beta.1")).toBe(null);
    expect(parseStableVersion("1.2")).toBe(null);
    expect(parseStableVersion("release-1.2.3")).toBe(null);
  });
});

describe("isNewerVersion", () => {
  it("compares major, minor and patch numerically", () => {
    expect(isNewerVersion("1.1.1", "1.1.0")).toBe(true);
    expect(isNewerVersion("1.2.0", "1.1.9")).toBe(true);
    expect(isNewerVersion("2.0.0", "1.99.99")).toBe(true);
    expect(isNewerVersion("1.1.0", "1.1.0")).toBe(false);
    expect(isNewerVersion("1.0.9", "1.1.0")).toBe(false);
  });
});

describe("fetchLatestRelease", () => {
  it("returns a validated stable GitHub release", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: "v1.1.1",
          html_url: "https://github.com/kingnazz/EXP-IP-Scanner/releases/tag/v1.1.1",
          draft: false,
          prerelease: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(fetchLatestRelease(fetchSpy as typeof fetch, 100)).resolves.toEqual({
      version: "1.1.1",
      url: "https://github.com/kingnazz/EXP-IP-Scanner/releases/tag/v1.1.1",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      LATEST_RELEASE_API,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects an invalid release payload instead of trusting it", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: "latest",
          html_url: "https://example.com/not-this-project",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(fetchLatestRelease(fetchSpy as typeof fetch, 100)).rejects.toThrow(
      "invalid version",
    );
  });

  it("reports an HTTP failure cleanly", async () => {
    const fetchSpy = vi.fn(async () => new Response("rate limited", { status: 403 }));
    await expect(fetchLatestRelease(fetchSpy as typeof fetch, 100)).rejects.toThrow(
      "HTTP 403",
    );
  });
});
