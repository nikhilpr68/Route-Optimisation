export function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function formatUSD(value, options = {}) {
  const {
    fallback = "—",
    maxFractionDigits = 0,
    minFractionDigits = 0,
  } = options;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: maxFractionDigits,
    minimumFractionDigits: minFractionDigits,
  }).format(n);
}

export function formatUSDCompact(value, options = {}) {
  const { fallback = "$0", maxFractionDigits = 1 } = options;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: maxFractionDigits,
  }).format(n);
}
