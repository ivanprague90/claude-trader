// Tutte le regole e i numeri del trader stanno qui. La gabbia (src/cage.ts) li legge da qui.

/** Solo paper trading: l'endpoint è scritto nel codice e non si configura. */
export const PAPER_ENDPOINT = "https://paper-api.alpaca.markets";
/** Prezzi di mercato (sola lettura). Non è l'endpoint dei soldi. */
export const DATA_ENDPOINT = "https://data.alpaca.markets";

export const TIMEZONE = "Europe/Rome";

/** Universo fisso: tutto il resto si rifiuta. */
export const UNIVERSE: readonly string[] = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "GLD", "TLT"];

export const CAGE = {
  maxPositions: 5,
  /** massimo 20% del conto per titolo */
  maxWeight: 0.2,
  /** stop loss a −3% dal prezzo di carico */
  stopLoss: -0.03,
} as const;

export type SlotName = "briefing" | "apertura" | "metà seduta" | "chiusura";

export interface SlotDef {
  /** HH:MM, ora di Roma */
  time: string;
  name: SlotName;
  /** come compare nei messaggi */
  label: string;
  /** false = nessun ordine ammesso (briefing) */
  canTrade: boolean;
  /** gira anche sabato e domenica */
  weekend: boolean;
}

/** Borsa USA 15:30–22:00 ora di Roma. */
export const SLOTS: readonly SlotDef[] = [
  { time: "09:00", name: "briefing", label: "briefing del mattino", canTrade: false, weekend: true },
  { time: "15:40", name: "apertura", label: "apertura", canTrade: true, weekend: false },
  { time: "18:30", name: "metà seduta", label: "metà seduta", canTrade: true, weekend: false },
  { time: "21:40", name: "chiusura", label: "chiusura", canTrade: true, weekend: false },
];

/** Apertura e chiusura della borsa USA in ora di Roma (minuti dalla mezzanotte). */
export const MARKET_OPEN_MIN = 15 * 60 + 30;
export const MARKET_CLOSE_MIN = 22 * 60;

/** Una sveglia più vecchia di così non si recupera: un ordine di ore fa non ha più senso. */
export const MAX_SLOT_LAG_MIN = 60;
/** Un lucchetto più vecchio di così è considerato di una sveglia morta, anche se il pid esiste. */
export const STALE_LOCK_MIN = 20;
/** Quanto indietro guardare gli ordini su Alpaca. */
export const RECENT_ORDERS_HOURS = 48;

export const BRAIN_TIMEOUT_MS = 240_000;
export const HTTP_TIMEOUT_MS = 10_000;
export const HTTP_ATTEMPTS = 3;
export const SCHEDULER_TICK_MS = 30_000;
