import { useCallback, useEffect, useState } from "react";

export interface MenuAnchor {
  x: number;
  y: number;
}

/**
 * Open-at-the-pointer menu state.
 *
 * The menu closes on any click outside it, on Escape, on a scroll and on a
 * window resize -- all four, because a context menu left floating over a table
 * that has moved underneath it is worse than no menu.
 */
export function useContextMenu<T>() {
  const [state, setState] = useState<{ anchor: MenuAnchor; item: T } | null>(null);

  const open = useCallback((event: React.MouseEvent, item: T) => {
    event.preventDefault();
    setState({ anchor: { x: event.clientX, y: event.clientY }, item });
  }, []);

  const close = useCallback(() => setState(null), []);

  useEffect(() => {
    if (!state) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    // Capture, so a scroll inside the table closes the menu too.
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [state, close]);

  return { state, open, close };
}
