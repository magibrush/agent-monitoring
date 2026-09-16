import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Escape chart stacking contexts and clamp the measured card to the viewport. */
export function ChartTooltip({
  point,
  children,
}: {
  point: { x: number; y: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const place = () => {
      const card = ref.current;
      if (!card) return;
      const { width, height } = card.getBoundingClientRect();
      const left =
        point.x + 16 + width < window.innerWidth - 8
          ? point.x + 16
          : point.x - width - 16;
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.max(
          8,
          Math.min(point.y + 16, window.innerHeight - height - 8),
        ),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [point.x, point.y]);
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="signal-tooltip chart-tooltip-overlay"
      style={{ ...position }}
    >
      {children}
    </div>,
    document.body,
  );
}
