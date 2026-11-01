// Broker finto (persistito su file) e cervello finto. Servono per provare tutto senza soldi e senza rete.
// Il broker finto ha la stessa interfaccia di quello vero e in più i guasti che i test devono saper provocare.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { decisionFromText } from "./llm.ts";
import { isMarketHoursRome, romeParts } from "./time.ts";
import {
  BrokerError,
  DuplicateOrderError,
  type Account,
  type Brain,
  type BrainInput,
  type Broker,
  type BrokerOrder,
  type Decision,
  type MarketClock,
  type Position,
  type SubmitRequest,
} from "./types.ts";

export const DEFAULT_PRICES: Record<string, number> = {
  SPY: 520,
  QQQ: 450,
  IWM: 220,
  AAPL: 230,
  MSFT: 420,
  NVDA: 140,
  GLD: 240,
  TLT: 95,
};

interface FakeState {
  cash: number;
  /** equity a inizio giornata di Roma, per il P&L del giorno */
  dayStart: { date: string; equity: number };
  positions: Record<string, { qty: number; avgEntry: number }>;
  orders: BrokerOrder[];
  prices: Record<string, number>;
  seq: number;
}

export interface FakeFaults {
  /** ogni chiamata fallisce come se Alpaca non rispondesse */
  down?: boolean;
  /** l'ordine arriva e viene eseguito, ma la risposta si perde (timeout) */
  loseResponseOnSubmit?: boolean;
  /** anche il controllo per id fallisce (esito davvero sconosciuto) */
  failLookup?: boolean;
  /** dopo N ordini accettati il processo si uccide con SIGKILL */
  killAfterOrders?: number;
  /** forza il mercato aperto/chiuso a prescindere dall'orologio */
  marketOpen?: boolean;
}

export class FakeBroker implements Broker {
  readonly name = "broker finto";
  faults: FakeFaults;

  constructor(
    private file: string,
    private now: () => Date = () => new Date(),
    faults: FakeFaults = {},
    startingCash = 100_000,
  ) {
    const envKill = process.env.TRADER_FAKE_KILL_AFTER_ORDERS;
    this.faults = { ...faults, ...(envKill ? { killAfterOrders: Number(envKill) } : {}) };
    if (!existsSync(file)) {
      this.save({
        cash: startingCash,
        dayStart: { date: "", equity: startingCash },
        positions: {},
        orders: [],
        prices: { ...DEFAULT_PRICES },
        seq: 0,
      });
    }
  }

  private load(): FakeState {
    return JSON.parse(readFileSync(this.file, "utf8")) as FakeState;
  }

  private save(s: FakeState): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.file);
  }

  private check(): void {
    if (this.faults.down) throw new BrokerError("broker finto: non risponde", true);
  }

  private equityOf(s: FakeState): number {
    let eq = s.cash;
    for (const [sym, p] of Object.entries(s.positions)) eq += p.qty * (s.prices[sym] ?? p.avgEntry);
    return eq;
  }

  /** Per i test: muove il prezzo di un titolo. */
  setPrice(symbol: string, price: number): void {
    const s = this.load();
    s.prices[symbol] = price;
    this.save(s);
  }

  /** Per i test: mette una posizione già esistente (prezzo di carico e prezzo attuale). */
  seedPosition(symbol: string, qty: number, avgEntry: number, price: number): void {
    const s = this.load();
    s.positions[symbol] = { qty, avgEntry };
    s.prices[symbol] = price;
    s.cash -= qty * avgEntry;
    this.save(s);
  }

  /** Per i test: tutti gli ordini registrati, senza passare dai guasti. */
  allOrders(): BrokerOrder[] {
    return this.load().orders;
  }

  async getAccount(): Promise<Account> {
    this.check();
    const s = this.load();
    const p = romeParts(this.now());
    const date = `${p.y}-${p.mo}-${p.d}`;
    const equity = this.equityOf(s);
    if (s.dayStart.date !== date) {
      s.dayStart = { date, equity };
      this.save(s);
    }
    return { equity, lastEquity: s.dayStart.equity, cash: s.cash };
  }

  async getPositions(): Promise<Position[]> {
    this.check();
    const s = this.load();
    return Object.entries(s.positions)
      .filter(([, p]) => p.qty > 0)
      .map(([symbol, p]) => ({ symbol, qty: p.qty, avgEntry: p.avgEntry, price: s.prices[symbol] ?? p.avgEntry }));
  }

  async getRecentOrders(hours: number): Promise<BrokerOrder[]> {
    this.check();
    const since = this.now().getTime() - hours * 3_600_000;
    return this.load()
      .orders.filter((o) => Date.parse(o.submittedAt) >= since)
      .reverse();
  }

  async getClock(): Promise<MarketClock> {
    this.check();
    const now = this.now();
    return { isOpen: this.faults.marketOpen ?? isMarketHoursRome(now), timestamp: now.toISOString() };
  }

  async getPrices(symbols: string[]): Promise<Record<string, number>> {
    this.check();
    const s = this.load();
    return Object.fromEntries(symbols.filter((x) => x in s.prices).map((x) => [x, s.prices[x]!]));
  }

  async submitOrder(req: SubmitRequest): Promise<BrokerOrder> {
    this.check();
    const s = this.load();
    if (s.orders.some((o) => o.clientOrderId === req.clientOrderId)) throw new DuplicateOrderError(req.clientOrderId);
    const price = s.prices[req.symbol];
    if (price == null) throw new BrokerError(`broker finto: simbolo sconosciuto ${req.symbol}`, false, 422);
    const held = s.positions[req.symbol] ?? { qty: 0, avgEntry: 0 };
    if (req.side === "buy") {
      if (req.qty * price > s.cash) throw new BrokerError("broker finto: liquidità insufficiente", false, 403);
      const total = held.qty + req.qty;
      held.avgEntry = (held.avgEntry * held.qty + price * req.qty) / total;
      held.qty = total;
      s.cash -= req.qty * price;
    } else {
      if (req.qty > held.qty) throw new BrokerError("broker finto: vendita allo scoperto non ammessa", false, 403);
      held.qty -= req.qty;
      s.cash += req.qty * price;
    }
    s.positions[req.symbol] = held;
    s.seq += 1;
    const order: BrokerOrder = {
      id: `fake-${s.seq}`,
      clientOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      qty: req.qty,
      status: "filled",
      filledQty: req.qty,
      filledAvgPrice: price,
      submittedAt: this.now().toISOString(),
    };
    s.orders.push(order);
    this.save(s);
    if (this.faults.killAfterOrders != null && s.orders.length >= this.faults.killAfterOrders) {
      process.kill(process.pid, "SIGKILL");
    }
    if (this.faults.loseResponseOnSubmit) throw new BrokerError("broker finto: timeout (la risposta si è persa)", true);
    return order;
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    this.check();
    if (this.faults.failLookup) throw new BrokerError("broker finto: controllo per id non risponde", true);
    return this.load().orders.find((o) => o.clientOrderId === clientOrderId) ?? null;
  }
}

export interface FakeBrainOptions {
  /** una decisione fissa */
  decision?: Decision;
  /** oppure una funzione */
  respond?: (input: BrainInput) => Decision | Promise<Decision>;
  /** oppure il testo grezzo che avrebbe risposto il modello (passa dalla stessa validazione del cervello vero) */
  raw?: string;
  /** chiamata a ogni decisione: i test la usano per far avanzare l'orologio */
  onDecide?: (input: BrainInput) => void;
}

export const DEFAULT_FAKE_DECISION: Decision = {
  orders: [
    { symbol: "SPY", side: "buy", qty: 20, why: "indice largo, base del portafoglio" },
    { symbol: "QQQ", side: "buy", qty: 10, why: "tecnologia" },
    { symbol: "GLD", side: "buy", qty: 25, why: "oro, copertura" },
  ],
  reasoning: "Prova con broker e cervello finti: eseguo il piano.",
  planNext: "Alla prossima sveglia controllare solo la distanza dallo stop.",
};

/** Risponde sempre la stessa cosa (o quello che gli dici di rispondere). */
export class FakeBrain implements Brain {
  readonly name = "finto (prova, nessuna chiamata)";
  calls = 0;
  constructor(private opts: FakeBrainOptions = {}) {}

  async decide(input: BrainInput): Promise<Decision> {
    this.calls += 1;
    this.opts.onDecide?.(input);
    if (this.opts.raw != null) return decisionFromText(this.opts.raw);
    if (this.opts.respond) return this.opts.respond(input);
    return this.opts.decision ?? DEFAULT_FAKE_DECISION;
  }
}
