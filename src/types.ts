import type { SlotInstance } from "./time.ts";

export type Side = "buy" | "sell";

/** Un ordine come lo propone il cervello: ancora da validare dalla gabbia. */
export interface ProposedOrder {
  symbol: string;
  side: string;
  qty: number;
  /** perché, in una frase */
  why: string;
}

export interface Decision {
  orders: ProposedOrder[];
  /** 3–5 frasi, in italiano */
  reasoning: string;
  /** cosa controllare alla prossima sveglia */
  planNext: string;
}

export interface Account {
  equity: number;
  /** equity alla chiusura precedente: serve per il P&L del giorno */
  lastEquity: number;
  cash: number;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntry: number;
  price: number;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  qty: number;
  status: string;
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
}

export interface MarketClock {
  isOpen: boolean;
  timestamp: string;
}

export interface SubmitRequest {
  symbol: string;
  side: Side;
  qty: number;
  /** id deterministico: AAAA-MM-GG-HHMM-SIMBOLO-lato */
  clientOrderId: string;
}

export interface Broker {
  readonly name: string;
  getAccount(): Promise<Account>;
  getPositions(): Promise<Position[]>;
  getRecentOrders(hours: number): Promise<BrokerOrder[]>;
  getClock(): Promise<MarketClock>;
  getPrices(symbols: string[]): Promise<Record<string, number>>;
  /** Lancia DuplicateOrderError se l'id esiste già. */
  submitOrder(req: SubmitRequest): Promise<BrokerOrder>;
  /** null se l'ordine non esiste. */
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
}

export class DuplicateOrderError extends Error {
  constructor(public clientOrderId: string) {
    super(`ordine con id ${clientOrderId} già presente sul broker`);
    this.name = "DuplicateOrderError";
  }
}

export class BrokerError extends Error {
  constructor(
    message: string,
    /** true = rete / 5xx / 429: ha senso riprovare */
    public retriable: boolean,
    public status?: number,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export interface BrainInput {
  slot: { id: string; time: string; name: string; label: string; canTrade: boolean; at: string };
  now: string;
  /** il testimone della sveglia prima, o null */
  baton: Baton | null;
  account: Account;
  positions: Position[];
  recentOrders: BrokerOrder[];
  marketOpen: boolean;
  /** avvisi dalla sveglia: sveglie saltate, riconciliazioni, testimone illeggibile */
  notes: string[];
}

export interface Brain {
  readonly name: string;
  decide(input: BrainInput): Promise<Decision>;
}

export class BrainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainError";
  }
}

export interface Notifier {
  /** Non lancia mai: se Telegram non risponde, lo scrive nel log. */
  send(text: string): Promise<boolean>;
}

export type OrderStatus = "inviato" | "già presente" | "non partito" | "esito sconosciuto" | "rifiutato dal broker";

export interface BatonOrder {
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  status: OrderStatus;
  forced: boolean;
  /** dettaglio per gli esiti diversi da "inviato" (motivo del rifiuto, errore di rete…) */
  detail?: string;
}

export interface RejectedOrder {
  symbol: string;
  side: string;
  qty: number;
  reason: string;
}

/** Il testimone: la verità sulle intenzioni della sveglia prima. In italiano semplice. */
export interface Baton {
  version: 1;
  runId: string;
  slot: string;
  slotName: string;
  slotAt: string;
  finishedAt: string;
  outcome: "ok" | "cervello non disponibile" | "errore";
  /** perché ha fatto quello che ha fatto */
  summary: string;
  /** cosa controllare alla prossima sveglia */
  planNext: string;
  orders: BatonOrder[];
  rejected: RejectedOrder[];
  notes: string[];
  account: Account;
  positions: Position[];
}

export interface LockInfo {
  runId: string;
  pid: number;
  host: string;
  startedAt: string;
  /** id degli ordini che la sveglia stava per inviare */
  intended: string[];
}

export type { SlotInstance };
