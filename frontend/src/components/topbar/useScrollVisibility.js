import { useEffect, useRef, useState } from 'react';

export default function useScrollVisibility(scrollElement, options = {}) {
  const { threshold = 10, topOffset = 20 } = options;
  const [visible, setVisible] = useState(true);
  const lastScrollYRef = useRef(0);
  const visibleRef = useRef(true);
  const tickingRef = useRef(false);

  useEffect(() => {
    const getScrollY = () => {
      if (scrollElement) return scrollElement.scrollTop || 0;
      return window.scrollY || window.pageYOffset || 0;
    };

    const updateVisibility = () => {
      const currentScrollY = getScrollY();
      const delta = currentScrollY - lastScrollYRef.current;

      if (currentScrollY < topOffset) {
        if (!visibleRef.current) {
          visibleRef.current = true;
          setVisible(true);
        }
        lastScrollYRef.current = currentScrollY;
        return;
      }

      if (delta > threshold) {
        if (visibleRef.current) {
          visibleRef.current = false;
          setVisible(false);
        }
        lastScrollYRef.current = currentScrollY;
        return;
      }

      if (delta < -threshold) {
        if (!visibleRef.current) {
          visibleRef.current = true;
          setVisible(true);
        }
        lastScrollYRef.current = currentScrollY;
        return;
      }

      if (Math.abs(delta) > 1) lastScrollYRef.current = currentScrollY;
    };

    const onScroll = () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      window.requestAnimationFrame(() => {
        updateVisibility();
        tickingRef.current = false;
      });
    };

    lastScrollYRef.current = getScrollY();
    const target = scrollElement || window;
    target.addEventListener('scroll', onScroll, { passive: true });

    return () => target.removeEventListener('scroll', onScroll);
  }, [scrollElement, threshold, topOffset]);

  return visible;
}
