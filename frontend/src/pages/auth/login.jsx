import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import "./login.css";
import Hyperspeed from "../../components/background/Hyperspeed";
import {
  forgotPassword as forgotPasswordApi,
  googleAuth,
  login,
  register,
} from "../../api/api";

const MailIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 6.5h16c.8 0 1.5.7 1.5 1.5v8c0 .8-.7 1.5-1.5 1.5H4c-.8 0-1.5-.7-1.5-1.5V8c0-.8.7-1.5 1.5-1.5Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="M4.5 8l7.5 5 7.5-5" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

const LockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7 11V8.8C7 6.15 9.15 4 11.8 4h.4C14.85 4 17 6.15 17 8.8V11"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <path
      d="M6.5 11h11c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-11c-.8 0-1.5-.7-1.5-1.5v-6c0-.8.7-1.5 1.5-1.5Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
  </svg>
);

const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinejoin="round"
    />
    <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" stroke="currentColor" strokeWidth="1.7" />
  </svg>
);

const UserIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" stroke="currentColor" strokeWidth="1.7" />
    <path d="M4 20a8 8 0 0 1 16 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

const GoogleLogo = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
    <path
      fill="#FFC107"
      d="M43.611 20.083H42V20H24v8h11.303C33.673 32.659 29.197 36 24 36c-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
    />
    <path
      fill="#FF3D00"
      d="M6.306 14.691l6.571 4.819C14.655 16.108 19.01 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4c-7.682 0-14.344 4.337-17.694 10.691z"
    />
    <path
      fill="#4CAF50"
      d="M24 44c5.166 0 9.86-1.977 13.409-5.197l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.176 0-9.646-3.319-11.278-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
    />
    <path
      fill="#1976D2"
      d="M43.611 20.083H42V20H24v8h11.303a12.01 12.01 0 0 1-4.087 5.565l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
    />
  </svg>
);

const PASSWORD_STRENGTH_HINT =
  "Password must be at least 8 characters and include uppercase, lowercase, number, and special character.";

function getPasswordStrengthError(rawPassword) {
  const password = String(rawPassword || "");
  if (password.length < 8) return PASSWORD_STRENGTH_HINT;
  if (!/[A-Z]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[a-z]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[0-9]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[^A-Za-z0-9]/.test(password)) return PASSWORD_STRENGTH_HINT;
  return "";
}

function getAuthErrorMessage(err, fallbackMessage) {
  const responseMessage = err?.response?.data?.message;
  if (responseMessage) return responseMessage;

  const errorCode = String(err?.code || "").toUpperCase();
  if (
    errorCode === "ERR_NETWORK" ||
    errorCode === "ECONNABORTED" ||
    /network error/i.test(String(err?.message || ""))
  ) {
    return "Cannot reach the backend. Make sure the backend server is running, then retry.";
  }

  return err?.message || fallbackMessage;
}

const LOGIN_HYPERSPEED_OPTIONS = {
  distortion: "LongRaceDistortion",
  length: 420,
  roadWidth: 10,
  islandWidth: 4,
  lanesPerRoad: 2,
  fov: 90,
  fovSpeedUp: 140,
  speedUp: 2,
  carLightsFade: 0.4,
  totalSideLightSticks: 50,
  lightPairsPerRoadWay: 70,
  shoulderLinesWidthPercentage: 0.05,
  brokenLinesWidthPercentage: 0.1,
  brokenLinesLengthPercentage: 0.5,
  lightStickWidth: [0.12, 0.5],
  lightStickHeight: [1.3, 1.7],
  movingAwaySpeed: [60, 80],
  movingCloserSpeed: [-120, -160],
  carLightsLength: [420 * 0.05, 420 * 0.15],
  carLightsRadius: [0.05, 0.14],
  carWidthPercentage: [0.3, 0.5],
  carShiftX: [-0.2, 0.2],
  carFloorSeparation: [0.05, 1],
  colors: {
    roadColor: 0x080808,
    islandColor: 0x0a0a0a,
    background: 0x000000,
    shoulderLines: 0x131318,
    brokenLines: 0x131318,
    leftCars: [0xff5f73, 0xe74d60, 0xff102a],
    rightCars: [0xa4e3e6, 0x80d1d4, 0x53c2c6],
    sticks: 0xa4e3e6,
  },
};

export default function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedMode = String(searchParams.get("mode") || "").trim().toLowerCase();
  const initialMode = requestedMode === "signup" ? "signup" : "signin";
  const [showPanels, setShowPanels] = useState(false);
  const [mode, setMode] = useState(initialMode);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState("");
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [showForgotModal, setShowForgotModal] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotNewPassword, setForgotNewPassword] = useState("");
  const [forgotConfirmPassword, setForgotConfirmPassword] = useState("");
  const [forgotError, setForgotError] = useState("");
  const [forgotSuccess, setForgotSuccess] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const googleBtnRef = useRef(null);
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
  const intent = String(searchParams.get("intent") || "").trim().toLowerCase();
  const postAuthPath = intent === "subscribe" ? "/settings" : "/home";

  const goToLandingPage = () => {
    navigate("/");
  };

  useEffect(() => {
    setShowPanels(false);
    const revealTimer = window.setTimeout(() => {
      setShowPanels(true);
    }, 700);

    return () => {
      window.clearTimeout(revealTimer);
    };
  }, []);

  useEffect(() => {
    setMode(initialMode);
    setError("");
    setSignupSuccess("");
  }, [initialMode]);

  useEffect(() => {
    if (!googleClientId || mode !== "signin") return;

    const mountGoogleButton = () => {
      if (!window.google?.accounts?.id || !googleBtnRef.current) return;

      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response) => {
          try {
            if (!response?.credential) throw new Error("Google sign-in failed");
            setError("");
            setLoading(true);
            await googleAuth(response.credential);
            navigate(postAuthPath, { replace: true });
          } catch (err) {
            setError(getAuthErrorMessage(err, "Google authentication failed"));
          } finally {
            setLoading(false);
          }
        },
      });

      googleBtnRef.current.innerHTML = "";
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: "outline",
        size: "large",
        width: 360,
        text: "signin_with",
        shape: "pill",
      });
    };

    if (window.google?.accounts?.id) {
      mountGoogleButton();
      return;
    }

    const existingScript = document.getElementById("google-gsi-script");
    if (existingScript) {
      existingScript.addEventListener("load", mountGoogleButton);
      return () => existingScript.removeEventListener("load", mountGoogleButton);
    }

    const script = document.createElement("script");
    script.id = "google-gsi-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = mountGoogleButton;
    document.body.appendChild(script);
  }, [googleClientId, mode, navigate, postAuthPath]);

  const switchMode = (nextMode) => {
    setMode(nextMode);
    setError("");
    setSignupSuccess("");
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!email || !password || (mode === "signup" && !name)) {
      setError("Please fill in all required fields.");
      return;
    }

    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (mode === "signup") {
      const passwordError = getPasswordStrengthError(password);
      if (passwordError) {
        setError(passwordError);
        return;
      }
    }

    setError("");
    setSignupSuccess("");
    setLoading(true);
    try {
      if (mode === "signup") {
        await register(name, email, password);
        setSignupSuccess("Account created successfully.");
        navigate(postAuthPath, { replace: true });
      } else {
        await login(email, password);
        navigate(postAuthPath, { replace: true });
      }
    } catch (err) {
      setError(getAuthErrorMessage(err, mode === "signup" ? "Sign up failed" : "Login failed"));
    } finally {
      setLoading(false);
    }
  };

  const openForgotModal = () => {
    setForgotEmail(email);
    setForgotNewPassword("");
    setForgotConfirmPassword("");
    setForgotError("");
    setForgotSuccess("");
    setShowForgotPassword(false);
    setShowForgotModal(true);
  };

  const closeForgotModal = () => {
    if (forgotLoading) return;
    setShowForgotModal(false);
  };

  const handleForgotSubmit = async (e) => {
    e.preventDefault();

    if (!forgotEmail || !forgotNewPassword || !forgotConfirmPassword) {
      setForgotError("Please fill in all fields.");
      return;
    }

    const forgotPasswordStrengthError = getPasswordStrengthError(forgotNewPassword);
    if (forgotPasswordStrengthError) {
      setForgotError(forgotPasswordStrengthError);
      return;
    }

    if (forgotNewPassword !== forgotConfirmPassword) {
      setForgotError("Passwords do not match.");
      return;
    }

    setForgotError("");
    setForgotSuccess("");
    setForgotLoading(true);

    try {
      await forgotPasswordApi(forgotEmail, forgotNewPassword);
      setForgotSuccess("Password changed successfully. Sign in with your new password.");
      setEmail(forgotEmail);
      setPassword("");
      setConfirmPassword("");
      switchMode("signin");
    } catch (err) {
      setForgotError(getAuthErrorMessage(err, "Failed to reset password"));
    } finally {
      setForgotLoading(false);
    }
  };

  const headingText = mode === "signup" ? "Create your account" : "Welcome back";
  const isSigninCredentials = mode === "signin";

  return (
    <div className="login-root">
      <div className="login-background" aria-hidden="true">
        <Hyperspeed effectOptions={LOGIN_HYPERSPEED_OPTIONS} />
      </div>
      <div className={`login-page ${showPanels ? "login-page--visible" : ""}`}>
        <div className="login-container">
          <div className="login-half login-half-left">
            <div className="login-card-shell login-card-static">
              <div className="login-card-shell-inner">
                <div className="login-card login-card-left">
                  <button
                    type="button"
                    className="login-backLink login-linkBtn"
                    onClick={goToLandingPage}
                  >
                    &larr; Back to landing page
                  </button>
                  <h2 className="login-heading">{headingText}</h2>
                  {isSigninCredentials ? (
                    <p className="login-subheading">Sign in to continue to Velora</p>
                  ) : null}

                  <form onSubmit={handleSubmit} className="login-form">
                    <>
                      {mode === "signup" && (
                        <>
                          <label className="login-label">Full Name</label>
                          <div className="login-inputWrapper">
                            <span className="login-icon">
                              <UserIcon />
                            </span>
                            <input
                              className="login-input"
                              type="text"
                              placeholder="Jane Doe"
                              value={name}
                              onChange={(e) => setName(e.target.value)}
                              autoComplete="name"
                            />
                          </div>
                        </>
                      )}

                      <label className={`login-label ${mode === "signup" ? "login-label-mt" : ""}`}>Email Address</label>
                      <div className="login-inputWrapper">
                        <span className="login-icon">
                          <MailIcon />
                        </span>
                        <input
                          className="login-input"
                          type="email"
                          placeholder="you@example.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          autoComplete="email"
                        />
                      </div>

                      <>
                        <>
                          <label className="login-label login-label-mt">Password</label>
                          <div className="login-inputWrapper">
                            <span className="login-icon">
                              <LockIcon />
                            </span>
                            <input
                              className="login-input"
                              type={showPassword ? "text" : "password"}
                              placeholder="********"
                              value={password}
                              onChange={(e) => setPassword(e.target.value)}
                              autoComplete={mode === "signup" ? "new-password" : "current-password"}
                            />
                            <span className="login-eye" style={{ cursor: "pointer" }} onClick={() => setShowPassword(!showPassword)}>
                              <EyeIcon />
                            </span>
                          </div>
                        </>
                      </>

                      <>
                        {mode === "signup" && (
                          <>
                            <label className="login-label login-label-mt">Confirm Password</label>
                            <div className="login-inputWrapper">
                              <span className="login-icon">
                                <LockIcon />
                              </span>
                              <input
                                className="login-input"
                                type={showPassword ? "text" : "password"}
                                placeholder="********"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                autoComplete="new-password"
                              />
                            </div>
                            <p className="login-passwordHint">{PASSWORD_STRENGTH_HINT}</p>
                          </>
                        )}

                        {error && (
                          <p style={{ color: "#f87171", fontSize: "0.85rem", margin: "10px 0 0 0" }}>
                            {error}
                          </p>
                        )}

                        {mode === "signup" && signupSuccess && (
                          <p className="login-otpStatus">{signupSuccess}</p>
                        )}

                        {mode === "signin" && (
                          <div className="login-row">
                            <label className="login-checkboxRow">
                              <input type="checkbox" className="login-checkbox" />
                              <span className="login-mutedText">Remember me</span>
                            </label>

                            <button
                              type="button"
                              className="login-link login-linkBtn"
                              onClick={(e) => {
                                e.preventDefault();
                                openForgotModal();
                              }}
                            >
                              Forgot Password?
                            </button>
                          </div>
                        )}

                        <button
                          className={`login-primaryBtn ${mode === "signup" ? "login-primaryBtn-signup" : ""}`}
                          type="submit"
                          disabled={loading}
                          style={{ opacity: loading ? 0.7 : 1 }}
                        >
                          {loading
                            ? mode === "signup"
                              ? "Creating Account..."
                              : "Signing In..."
                            : mode === "signup"
                              ? "Create Account"
                              : "Sign In"}
                        </button>
                        {mode === "signup" && (
                          <div className="login-inlineSwitch">
                            <span className="login-mutedText">Already have an account?</span>{" "}
                            <span
                              className="login-link"
                              style={{ cursor: "pointer" }}
                              onClick={() => switchMode("signin")}
                            >
                              Continue with Sign in
                            </span>
                          </div>
                        )}
                      </>
                    </>
                  </form>

                  {mode === "signin" && (
                    <>
                      <div className="login-divider">
                        <span className="login-dividerLine" />
                        <span className="login-dividerText">Or continue with</span>
                        <span className="login-dividerLine" />
                      </div>

                      {googleClientId ? (
                        <div className="login-googleContainer">
                          <div ref={googleBtnRef} />
                        </div>
                      ) : (
                        <button className="login-googleBtn" disabled>
                          <span className="login-googleIcon" aria-hidden="true">
                            <GoogleLogo />
                          </span>
                          Set VITE_GOOGLE_CLIENT_ID to enable Google Sign-In
                        </button>
                      )}
                    </>
                  )}

                  {mode === "signin" && (
                    <div className="login-footer">
                      <span className="login-mutedText">New to Velora?</span>{" "}
                      <span
                        className="login-link"
                        style={{ cursor: "pointer" }}
                        onClick={() => switchMode("signup")}
                      >
                        Create account
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="login-half login-half-right">
            <div className="login-card-shell login-card-static">
              <div className="login-card-shell-inner">
                <div className="login-card login-rightCard">
                  <p className="login-eyebrow">Corporate Mobility Platform</p>
                  <h1 className="login-bigTitle">Smarter employee transport, planned in minutes.</h1>

                  <p className="login-rightText">
                    Centralize fleet assignment, route planning, and operational visibility in one workspace built for high-frequency commute operations.
                  </p>

                  <div className="login-statGrid">
                    <div className="login-statCard">
                      <p className="login-statValue">Lower planning overhead</p>
                      <p className="login-statLabel">Move daily transport planning out of fragmented spreadsheets.</p>
                    </div>
                    <div className="login-statCard">
                      <p className="login-statValue">Better fleet decisions</p>
                      <p className="login-statLabel">See assignment tradeoffs before routes are finalized.</p>
                    </div>
                  </div>

                  <div className="login-featureGrid">
                    <div className="login-featureCard">
                      <p className="login-featureTitle">Faster planning</p>
                      <p className="login-featureText">
                        Turn employee demand and fleet availability into route-ready plans without spreadsheet churn.
                      </p>
                    </div>
                    <div className="login-featureCard">
                      <p className="login-featureTitle">Constraint-aware decisions</p>
                      <p className="login-featureText">
                        Balance capacity, sequencing, and operating conditions before routes go live.
                      </p>
                    </div>
                  </div>

                  <p className="login-tagline">Operational control for every shift, every vehicle, every route.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showForgotModal && (
        <div className="login-modalOverlay" onClick={closeForgotModal}>
          <div className="login-modalCard" onClick={(e) => e.stopPropagation()}>
            <h3 className="login-modalTitle">Reset Password</h3>
            <p className="login-modalText">Enter your email and choose a new password.</p>

            <form className="login-modalForm" onSubmit={handleForgotSubmit}>
              <>
                  <label className="login-label">Email Address</label>
                  <div className="login-inputWrapper">
                    <span className="login-icon">
                      <MailIcon />
                    </span>
                    <input
                      className="login-input"
                      type="email"
                      placeholder="you@example.com"
                      value={forgotEmail}
                      onChange={(e) => setForgotEmail(e.target.value)}
                      autoComplete="email"
                    />
                  </div>

                  <label className="login-label login-label-mt">New Password</label>
                  <div className="login-inputWrapper">
                    <span className="login-icon">
                      <LockIcon />
                    </span>
                    <input
                      className="login-input"
                      type={showForgotPassword ? "text" : "password"}
                      placeholder="********"
                      value={forgotNewPassword}
                      onChange={(e) => setForgotNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                    <span className="login-eye" style={{ cursor: "pointer" }} onClick={() => setShowForgotPassword(!showForgotPassword)}>
                      <EyeIcon />
                    </span>
                  </div>
                  <p className="login-passwordHint">{PASSWORD_STRENGTH_HINT}</p>

                  <label className="login-label login-label-mt">Confirm New Password</label>
                  <div className="login-inputWrapper">
                    <span className="login-icon">
                      <LockIcon />
                    </span>
                    <input
                      className="login-input"
                      type={showForgotPassword ? "text" : "password"}
                      placeholder="********"
                      value={forgotConfirmPassword}
                      onChange={(e) => setForgotConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
              </>

              {forgotError && <p className="login-modalError">{forgotError}</p>}
              {forgotSuccess && <p className="login-modalSuccess">{forgotSuccess}</p>}

              <div className="login-modalActions">
                <button
                  type="button"
                  className="login-modalBtn login-modalBtn-secondary"
                  onClick={closeForgotModal}
                  disabled={forgotLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="login-modalBtn login-modalBtn-primary"
                  disabled={forgotLoading}
                >
                  {forgotLoading
                    ? "Updating..."
                    : "Update Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
