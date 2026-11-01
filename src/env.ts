// Le chiavi: un file solo (secrets.ts, ignorato da git) oppure variabili d'ambiente con gli stessi nomi (per Docker).
// Non vengono mai stampate: chi le usa le passa al Logger, che le maschera.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SECRET_KEYS = [
  "ALPACA_KEY_ID",
  "ALPACA_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ALPACA_ENDPOINT",
] as const;

export type Secrets = Partial<Record<(typeof SECRET_KEYS)[number], string>>;

export async function loadSecrets(): Promise<Secrets> {
  const out: Secrets = {};
  const path = fileURLToPath(new URL("../secrets.ts", import.meta.url));
  if (existsSync(path)) {
    const mod = (await import(path)) as { secrets?: Secrets; default?: Secrets };
    Object.assign(out, mod.secrets ?? mod.default ?? {});
  }
  for (const k of SECRET_KEYS) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  for (const k of SECRET_KEYS) if (!out[k]) delete out[k];
  return out;
}

/** I valori da mascherare nei log. */
export const secretValues = (s: Secrets): string[] => Object.values(s).filter((v): v is string => !!v && v.length >= 6);
