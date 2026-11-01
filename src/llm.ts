// Il cervello: Claude Code in modalità headless (`claude -p`), senza strumenti, con risposta JSON a schema fisso.
// Cambiare cervello (altro modello, API a consumo) vuol dire cambiare solo questo file.

import { BRAIN_TIMEOUT_MS, CAGE, UNIVERSE } from "./config.ts";
import { BrainError, type Brain, type BrainInput, type Decision } from "./types.ts";

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["orders", "reasoning", "planNext"],
  properties: {
    orders: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol", "side", "qty", "why"],
        properties: {
          symbol: { type: "string" },
          side: { type: "string", enum: ["buy", "sell"] },
          qty: { type: "number" },
          why: { type: "string" },
        },
      },
    },
    reasoning: { type: "string" },
    planNext: { type: "string" },
  },
} as const;

/** Validazione stretta della struttura. I valori (quantità negativa, titolo fuori universo…) li giudica la gabbia. */
export function parseDecision(raw: unknown): Decision {
  const fail = (m: string): never => {
    throw new BrainError(`risposta del cervello non valida: ${m}`);
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("non è un oggetto JSON");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.orders)) return fail("campo mancante o sbagliato: orders");
  if (typeof r.reasoning !== "string" || r.reasoning.trim() === "") return fail("campo mancante o sbagliato: reasoning");
  if (typeof r.planNext !== "string" || r.planNext.trim() === "") return fail("campo mancante o sbagliato: planNext");
  const orders = r.orders.map((o, i) => {
    if (o === null || typeof o !== "object") return fail(`orders[${i}] non è un oggetto`);
    const x = o as Record<string, unknown>;
    if (typeof x.symbol !== "string") return fail(`orders[${i}].symbol mancante`);
    if (typeof x.side !== "string") return fail(`orders[${i}].side mancante`);
    if (typeof x.qty !== "number" || !Number.isFinite(x.qty)) return fail(`orders[${i}].qty mancante o non numerica`);
    if (typeof x.why !== "string") return fail(`orders[${i}].why mancante`);
    return { symbol: x.symbol, side: x.side, qty: x.qty, why: x.why };
  });
  return { orders, reasoning: r.reasoning.trim(), planNext: r.planNext.trim() };
}

/** Dal testo che il modello ha risposto (anche con ```json … ```) a una decisione valida. */
export function decisionFromText(text: string): Decision {
  const t = text.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) throw new BrainError("risposta del cervello non valida: nessun JSON nel testo");
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.slice(start, end + 1));
  } catch {
    throw new BrainError("risposta del cervello non valida: JSON troncato o malformato");
  }
  return parseDecision(parsed);
}

const SYSTEM_PROMPT = `Sei un trader che lavora su un conto DEMO (paper trading, soldi finti). Ti svegli a orari fissi, senza memoria: il tuo unico ricordo è il "testimone" che ti ha lasciato la sveglia prima (campo baton), più lo stato del conto che ti viene dato.

Le regole sono applicate dal codice, non da te: un ordine fuori regola viene scartato e te lo ritroverai fra i "rejected" del testimone.
- Universo ammesso: ${UNIVERSE.join(", ")}. Il resto viene rifiutato.
- Massimo ${CAGE.maxPositions} titoli in portafoglio e massimo ${CAGE.maxWeight * 100}% del conto per titolo (conta le azioni che hai già più quelle che compri).
- Solo azioni intere, niente short, niente leva (non puoi spendere più della liquidità).
- Stop loss a ${CAGE.stopLoss * 100}% dal prezzo di carico: il codice vende da solo, anche se tu non lo chiedi.
- Nel briefing delle 09:00 e a mercato chiuso non si inviano ordini: lascia "orders" vuoto.

Rispondi SOLO con un oggetto JSON, tutto in italiano:
{"orders":[{"symbol":"SPY","side":"buy","qty":10,"why":"una frase"}],"reasoning":"3–5 frasi","planNext":"cosa controllare alla prossima sveglia"}
"planNext" è l'unico modo che hai per ricordarti qualcosa: scrivilo come se lo lasciassi a un collega.
Se negli "notes" c'è una sveglia interrotta o saltata, tienine conto: non ripetere ordini già eseguiti (li vedi in recentOrders).
Non inventare prezzi o notizie che non sono nei dati che ricevi.`;

export interface ClaudeBrainOptions {
  model?: string;
  timeoutMs?: number;
  claudeBin?: string;
  /** solo su un server, dove nessuno ha fatto il login: claude setup-token */
  oauthToken?: string;
}

export class ClaudeBrain implements Brain {
  readonly name = "claude -p (headless)";
  constructor(private opts: ClaudeBrainOptions = {}) {}

  async decide(input: BrainInput): Promise<Decision> {
    const args = [
      this.opts.claudeBin ?? "claude",
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(DECISION_SCHEMA),
      "--tools",
      "",
      "--no-session-persistence",
      "--system-prompt",
      SYSTEM_PROMPT,
    ];
    if (this.opts.model) args.push("--model", this.opts.model);

    const env = { ...process.env } as Record<string, string>;
    if (this.opts.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.opts.oauthToken;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    } catch (e) {
      throw new BrainError(`impossibile avviare claude: ${(e as Error).message}`);
    }
    const timeoutMs = this.opts.timeoutMs ?? BRAIN_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    try {
      const stdin = proc.stdin as import("bun").FileSink;
      stdin.write(`Dati della sveglia (JSON):\n${JSON.stringify(input, null, 2)}\n\nRispondi con la tua decisione.`);
      await stdin.end();
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]);
      if (timedOut) throw new BrainError(`il cervello non ha risposto entro ${Math.round(timeoutMs / 1000)} secondi`);
      if (code !== 0) throw new BrainError(`claude è uscito con codice ${code}: ${(claudeErrorDetail(out) || err.trim()).slice(0, 300)}`);
      return decisionFromClaudeOutput(out);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Con --output-format json gli errori (login scaduto, rete…) arrivano su stdout, nel campo `result`. */
export function claudeErrorDetail(stdout: string): string {
  try {
    const w = JSON.parse(stdout) as { result?: unknown };
    return typeof w.result === "string" ? w.result : "";
  } catch {
    return "";
  }
}

/** L'output di `claude -p --output-format json`: un oggetto con `structured_output` oppure `result` (testo). */
export function decisionFromClaudeOutput(stdout: string): Decision {
  let wrapper: Record<string, unknown>;
  try {
    wrapper = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    // forse è già il JSON della decisione, o testo
    return decisionFromText(stdout);
  }
  if (wrapper.is_error === true) {
    throw new BrainError(`claude ha risposto con un errore: ${String(wrapper.result ?? "").slice(0, 300)}`);
  }
  if (wrapper.structured_output && typeof wrapper.structured_output === "object") {
    return parseDecision(wrapper.structured_output);
  }
  if (typeof wrapper.result === "string") return decisionFromText(wrapper.result);
  if ("orders" in wrapper) return parseDecision(wrapper);
  throw new BrainError("risposta del cervello non valida: né structured_output né result");
}
