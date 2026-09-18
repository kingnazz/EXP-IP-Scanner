import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPublicIp, parsePublicIp, type PublicIpService } from "./publicip";

const SERVICES: PublicIpService[] = [
  { host: "first.example", url: "https://first.example" },
  { host: "second.example", url: "https://second.example" },
];

type Answer = (init: RequestInit) => Promise<Response>;

/** A stub `fetch` that answers each URL from a table. */
function stubFetch(answers: Record<string, Answer>) {
  const spy = vi.fn((url: string, init: RequestInit) => {
    const answer = answers[url];
    if (!answer) throw new Error(`no stub for ${url}`);
    return answer(init);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ok =
  (body: string): Answer =>
  async () =>
    new Response(body, { status: 200 });

const fails = (): Answer => async () => {
  throw new TypeError("Failed to fetch");
};

/** A service that answers only when the caller's timeout gives up on it. */
const hangs = (): Answer => (init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });

afterEach(() => vi.unstubAllGlobals());

describe("parsePublicIp", () => {
  it("accepts an address with the newline these services send", () => {
    expect(parsePublicIp("203.0.113.42\n")).toBe("203.0.113.42");
    expect(parsePublicIp("  203.0.113.42  ")).toBe("203.0.113.42");
  });

  it("accepts an IPv6 answer and writes it canonically", () => {
    // icanhazip answers over whichever family the connection used, so a v6-only
    // site gets an address rather than a dash.
    expect(parsePublicIp("2001:0db8:0000:0000:0000:0000:0000:0001\n")).toBe("2001:db8::1");
    expect(parsePublicIp("2001:db8::1")).toBe("2001:db8::1");
  });

  it("refuses a captive portal's login page", () => {
    // The real failure this guards: hotel and airport networks answer any
    // request with 200 and a page of HTML. None of it may reach the screen as
    // though it were this network's public address.
    expect(parsePublicIp("<!DOCTYPE html><html><body>Sign in to continue</body></html>")).toBe(
      null,
    );
    expect(parsePublicIp("Error: proxy authentication required")).toBe(null);
    expect(parsePublicIp("")).toBe(null);
  });

  it("refuses something that is merely address-shaped", () => {
    expect(parsePublicIp("203.0.113.256")).toBe(null);
    expect(parsePublicIp("203.0.113")).toBe(null);
    expect(parsePublicIp("203.0.113.42.7")).toBe(null);
    expect(parsePublicIp("203.0.113.042")).toBe(null);
    expect(parsePublicIp("203.0.113.42 <br>")).toBe(null);
    expect(parsePublicIp("nonsense:::1")).toBe(null);
  });

  it("refuses a reply too long to be an address, without parsing it", () => {
    expect(parsePublicIp("203.0.113.42".padEnd(200, " x"))).toBe(null);
  });
});

describe("fetchPublicIp", () => {
  it("returns the first service's answer and does not ask the second", async () => {
    const fetchSpy = stubFetch({
      "https://first.example": ok("203.0.113.42\n"),
      "https://second.example": ok("198.51.100.9"),
    });
    await expect(fetchPublicIp(SERVICES, 50)).resolves.toEqual({
      ip: "203.0.113.42",
      host: "first.example",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the second service when the first is unreachable", async () => {
    stubFetch({
      "https://first.example": fails(),
      "https://second.example": ok("198.51.100.9\n"),
    });
    await expect(fetchPublicIp(SERVICES, 50)).resolves.toEqual({
      ip: "198.51.100.9",
      host: "second.example",
    });
  });

  it("falls back when the first service answers with something that is not an address", async () => {
    stubFetch({
      "https://first.example": ok("<html>Sign in</html>"),
      "https://second.example": ok("198.51.100.9"),
    });
    await expect(fetchPublicIp(SERVICES, 50)).resolves.toEqual({
      ip: "198.51.100.9",
      host: "second.example",
    });
  });

  it("falls back when the first service answers with an error status", async () => {
    stubFetch({
      "https://first.example": async () => new Response("nope", { status: 503 }),
      "https://second.example": ok("198.51.100.9"),
    });
    await expect(fetchPublicIp(SERVICES, 50)).resolves.toEqual({
      ip: "198.51.100.9",
      host: "second.example",
    });
  });

  it("gives up on a service that never answers, and still returns the other one", async () => {
    stubFetch({
      // Settles only when the timeout aborts it, which is what the strip
      // relies on: a hung service must not hold "Looking up…" forever.
      "https://first.example": hangs(),
      "https://second.example": ok("198.51.100.9"),
    });
    await expect(fetchPublicIp(SERVICES, 10)).resolves.toEqual({
      ip: "198.51.100.9",
      host: "second.example",
    });
  });

  it("resolves with null rather than throwing when the machine is offline", async () => {
    stubFetch({
      "https://first.example": fails(),
      "https://second.example": fails(),
    });
    await expect(fetchPublicIp(SERVICES, 50)).resolves.toBe(null);
  });
});
