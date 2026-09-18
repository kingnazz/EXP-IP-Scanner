// The public IP lookup.
//
// This is the one thing EXP IP Scanner cannot work out for itself. Everything
// else in the network summary comes from the machine: the adapter, its address,
// its netmask, its routing table. The address the rest of the internet sees the
// site as belongs to the ISP's equipment upstream, so something outside has to
// be asked -- and a technician standing in a comms room genuinely needs it.
//
// It is therefore the only outbound request the application makes on its own,
// and is treated accordingly:
//
//   * two services, tried in order, each with its own timeout, so one being
//     down or slow is not the difference between an answer and "Unavailable";
//   * both are plain-text endpoints that return the caller's address and
//     nothing else -- no key, no account, no payload sent;
//   * the reply is validated as an IP address before it reaches the screen,
//     because it arrives from outside and nothing outside is trusted;
//   * the hosts are named in `tauri.conf.json`'s `connect-src`, so the window
//     cannot reach anywhere else even if this file said otherwise;
//   * and a technician who does not want the request can turn it off in
//     Settings, which is why this takes no action of its own on import.

/** One service that answers with the caller's public IP address in plain text. */
export interface PublicIpService {
  /** Shown in the interface, so the request is never a mystery. */
  host: string;
  url: string;
}

/**
 * The services, in the order they are tried.
 *
 * ipify is first because it answers IPv4 only, which is the address a
 * technician means. icanhazip is the fallback and answers over whichever
 * family the connection used, so a v6-only site still gets an answer rather
 * than a dash.
 */
export const PUBLIC_IP_SERVICES: readonly PublicIpService[] = [
  { host: "api.ipify.org", url: "https://api.ipify.org" },
  { host: "icanhazip.com", url: "https://icanhazip.com" },
];

/** How long one service gets before the next is tried. */
export const PUBLIC_IP_TIMEOUT_MS = 4_000;

/**
 * The longest reply worth looking at.
 *
 * A full IPv6 address is 45 characters. Anything appreciably longer is a
 * captive portal's login page or an error document, not an address, and is
 * rejected without being parsed.
 */
const MAX_REPLY_LENGTH = 64;

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * The address in a service's reply, or null if it did not send one.
 *
 * Strict on purpose. A hotel captive portal happily returns 200 with a page of
 * HTML, and a proxy can return an error document; neither must be able to put
 * arbitrary text on screen as though it were this network's public address.
 */
export function parsePublicIp(reply: string): string | null {
  const text = reply.trim();
  if (text.length === 0 || text.length > MAX_REPLY_LENGTH) return null;

  const v4 = IPV4.exec(text);
  if (v4) {
    // Each octet must be in range and written plainly. A leading zero is
    // rejected rather than trimmed, because `042` means 34 to some parsers and
    // 42 to others, and an address nobody agrees on is not one to show.
    const plain = (octet: string) => {
      const n = Number(octet);
      return n <= 255 && String(n) === octet;
    };
    return v4.slice(1).every(plain) ? text : null;
  }

  // IPv6, validated by the URL parser rather than by a regular expression of
  // our own: it implements the address grammar, including `::` and the
  // embedded-IPv4 forms, and it throws on everything else.
  if (!text.includes(":")) return null;
  try {
    const url = new URL(`http://[${text}]`);
    // `hostname` comes back in the canonical lower-case compressed form, which
    // is what should be shown: it is the same address, written properly.
    return url.hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

export interface PublicIpResult {
  ip: string;
  /** Which service answered, so the interface can say so. */
  host: string;
}

/**
 * Ask each service in turn for this network's public IP address.
 *
 * Resolves with null rather than throwing when every service fails: there is
 * nothing here for a caller to handle beyond showing that it is unavailable,
 * and an offline machine is an ordinary state for this tool, not an error.
 */
export async function fetchPublicIp(
  services: readonly PublicIpService[] = PUBLIC_IP_SERVICES,
  timeoutMs: number = PUBLIC_IP_TIMEOUT_MS,
): Promise<PublicIpResult | null> {
  for (const service of services) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetch(service.url, {
        signal: abort.signal,
        // Nothing of ours travels with the request: no cookies, no referrer,
        // and no cached answer from a previous network.
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) continue;
      const ip = parsePublicIp(await response.text());
      if (ip) return { ip, host: service.host };
    } catch {
      // Offline, blocked, timed out, or a DNS failure. Try the next one.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}
