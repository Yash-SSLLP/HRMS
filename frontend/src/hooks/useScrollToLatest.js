import { useEffect, useRef } from 'react';

/**
 * Park a horizontally scrollable chart at its RIGHT edge.
 *
 * Every chart in the app plots time left-to-right, so the newest point sits at
 * the far right. On a phone the plot is wider than the screen and the browser
 * opens the scroller wherever its layout happens to land — which meant a chart
 * opened showing the middle of the range, and the reader had to swipe to reach
 * the days they actually came to see. Latest data is the useful end, so that is
 * where the chart opens.
 *
 * Only bites when the content genuinely overflows: on a desktop where the whole
 * plot fits, `scrollWidth === clientWidth` and the assignment is a no-op, so
 * this needs no breakpoint check of its own.
 *
 * Deliberately does NOT re-park on resize or on every render — it sets the
 * OPENING position. Yanking the viewport back to the right while someone is
 * reading the left of the chart would be worse than the bug it fixes.
 *
 * @param {*} resetKey - re-park when this changes (pass the data, or its
 *   length): a chart whose series was swapped is a new chart, and should open
 *   at the latest point again.
 * @returns {import('react').RefObject<HTMLElement>} ref for the scrolling element
 *   — the one carrying `overflow-x-auto`, not the plot inside it.
 */
export default function useScrollToLatest(resetKey) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Wait for layout: on the first paint after a data swap the new plot may not
    // be measured yet, so scrollWidth still reports the old (or zero) width.
    const park = () => {
      if (!ref.current) return;
      const node = ref.current;
      if (node.scrollWidth > node.clientWidth) node.scrollLeft = node.scrollWidth;
    };
    park();
    const raf = requestAnimationFrame(park);
    return () => cancelAnimationFrame(raf);
  }, [resetKey]);

  return ref;
}
