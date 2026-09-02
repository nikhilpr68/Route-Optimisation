import { useRef, useEffect, useCallback, useState } from 'react';
import { gsap } from 'gsap';
import './MagicBento.css';

const DEFAULT_PARTICLE_COUNT = 12;
const DEFAULT_SPOTLIGHT_RADIUS = 300;
const DEFAULT_GLOW_COLOR = '255, 255, 255';
const MOBILE_BREAKPOINT = 768;

const createParticleElement = (x, y, color = DEFAULT_GLOW_COLOR) => {
    const el = document.createElement('div');
    el.className = 'particle';
    el.style.cssText = `
    position: absolute;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(${color}, 1);
    box-shadow: 0 0 6px rgba(${color}, 0.6);
    pointer-events: none;
    z-index: 100;
    left: ${x}px;
    top: ${y}px;
  `;
    return el;
};

const calculateSpotlightValues = radius => ({
    proximity: radius * 0.5,
    fadeDistance: radius * 0.75
});

const updateCardGlowProperties = (card, mouseX, mouseY, glow, radius) => {
    const rect = card.getBoundingClientRect();
    const relativeX = ((mouseX - rect.left) / rect.width) * 100;
    const relativeY = ((mouseY - rect.top) / rect.height) * 100;

    card.style.setProperty('--glow-x', `${relativeX}%`);
    card.style.setProperty('--glow-y', `${relativeY}%`);
    card.style.setProperty('--glow-intensity', glow.toString());
    card.style.setProperty('--glow-radius', `${radius}px`);
};

/* ─── ParticleCard wrapper ─── */
const ParticleCard = ({
    children,
    className = '',
    disableAnimations = false,
    style,
    particleCount = DEFAULT_PARTICLE_COUNT,
    glowColor = DEFAULT_GLOW_COLOR,
    enableTilt = true,
    clickEffect = false,
    enableMagnetism = false
}) => {
    const cardRef = useRef(null);
    const particlesRef = useRef([]);
    const timeoutsRef = useRef([]);
    const isHoveredRef = useRef(false);
    const memoizedParticles = useRef([]);
    const particlesInitialized = useRef(false);
    const magnetismAnimationRef = useRef(null);

    const initializeParticles = useCallback(() => {
        if (particlesInitialized.current || !cardRef.current) return;
        const { width, height } = cardRef.current.getBoundingClientRect();
        memoizedParticles.current = Array.from({ length: particleCount }, () =>
            createParticleElement(Math.random() * width, Math.random() * height, glowColor)
        );
        particlesInitialized.current = true;
    }, [particleCount, glowColor]);

    const clearAllParticles = useCallback(() => {
        timeoutsRef.current.forEach(clearTimeout);
        timeoutsRef.current = [];
        magnetismAnimationRef.current?.kill();
        particlesRef.current.forEach(p => {
            gsap.to(p, { scale: 0, opacity: 0, duration: 0.3, ease: 'back.in(1.7)', onComplete: () => p.parentNode?.removeChild(p) });
        });
        particlesRef.current = [];
    }, []);

    const animateParticles = useCallback(() => {
        if (!cardRef.current || !isHoveredRef.current) return;
        if (!particlesInitialized.current) initializeParticles();

        memoizedParticles.current.forEach((particle, i) => {
            const tid = setTimeout(() => {
                if (!isHoveredRef.current || !cardRef.current) return;
                const clone = particle.cloneNode(true);
                cardRef.current.appendChild(clone);
                particlesRef.current.push(clone);
                gsap.fromTo(clone, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'back.out(1.7)' });
                gsap.to(clone, { x: (Math.random() - 0.5) * 100, y: (Math.random() - 0.5) * 100, rotation: Math.random() * 360, duration: 2 + Math.random() * 2, ease: 'none', repeat: -1, yoyo: true });
                gsap.to(clone, { opacity: 0.3, duration: 1.5, ease: 'power2.inOut', repeat: -1, yoyo: true });
            }, i * 100);
            timeoutsRef.current.push(tid);
        });
    }, [initializeParticles]);

    useEffect(() => {
        if (disableAnimations || !cardRef.current) return;
        const el = cardRef.current;

        const onEnter = () => { isHoveredRef.current = true; animateParticles(); if (enableTilt) gsap.to(el, { rotateX: 5, rotateY: 5, duration: 0.3, ease: 'power2.out', transformPerspective: 1000 }); };
        const onLeave = () => { isHoveredRef.current = false; clearAllParticles(); if (enableTilt) gsap.to(el, { rotateX: 0, rotateY: 0, duration: 0.3, ease: 'power2.out' }); if (enableMagnetism) gsap.to(el, { x: 0, y: 0, duration: 0.3, ease: 'power2.out' }); };
        const onMove = e => {
            if (!enableTilt && !enableMagnetism) return;
            const rect = el.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const cx = rect.width / 2, cy = rect.height / 2;
            if (enableTilt) gsap.to(el, { rotateX: ((y - cy) / cy) * -10, rotateY: ((x - cx) / cx) * 10, duration: 0.1, ease: 'power2.out', transformPerspective: 1000 });
            if (enableMagnetism) { magnetismAnimationRef.current = gsap.to(el, { x: (x - cx) * 0.05, y: (y - cy) * 0.05, duration: 0.3, ease: 'power2.out' }); }
        };
        const onClick = e => {
            if (!clickEffect) return;
            const rect = el.getBoundingClientRect(); const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const maxD = Math.max(Math.hypot(x, y), Math.hypot(x - rect.width, y), Math.hypot(x, y - rect.height), Math.hypot(x - rect.width, y - rect.height));
            const ripple = document.createElement('div');
            ripple.style.cssText = `position:absolute;width:${maxD * 2}px;height:${maxD * 2}px;border-radius:50%;background:radial-gradient(circle,rgba(${glowColor},0.4) 0%,rgba(${glowColor},0.2) 30%,transparent 70%);left:${x - maxD}px;top:${y - maxD}px;pointer-events:none;z-index:1000;`;
            el.appendChild(ripple);
            gsap.fromTo(ripple, { scale: 0, opacity: 1 }, { scale: 1, opacity: 0, duration: 0.8, ease: 'power2.out', onComplete: () => ripple.remove() });
        };

        el.addEventListener('mouseenter', onEnter); el.addEventListener('mouseleave', onLeave); el.addEventListener('mousemove', onMove); el.addEventListener('click', onClick);
        return () => { isHoveredRef.current = false; el.removeEventListener('mouseenter', onEnter); el.removeEventListener('mouseleave', onLeave); el.removeEventListener('mousemove', onMove); el.removeEventListener('click', onClick); clearAllParticles(); };
    }, [animateParticles, clearAllParticles, disableAnimations, enableTilt, enableMagnetism, clickEffect, glowColor]);

    return (
        <div ref={cardRef} className={`${className} particle-container`} style={{ ...style, position: 'relative', overflow: 'hidden' }}>
            {children}
        </div>
    );
};

/* ─── Global Spotlight ─── */
const GlobalSpotlight = ({ gridRef, disableAnimations = false, enabled = true, spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS, glowColor = DEFAULT_GLOW_COLOR }) => {
    const spotlightRef = useRef(null);

    useEffect(() => {
        if (disableAnimations || !gridRef?.current || !enabled) return;

        const spotlight = document.createElement('div');
        spotlight.className = 'global-spotlight';
        spotlight.style.cssText = `position:fixed;width:800px;height:800px;border-radius:50%;pointer-events:none;background:radial-gradient(circle,rgba(${glowColor},0.15) 0%,rgba(${glowColor},0.08) 15%,rgba(${glowColor},0.04) 25%,rgba(${glowColor},0.02) 40%,rgba(${glowColor},0.01) 65%,transparent 70%);z-index:200;opacity:0;transform:translate(-50%,-50%);mix-blend-mode:screen;`;
        document.body.appendChild(spotlight);
        spotlightRef.current = spotlight;

        const handleMouseMove = e => {
            if (!spotlightRef.current || !gridRef.current) return;
            const section = gridRef.current.closest('.bento-section');
            const rect = section?.getBoundingClientRect();
            const inside = rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
            const cards = gridRef.current.querySelectorAll('.magic-bento-card');

            if (!inside) {
                gsap.to(spotlightRef.current, { opacity: 0, duration: 0.3, ease: 'power2.out' });
                cards.forEach(c => c.style.setProperty('--glow-intensity', '0'));
                return;
            }

            const { proximity, fadeDistance } = calculateSpotlightValues(spotlightRadius);
            let minD = Infinity;
            cards.forEach(card => {
                const cr = card.getBoundingClientRect();
                const dist = Math.max(0, Math.hypot(e.clientX - (cr.left + cr.width / 2), e.clientY - (cr.top + cr.height / 2)) - Math.max(cr.width, cr.height) / 2);
                minD = Math.min(minD, dist);
                const glow = dist <= proximity ? 1 : dist <= fadeDistance ? (fadeDistance - dist) / (fadeDistance - proximity) : 0;
                updateCardGlowProperties(card, e.clientX, e.clientY, glow, spotlightRadius);
            });

            gsap.to(spotlightRef.current, { left: e.clientX, top: e.clientY, duration: 0.1, ease: 'power2.out' });
            const op = minD <= proximity ? 0.8 : minD <= fadeDistance ? ((fadeDistance - minD) / (fadeDistance - proximity)) * 0.8 : 0;
            gsap.to(spotlightRef.current, { opacity: op, duration: op > 0 ? 0.2 : 0.5, ease: 'power2.out' });
        };

        const handleLeave = () => {
            gridRef.current?.querySelectorAll('.magic-bento-card').forEach(c => c.style.setProperty('--glow-intensity', '0'));
            if (spotlightRef.current) gsap.to(spotlightRef.current, { opacity: 0, duration: 0.3, ease: 'power2.out' });
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseleave', handleLeave);
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseleave', handleLeave);
            spotlightRef.current?.parentNode?.removeChild(spotlightRef.current);
        };
    }, [gridRef, disableAnimations, enabled, spotlightRadius, glowColor]);

    return null;
};

/* ─── useMobileDetection ─── */
const useMobileDetection = () => {
    const [isMobile, setIsMobile] = useState(false);
    useEffect(() => {
        const check = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
        check();
        window.addEventListener('resize', check);
        return () => window.removeEventListener('resize', check);
    }, []);
    return isMobile;
};

/* ─── MagicBento ─── */
const MagicBento = ({
    children,
    columns = 4,
    textAutoHide = true,
    enableStars = true,
    enableSpotlight = true,
    enableBorderGlow = true,
    disableAnimations = false,
    spotlightRadius = DEFAULT_SPOTLIGHT_RADIUS,
    particleCount = DEFAULT_PARTICLE_COUNT,
    enableTilt = false,
    glowColor = DEFAULT_GLOW_COLOR,
    clickEffect = true,
    enableMagnetism = true
}) => {
    const gridRef = useRef(null);
    const isMobile = useMobileDetection();
    const shouldDisable = disableAnimations || isMobile;

    return (
        <>
            {enableSpotlight && (
                <GlobalSpotlight
                    gridRef={gridRef}
                    disableAnimations={shouldDisable}
                    enabled={enableSpotlight}
                    spotlightRadius={spotlightRadius}
                    glowColor={glowColor}
                />
            )}

            <div
                className={`magic-bento-grid magic-bento-grid--${columns} bento-section`}
                ref={gridRef}
            >
                {Array.isArray(children)
                    ? children.map((child, i) => {
                        const cls = `magic-bento-card ${textAutoHide ? 'magic-bento-card--text-autohide' : ''} ${enableBorderGlow ? 'magic-bento-card--border-glow' : ''} ${child.props?.['data-variant'] || ''}`;
                        const cardStyle = { backgroundColor: '#060010', '--glow-color': glowColor };

                        if (enableStars) {
                            return (
                                <ParticleCard
                                    key={i}
                                    className={cls}
                                    style={cardStyle}
                                    disableAnimations={shouldDisable}
                                    particleCount={particleCount}
                                    glowColor={glowColor}
                                    enableTilt={enableTilt}
                                    clickEffect={clickEffect}
                                    enableMagnetism={enableMagnetism}
                                >
                                    {child}
                                </ParticleCard>
                            );
                        }

                        return (
                            <div key={i} className={cls} style={cardStyle}>
                                {child}
                            </div>
                        );
                    })
                    : children}
            </div>
        </>
    );
};

export default MagicBento;
