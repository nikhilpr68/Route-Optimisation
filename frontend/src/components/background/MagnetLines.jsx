import { useEffect, useRef } from "react";
import "./MagnetLines.css";

export default function MagnetLines({
  rows = 9,
  columns = 9,
  containerSize = "80vmin",
  lineColor = "#efefef",
  lineWidth = "1vmin",
  lineHeight = "6vmin",
  baseAngle = -10,
  className = "",
  style = {},
}) {
  const containerRef = useRef(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const items = container.querySelectorAll("span");
    if (!items.length) return;

    let frame = 0;

    const updateAngles = (pointerX, pointerY) => {
      items.forEach((item) => {
        const rect = item.getBoundingClientRect();
        const centerX = rect.x + rect.width / 2;
        const centerY = rect.y + rect.height / 2;

        const angle = (Math.atan2(pointerY - centerY, pointerX - centerX) * 180) / Math.PI;
        item.style.setProperty("--rotate", `${angle}deg`);
      });
    };

    const onPointerMove = (event) => {
      const pointerX = Number.isFinite(event.clientX) ? event.clientX : event.x;
      const pointerY = Number.isFinite(event.clientY) ? event.clientY : event.y;
      if (!Number.isFinite(pointerX) || !Number.isFinite(pointerY)) return;

      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => updateAngles(pointerX, pointerY));
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });

    const middleIndex = Math.floor(items.length / 2);
    const rect = items[middleIndex].getBoundingClientRect();
    updateAngles(rect.x + rect.width / 2, rect.y + rect.height / 2);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rows, columns]);

  const total = rows * columns;
  const spans = Array.from({ length: total }, (_, i) => (
    <span
      key={i}
      style={{
        "--rotate": `${baseAngle}deg`,
        backgroundColor: lineColor,
        width: lineWidth,
        height: lineHeight,
      }}
    />
  ));

  return (
    <div
      ref={containerRef}
      className={`magnetLines-container ${className}`.trim()}
      style={{
        "--rows": rows,
        "--columns": columns,
        width: containerSize,
        height: containerSize,
        ...style,
      }}
    >
      {spans}
    </div>
  );
}

