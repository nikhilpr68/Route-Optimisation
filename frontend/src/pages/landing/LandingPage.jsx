import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./LandingPage.css";
import BlurText from "../../components/BlurText";
import Antigravity from "../../components/Antigravity";
import AnimatedContent from "../../components/AnimatedContent";
import MagicBento from "../../components/MagicBento";
import ShinyText from "../../components/ShinyText";
import BrandLogo from "../../components/BrandLogo";

const HOME_PATH = "/home";
const HERO_GLOW_REVEAL_DELAY_MS = 700;

export default function LandingPage() {
  const navigate = useNavigate();
  const [showTitle, setShowTitle] = useState(false);
  const [showHeroBody, setShowHeroBody] = useState(false);
  const [showParticles, setShowParticles] = useState(false);

  const handleHeroBodyAnimationComplete = useCallback(() => {
    setShowParticles(true);
  }, []);

  const goToLogin = () => {
    navigate("/login", { replace: true });
  };

  const goToSignup = () => {
    navigate("/login?mode=signup", { replace: true });
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (token) {
      navigate(HOME_PATH, { replace: true });
    }
  }, [navigate]);

  useEffect(() => {
    const titleTimer = window.setTimeout(() => {
      setShowTitle(true);
    }, HERO_GLOW_REVEAL_DELAY_MS);

    return () => {
      window.clearTimeout(titleTimer);
    };
  }, []);

  return (
    <div className="landing-root">
      <header className="landing-nav">
        <BrandLogo />
        <div className="landing-nav-actions">
          <button
            type="button"
            className="landing-btn landing-btn-primary"
            onClick={goToSignup}
          >
            Sign Up
          </button>
          <button
            type="button"
            className="landing-btn landing-btn-primary"
            onClick={goToLogin}
          >
            Sign In
          </button>
        </div>
      </header>

      <main className="landing-content">
        <section className="hero-section">
          {/* Hero-scoped particle canvas - only covers the hero section */}
          <div
            className={`hero-antigravity-bg ${showParticles ? "hero-antigravity-visible" : ""
              }`}
          >
            {showParticles ? (
              <Antigravity
                count={800}
                magnetRadius={17}
                ringRadius={9}
                waveSpeed={1}
                waveAmplitude={1.1}
                particleSize={0.6}
                lerpSpeed={0.01}
                color="#d0d0d0"
                autoAnimate={false}
                particleVariance={1}
                rotationSpeed={0}
                depthFactor={0.5}
                pulseSpeed={3}
                particleShape="sphere"
                fieldStrength={4.4}
              />
            ) : null}
          </div>

          <div className="hero-content">
            <div className="hero-title-container">
              <div className="hero-glow-bar-container" aria-hidden="true">
                <div className="hero-glow-bar"></div>
              </div>

              <div className="hero-title-slot">
                {showTitle ? (
                  <div className="hero-title">
                    <BlurText
                      text="Optimize"
                      className="hero-title-light"
                      animateBy="words"
                      direction="top"
                      delay={180}
                      stepDuration={0.6}
                    />
                    <BlurText
                      text="Every Commute"
                      className="hero-title-bold"
                      animateBy="words"
                      direction="top"
                      delay={200}
                      stepDuration={0.65}
                      onAnimationComplete={() => setShowHeroBody(true)}
                    />
                  </div>
                ) : null}
              </div>
            </div>

            <div className="hero-body-slot">
              {showHeroBody ? (
                <>
                  <AnimatedContent
                    distance={30}
                    direction="vertical"
                    duration={0.7}
                    ease="power3.out"
                    animateOpacity
                    initialOpacity={0}
                    delay={0}
                    playImmediately
                  >
                    <p className="hero-subtitle">
                      Transform corporate mobility with{" "}
                      <span className="hero-highlight">
                        smart route optimization.
                      </span>
                    </p>
                  </AnimatedContent>

                  <AnimatedContent
                    distance={30}
                    direction="vertical"
                    duration={0.7}
                    ease="power3.out"
                    animateOpacity
                    initialOpacity={0}
                    delay={0.15}
                    playImmediately
                  >
                    <p className="hero-description">
                      Compute efficient pickup routes and vehicle assignments
                      from real employee commute data.
                    </p>
                  </AnimatedContent>

                  <AnimatedContent
                    distance={30}
                    direction="vertical"
                    duration={0.7}
                    ease="power3.out"
                    animateOpacity
                    initialOpacity={0}
                    delay={0.3}
                    playImmediately
                    onComplete={handleHeroBodyAnimationComplete}
                  >
                    <div className="hero-actions">
                      <button
                        type="button"
                        className="hero-btn-primary"
                        onClick={goToLogin}
                      >
                        Start Exploration &rarr;
                      </button>
                    </div>
                  </AnimatedContent>
                </>
              ) : null}
            </div>
          </div>
        </section>

        {showHeroBody && (
          <>
            <section className="landing-section landing-features-section">
              <div className="landing-section-header">
                <h2 className="sr-section-title sr-section-title--centered">
                  <ShinyText
                    text="SCALABLE CORPORATE MOBILITY"
                    speed={0.5}
                    delay={1}
                    color="#e0e0e0"
                    shineColor="#ffffff"
                    spread={100}
                    direction="left"
                    yoyo={false}
                  />
                </h2>
              </div>

              <MagicBento
                columns={4}
                textAutoHide={false}
                enableStars
                enableSpotlight
                enableBorderGlow
                enableTilt={false}
                enableMagnetism={false}
                clickEffect
                spotlightRadius={400}
                particleCount={10}
                glowColor="255, 255, 255"
              >
                <div>
                  <div className="magic-bento-card__header">
                    <div className="magic-bento-card__label">Feature</div>
                  </div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Intelligent Assignment
                    </h2>
                    <p className="magic-bento-card__description">
                      Autonomously maps employees to vehicles, strictly
                      respecting seating capacities and vehicle preferences.
                    </p>
                  </div>
                </div>
                <div>
                  <div className="magic-bento-card__header">
                    <div className="magic-bento-card__label">Feature</div>
                  </div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Time-Window Compliance
                    </h2>
                    <p className="magic-bento-card__description">
                      Generates sequences that honor strict employee travel
                      windows and distinct priority tolerance levels.
                    </p>
                  </div>
                </div>
                <div>
                  <div className="magic-bento-card__header">
                    <div className="magic-bento-card__label">Feature</div>
                  </div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Market Cost Baseline
                    </h2>
                    <p className="magic-bento-card__description">
                      Automatically compares your optimized fleet costs against
                      standard market pricing to prove net savings.
                    </p>
                  </div>
                </div>
                <div>
                  <div className="magic-bento-card__header">
                    <div className="magic-bento-card__label">Feature</div>
                  </div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Map-Based Visualization
                    </h2>
                    <p className="magic-bento-card__description">
                      Distinct visual representation of optimized routes
                      overlaid on initial pick-up and drop-off points.
                    </p>
                  </div>
                </div>
              </MagicBento>
            </section>

            <section className="landing-section">
              <MagicBento
                columns={3}
                textAutoHide={false}
                enableStars
                enableSpotlight
                enableBorderGlow
                enableTilt={false}
                enableMagnetism={false}
                clickEffect
                spotlightRadius={400}
                particleCount={8}
                glowColor="255, 255, 255"
              >
                <div data-variant="magic-bento-card--step">
                  <div className="magic-bento-card__step-index">01</div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Upload Input Files
                    </h2>
                    <p className="magic-bento-card__description">
                      Ingest structured employee requests and available vehicle
                      fleet data via simple Excel uploads.
                    </p>
                  </div>
                </div>
                <div data-variant="magic-bento-card--step">
                  <div className="magic-bento-card__step-index">02</div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">
                      Trigger Optimisation
                    </h2>
                    <p className="magic-bento-card__description">
                      Run the backend engine to compute the optimal assignment
                      and routing plan that minimizes total system cost.
                    </p>
                  </div>
                </div>
                <div data-variant="magic-bento-card--step">
                  <div className="magic-bento-card__step-index">03</div>
                  <div className="magic-bento-card__content">
                    <h2 className="magic-bento-card__title">Analyze Outcomes</h2>
                    <p className="magic-bento-card__description">
                      Visualize the resulting routes on a real-world map and
                      immediately see quantitative time and cost improvements.
                    </p>
                  </div>
                </div>
              </MagicBento>
            </section>

            <section className="landing-section">
              <MagicBento
                columns={4}
                textAutoHide={false}
                enableStars
                enableSpotlight
                enableBorderGlow
                enableTilt={false}
                enableMagnetism={false}
                clickEffect
                spotlightRadius={400}
                particleCount={20}
                glowColor="255, 255, 255"
              >
                <div data-variant="magic-bento-card--stat">
                  <div className="magic-bento-card__content">
                    <p className="magic-bento-card__stat-label">Minimised</p>
                    <p className="magic-bento-card__stat-value">
                      Operational Cost
                    </p>
                  </div>
                </div>
                <div data-variant="magic-bento-card--stat">
                  <div className="magic-bento-card__content">
                    <p className="magic-bento-card__stat-label">Reduced</p>
                    <p className="magic-bento-card__stat-value">
                      Total Travel Time
                    </p>
                  </div>
                </div>
                <div data-variant="magic-bento-card--stat">
                  <div className="magic-bento-card__content">
                    <p className="magic-bento-card__stat-label">Maximized</p>
                    <p className="magic-bento-card__stat-value">
                      Fleet Efficiency
                    </p>
                  </div>
                </div>
                <div data-variant="magic-bento-card--stat">
                  <div className="magic-bento-card__content">
                    <p className="magic-bento-card__stat-label">Guaranteed</p>
                    <p className="magic-bento-card__stat-value">
                      Constraint Adherence
                    </p>
                  </div>
                </div>
              </MagicBento>
            </section>

          </>
        )}
      </main>
    </div>
  );
}
