import { useCallback, useEffect, useRef, useState } from "react";

export interface VirtualWindow {
  /** Index of the first row to render. */
  start: number;
  /** Index one past the last row to render. */
  end: number;
  /** Height of the spacer above the rendered rows, in pixels. */
  padTop: number;
  /** Height of the spacer below the rendered rows, in pixels. */
  padBottom: number;
}

/**
 * Render only the rows that are on screen.
 *
 * A /22 with several hundred devices is a realistic scan, and a table that
 * keeps every row in the DOM stops scrolling smoothly well before that. Rows
 * are a fixed height, so the window can be computed from the scroll offset
 * without measuring anything -- which also means it costs nothing when the
 * table is small.
 *
 * Below `threshold` rows the window covers everything, so short tables behave
 * exactly as an ordinary table does, including browser find-in-page.
 */
export function useVirtualRows(
  container: React.RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  { overscan = 12, threshold = 150 }: { overscan?: number; threshold?: number } = {},
): VirtualWindow {
  const [range, setRange] = useState<{ start: number; end: number }>({ start: 0, end: rowCount });
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    const el = container.current;
    if (!el || rowCount <= threshold) {
      setRange({ start: 0, end: rowCount });
      return;
    }
    const visible = Math.ceil(el.clientHeight / rowHeight);
    const first = Math.floor(el.scrollTop / rowHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(rowCount, first + visible + overscan);
    setRange((current) =>
      current.start === start && current.end === end ? current : { start, end },
    );
  }, [container, overscan, rowCount, rowHeight, threshold]);

  useEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const el = container.current;
    if (!el) return;

    // Coalesced into one frame: a scroll event per pixel would otherwise mean a
    // state update per pixel.
    const onScroll = () => {
      if (frame.current != null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(el);

    return () => {
      el.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [container, measure]);

  const start = Math.min(range.start, rowCount);
  const end = Math.min(Math.max(range.end, start), rowCount);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (rowCount - end) * rowHeight),
  };
}
