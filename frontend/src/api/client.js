import axios from "axios";

const normalizeApiBaseUrl = (rawUrl) => {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  // Recover common typo: http://localhost//5001 -> http://localhost:5001
  const localhostPortTypo = value.match(/^(https?:\/\/localhost)\/\/(\d+)(\/.*)?$/i);
  if (localhostPortTypo) {
    return `${localhostPortTypo[1]}:${localhostPortTypo[2]}${localhostPortTypo[3] || ""}`;
  }

  if (/^https?:\/\//i.test(value)) return value;

  // Recover common missing scheme case:
  // route-optimization-mu.vercel.app -> https://route-optimization-mu.vercel.app
  const bareHostMatch = value.match(/^([a-z0-9.-]+)(:\d+)?(\/.*)?$/i);
  if (bareHostMatch) {
    const host = String(bareHostMatch[1] || "").toLowerCase();
    const protocol = host === "localhost" || host === "127.0.0.1" ? "http" : "https";
    return `${protocol}://${bareHostMatch[1]}${bareHostMatch[2] || ""}${bareHostMatch[3] || ""}`;
  }

  return value;
};

const inferLocalApiBaseUrl = () => {
  if (typeof window === "undefined") return "";
  const hostname = String(window.location.hostname || "").trim().toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return import.meta.env.DEV ? "/api" : "http://localhost:5001";
  }
  return "";
};

const deployedApiBase = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_BASE || ""
);
const fallbackApiBase = normalizeApiBaseUrl(
  import.meta.env.VITE_API_BASE_URL_FALLBACK || import.meta.env.VITE_API_BASE_URL_LOCAL || ""
);
const useFallbackApi =
  String(import.meta.env.VITE_API_USE_FALLBACK || "").trim().toLowerCase() === "true";
const inferredLocalApiBase = inferLocalApiBaseUrl();
const shouldPreferLocalFallback =
  Boolean(inferredLocalApiBase) &&
  Boolean(fallbackApiBase) &&
  fallbackApiBase === inferredLocalApiBase;
const apiBaseUrl = shouldPreferLocalFallback
  ? fallbackApiBase
  : useFallbackApi && fallbackApiBase
    ? fallbackApiBase
    : (deployedApiBase || fallbackApiBase || inferredLocalApiBase);

const api = axios.create({
  baseURL: apiBaseUrl,
  withCredentials: true, // safe even if you don't use cookies yet
});

api.interceptors.request.use((config) => {
  if (
    typeof config.url === "string" &&
    String(config.baseURL || "").replace(/\/+$/, "") === "/api" &&
    config.url.startsWith("/api/")
  ) {
    config.url = config.url.slice(4);
  }

  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default api;
