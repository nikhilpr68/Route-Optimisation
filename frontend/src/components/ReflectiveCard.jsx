import { useEffect, useId, useRef } from "react";
import "./ReflectiveCard.css";

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value)));
}

const ReflectiveCard = ({
  as: Component = "div",
  children,
  blurStrength = 12,
  color = "#ffffff",
  metalness = 1,
  roughness = 0.75,
  overlayColor = "rgba(255, 255, 255, 0.08)",
  displacementStrength = 20,
  noiseScale = 1,
  specularConstant = 1.2,
  grayscale = 0.15,
  glassDistortion = 0,
  useWebcam = false,
  className = "",
  style = {},
  ...rest
}) => {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const filterId = `reflective-filter-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    if (!useWebcam || !navigator?.mediaDevices?.getUserMedia) return undefined;

    let cancelled = false;

    const startWebcam = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            facingMode: "user",
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play?.().catch(() => {});
        }
      } catch (err) {
        // Keep rendering reflective layers even if webcam is blocked.
        console.error("Error accessing webcam:", err);
      }
    };

    startWebcam();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, [useWebcam]);

  const baseFrequency = 0.03 / Math.max(0.1, Number(noiseScale) || 1);
  const saturation = 1 - clamp01(grayscale);

  const cssVariables = {
    "--reflective-blur-strength": `${blurStrength}px`,
    "--reflective-metalness": metalness,
    "--reflective-roughness": roughness,
    "--reflective-overlay-color": overlayColor,
    "--reflective-text-color": color,
    "--reflective-saturation": saturation,
    "--reflective-glass-distortion": glassDistortion,
    "--reflective-specular": specularConstant,
    "--reflective-displacement-strength": displacementStrength,
  };

  return (
    <Component
      className={`reflective-card-container ${className}`.trim()}
      style={{ ...cssVariables, ...style }}
      {...rest}
    >
      <svg className="reflective-svg-filters" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
            <feTurbulence type="turbulence" baseFrequency={baseFrequency} numOctaves="2" result="noise" />
            <feColorMatrix in="noise" type="luminanceToAlpha" result="noiseAlpha" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale={displacementStrength}
              xChannelSelector="R"
              yChannelSelector="G"
              result="rippled"
            />
            <feSpecularLighting
              in="noiseAlpha"
              surfaceScale={displacementStrength}
              specularConstant={specularConstant}
              specularExponent="20"
              lightingColor="#ffffff"
              result="light"
            >
              <fePointLight x="0" y="0" z="300" />
            </feSpecularLighting>
            <feComposite in="light" in2="rippled" operator="in" result="light-effect" />
            <feBlend in="light-effect" in2="rippled" mode="screen" result="metallic-result" />
          </filter>
        </defs>
      </svg>

      {useWebcam && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="reflective-video"
          style={{
            filter: `saturate(var(--reflective-saturation, 0.85)) contrast(1.2) brightness(1.1) blur(var(--reflective-blur-strength, 12px)) url(#${filterId})`,
          }}
        />
      )}

      <div className="reflective-noise" />
      <div className="reflective-sheen" />
      <div className="reflective-border" />

      <div className="reflective-content">{children}</div>
    </Component>
  );
};

export default ReflectiveCard;