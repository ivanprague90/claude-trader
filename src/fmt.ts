const usd = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct1 = new Intl.NumberFormat("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** 100000 → "100.000,00 $" */
export const fmtUsd = (n: number): string => `${usd.format(n)} $`;

/** 0.214 → "21,4%". Il segno meno è quello vero (−), come nei messaggi. */
export const fmtPct = (ratio: number): string => `${pct1.format(Math.abs(ratio * 100))}%`.replace(/^/, ratio < 0 ? "−" : "");

export const fmtSignedUsd = (n: number): string => (n < 0 ? "−" : "") + fmtUsd(Math.abs(n));

export function shorten(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}
