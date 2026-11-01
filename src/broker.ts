import { DATA_ENDPOINT, HTTP_ATTEMPTS, HTTP_TIMEOUT_MS, PAPER_ENDPOINT } from "./config.ts";
import {
  BrokerError,
  DuplicateOrderError,
  type Account,
  type Broker,
  type BrokerOrder,
  type MarketClock,
  type Position,
  type SubmitRequest,
} from "./types.ts";

/** Se qualcuno configura un endpoint diverso da quello paper, il programma non parte. */
export function assertPaperEndpoint(configured: string | undefined): void {
  if (!configured) return;
  if (configured.replace(/\/+$/, "") !== PAPER_ENDPOINT) {
    throw new Error(
      `Endpoint Alpaca "${configured}" rifiutato: questo programma parla solo con ${PAPER_ENDPOINT}. ` +
        `Non è configurabile, e non va cambiato.`,
    );
  }
}

export interface AlpacaOptions {
  /** per i test: sostituisce fetch */
  fetch?: typeof fetch;
  attempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
}

const num = (v: unknown): number => Number(v);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AlpacaBroker implements Broker {
  readonly name = "alpaca-paper";
  private f: typeof fetch;
  private attempts: number;
  private backoffMs: number;
  private timeoutMs: number;

  constructor(
    private keys: { keyId: string; secret: string },
    opts: AlpacaOptions = {},
  ) {
    if (!keys.keyId || !keys.secret) throw new Error("Chiavi Alpaca mancanti (secrets.ts: ALPACA_KEY_ID, ALPACA_SECRET_KEY)");
    this.f = opts.fetch ?? fetch;
    this.attempts = opts.attempts ?? HTTP_ATTEMPTS;
    this.backoffMs = opts.backoffMs ?? 1000;
    this.timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  }

  /** GET con tentativi su rete / 5xx / 429. 404 → null. Le chiavi non finiscono mai nei messaggi d'errore. */
  private async get(base: string, path: string, query: Record<string, string> = {}): Promise<unknown | null> {
    const url = `${base}${path}?${new URLSearchParams(query)}`;
    let last: BrokerError | undefined;
    for (let i = 1; i <= this.attempts; i++) {
      try {
        const res = await this.f(url, { headers: this.headers(), signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.status === 404) return null;
        if (res.status === 429 || res.status >= 500) {
          last = new BrokerError(`Alpaca ${path}: HTTP ${res.status}`, true, res.status);
        } else if (!res.ok) {
          throw new BrokerError(`Alpaca ${path}: HTTP ${res.status} ${await safeText(res)}`, false, res.status);
        } else {
          return await res.json();
        }
      } catch (e) {
        if (e instanceof BrokerError && !e.retriable) throw e;
        last = e instanceof BrokerError ? e : new BrokerError(`Alpaca ${path}: ${(e as Error).message}`, true);
      }
      if (i < this.attempts) await sleep(this.backoffMs * i);
    }
    throw last!;
  }

  private headers() {
    return {
      "APCA-API-KEY-ID": this.keys.keyId,
      "APCA-API-SECRET-KEY": this.keys.secret,
      accept: "application/json",
    };
  }

  async getAccount(): Promise<Account> {
    const a = (await this.get(PAPER_ENDPOINT, "/v2/account")) as Record<string, string> | null;
    if (!a) throw new BrokerError("Alpaca /v2/account: non trovato", false, 404);
    return { equity: num(a.equity), lastEquity: num(a.last_equity), cash: num(a.cash) };
  }

  async getPositions(): Promise<Position[]> {
    const list = ((await this.get(PAPER_ENDPOINT, "/v2/positions")) ?? []) as Record<string, string>[];
    return list.map((p) => ({
      symbol: p.symbol!,
      qty: num(p.qty),
      avgEntry: num(p.avg_entry_price),
      price: num(p.current_price),
    }));
  }

  async getRecentOrders(hours: number): Promise<BrokerOrder[]> {
    const after = new Date(Date.now() - hours * 3_600_000).toISOString();
    const list = ((await this.get(PAPER_ENDPOINT, "/v2/orders", {
      status: "all",
      limit: "500",
      direction: "desc",
      after,
    })) ?? []) as Record<string, unknown>[];
    return list.map(toOrder);
  }

  async getClock(): Promise<MarketClock> {
    const c = (await this.get(PAPER_ENDPOINT, "/v2/clock")) as { is_open: boolean; timestamp: string } | null;
    if (!c) throw new BrokerError("Alpaca /v2/clock: non trovato", false, 404);
    return { isOpen: c.is_open, timestamp: c.timestamp };
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    if (symbols.length === 0) return {};
    const r = (await this.get(DATA_ENDPOINT, "/v2/stocks/trades/latest", {
      symbols: symbols.join(","),
      feed: "iex",
    })) as { trades?: Record<string, { p: number }> } | null;
    const out: Record<string, number> = {};
    for (const [sym, t] of Object.entries(r?.trades ?? {})) out[sym] = num(t.p);
    return out;
  }

  /** Nessun tentativo automatico: un POST con risposta persa si ricontrolla per id (vedi run.ts). */
  async submitOrder(req: SubmitRequest): Promise<BrokerOrder> {
    let res: Response;
    try {
      res = await this.f(`${PAPER_ENDPOINT}/v2/orders`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          symbol: req.symbol,
          qty: String(req.qty),
          side: req.side,
          type: "market",
          time_in_force: "day",
          client_order_id: req.clientOrderId,
        }),
      });
    } catch (e) {
      throw new BrokerError(`Alpaca POST /v2/orders: ${(e as Error).message}`, true);
    }
    if (res.ok) return toOrder((await res.json()) as Record<string, unknown>);
    const text = await safeText(res);
    if (res.status === 422 && /client_order_id/i.test(text) && /unique/i.test(text)) {
      throw new DuplicateOrderError(req.clientOrderId);
    }
    throw new BrokerError(`Alpaca POST /v2/orders: HTTP ${res.status} ${text}`, res.status >= 500 || res.status === 429, res.status);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    const o = (await this.get(PAPER_ENDPOINT, "/v2/orders:by_client_order_id", {
      client_order_id: clientOrderId,
    })) as Record<string, unknown> | null;
    return o ? toOrder(o) : null;
  }
}

function toOrder(o: Record<string, unknown>): BrokerOrder {
  return {
    id: String(o.id),
    clientOrderId: String(o.client_order_id),
    symbol: String(o.symbol),
    side: o.side === "sell" ? "sell" : "buy",
    qty: num(o.qty),
    status: String(o.status),
    filledQty: num(o.filled_qty ?? 0),
    filledAvgPrice: o.filled_avg_price == null ? null : num(o.filled_avg_price),
    submittedAt: String(o.submitted_at ?? o.created_at ?? ""),
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
