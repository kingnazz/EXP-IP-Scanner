import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

/**
 * What the network summary knows about this network's public address.
 *
 * `off` and `unavailable` are different states on purpose: one means nobody
 * asked, the other means we asked and got no answer. Collapsing them would put
 * "Unavailable" in front of a technician who deliberately turned the lookup
 * off, which reads as a fault rather than a choice.
 */
export type PublicIpState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "ready"; ip: string; host: string }
  | { status: "unavailable" };

/**
 * Look up the public IP address, out of the way of everything else.
 *
 * Startup does not wait for this and nothing else depends on it: the window is
 * usable, the target is filled in and a scan can already be running while the
 * lookup is still in flight. A reply that arrives after the lookup was turned
 * off, or after a newer one was asked for, is dropped rather than shown.
 */
export function usePublicIp(enabled: boolean) {
  const [state, setState] = useState<PublicIpState>(enabled ? { status: "loading" } : { status: "off" });
  /** Identifies the lookup in flight, so a stale reply can be recognised. */
  const attempt = useRef(0);

  const look = useCallback(() => {
    const mine = ++attempt.current;
    setState({ status: "loading" });
    void api
      .publicIp()
      .then((result) => {
        if (attempt.current !== mine) return;
        setState(result ? { status: "ready", ...result } : { status: "unavailable" });
      })
      .catch(() => {
        if (attempt.current !== mine) return;
        setState({ status: "unavailable" });
      });
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Abandons whatever is in flight: its reply will not match.
      attempt.current += 1;
      setState({ status: "off" });
      return;
    }
    look();
  }, [enabled, look]);

  return { state, refresh: look };
}
