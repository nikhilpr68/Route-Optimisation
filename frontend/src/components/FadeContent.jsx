import { useRef, useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

const FadeContent = ({
  children,
  container,
  blur = false,
  blurAmount = 6,
  duration = 1000,
  ease = "power2.out",
  delay = 0,
  threshold = 0.1,
  initialOpacity = 0,
  playImmediately = false,
  disappearAfter = 0,
  disappearDuration = 0.5,
  disappearEase = "power2.in",
  onComplete,
  onDisappearanceComplete,
  className = "",
  style,
  ...props
}) => {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const getSeconds = (val) => (typeof val === "number" && val > 10 ? val / 1000 : val);
    const blurStart = blur ? `blur(${Math.max(0, blurAmount)}px)` : "none";

    let scrollerTarget = container || document.getElementById("snap-main-container") || null;
    if (typeof scrollerTarget === "string") {
      scrollerTarget = document.querySelector(scrollerTarget);
    }

    const startPct = (1 - threshold) * 100;

    gsap.set(el, {
      opacity: initialOpacity,
      visibility: initialOpacity <= 0 ? "hidden" : "visible",
      filter: blurStart,
      willChange: "opacity, filter, transform",
      force3D: true,
    });

    const tl = gsap.timeline({
      paused: true,
      delay: getSeconds(delay),
      onComplete: () => {
        if (onComplete) onComplete();
        if (disappearAfter > 0) {
          gsap.to(el, {
            opacity: initialOpacity,
            visibility: initialOpacity <= 0 ? "hidden" : "visible",
            filter: blurStart,
            delay: getSeconds(disappearAfter),
            duration: getSeconds(disappearDuration),
            ease: disappearEase,
            overwrite: "auto",
            onComplete: () => onDisappearanceComplete?.(),
          });
        }
      },
    });

    tl.to(el, {
      opacity: 1,
      visibility: "visible",
      filter: "blur(0px)",
      duration: getSeconds(duration),
      ease,
      overwrite: "auto",
    });

    if (playImmediately) {
      const frame = requestAnimationFrame(() => tl.play());
      return () => {
        cancelAnimationFrame(frame);
        tl.kill();
        gsap.killTweensOf(el);
      };
    }

    const st = ScrollTrigger.create({
      trigger: el,
      scroller: scrollerTarget || window,
      start: `top ${startPct}%`,
      once: true,
      onEnter: () => tl.play(),
    });

    return () => {
      st.kill();
      tl.kill();
      gsap.killTweensOf(el);
    };
  }, [
    blur,
    blurAmount,
    container,
    delay,
    disappearAfter,
    disappearDuration,
    disappearEase,
    duration,
    ease,
    initialOpacity,
    playImmediately,
    onComplete,
    onDisappearanceComplete,
    threshold,
  ]);

  return (
    <div ref={ref} className={className} style={style} {...props}>
      {children}
    </div>
  );
};

export default FadeContent;
