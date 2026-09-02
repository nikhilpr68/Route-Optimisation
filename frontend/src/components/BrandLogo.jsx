import React from "react";
import "./BrandLogo.css";

export default function BrandLogo({
  compact = false,
  onClick,
  size = 34,
  showTagline = true,
}) {
  const className = [
    "brand-logo",
    compact ? "brand-logo--compact" : "",
    onClick ? "brand-logo--clickable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const styles = {
    "--brand-logo-size": `${size}px`,
    "--brand-logo-wordmark-size": compact ? "18px" : "14px",
    "--brand-logo-tagline-size": "10px",
  };

  const content = (
    <>
      <span className="brand-logo__tile">
        <span className="brand-logo__mark" aria-hidden="true">V</span>
      </span>
      <span className="brand-logo__body">
        <span className="brand-logo__wordmark">VELORA</span>
        {showTagline ? (
          <span className="brand-logo__tagline">Driven By Possibility</span>
        ) : null}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        style={styles}
        onClick={onClick}
        aria-label="Velora"
      >
        {content}
      </button>
    );
  }

  return (
    <div className={className} style={styles}>
      {content}
    </div>
  );
}
