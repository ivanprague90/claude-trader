// La gabbia. Il modello propone, il codice dispone.
// Funzione pura: nessuna rete, nessun file. Le regole stanno in config.ts e valgono anche se il modello non risponde.

import { CAGE, UNIVERSE } from "./config.ts";
import { fmtPct } from "./fmt.ts";
import type { Account, Decision, Position, RejectedOrder, Side } from "./types.ts";

export interface PlannedOrder {
  /** id deterministico: AAAA-MM-GG-HHMM-SIMBOLO-lato */
  id: string;
  symbol: string;
  side: Side;
  qty: number;
  why: string;
  /** true = stop loss: lo vuole il codice, non il modello */
  forced: boolean;
}

export interface CageInput {
  /** null = il cervello non ha risposto: lavora solo lo stop loss */
  decision: Decision | null;
  /** id della sveglia, es. 2026-10-05-1540 */
  slotId: string;
  /** false nel briefing */
  canTrade: boolean;
  marketOpen: boolean;
  account: Account;
  positions: Position[];
  /** prezzi dei titoli non in portafoglio */
  prices: Record<string, number>;
}

export interface CageOutput {
  orders: PlannedOrder[];
  rejected: RejectedOrder[];
}

export const orderId = (slotId: string, symbol: string, side: Side): string => `${slotId}-${symbol}-${side}`;

export function applyCage(input: CageInput): CageOutput {
  const { decision, slotId, account, positions, prices } = input;
  const proposed = decision?.orders ?? [];
  const orders: PlannedOrder[] = [];
  const rejected: RejectedOrder[] = [];

  const rejectAll = (reason: string) => {
    for (const o of proposed) rejected.push({ symbol: o.symbol, side: o.side, qty: o.qty, reason });
    return { orders, rejected };
  };
  if (!input.canTrade) return rejectAll("nessun ordine nel briefing");
  if (!input.marketOpen) return rejectAll("mercato chiuso");

  const held = new Map<string, number>(positions.map((p) => [p.symbol, p.qty]));
  const priceOf = (sym: string): number | undefined => positions.find((p) => p.symbol === sym)?.price ?? prices[sym];

  // 1. Stop loss: vende anche se il modello non lo chiede.
  const stopped = new Set<string>();
  for (const p of positions) {
    if (p.qty <= 0 || p.avgEntry <= 0) continue;
    const ret = p.price / p.avgEntry - 1;
    if (ret <= CAGE.stopLoss + 1e-9) {
      stopped.add(p.symbol);
      held.set(p.symbol, 0);
      orders.push({
        id: orderId(slotId, p.symbol, "sell"),
        symbol: p.symbol,
        side: "sell",
        qty: p.qty,
        why: `stop loss: ${fmtPct(ret)} dal carico`,
        forced: true,
      });
    }
  }

  // 2. Gli ordini del modello: prima le vendite, poi gli acquisti.
  // Prudenza: il ricavato delle vendite di questa sveglia non conta come liquidità, e uno slot liberato non si riusa.
  const symbolsHeldAtStart = new Set(positions.filter((p) => p.qty > 0).map((p) => p.symbol));
  const opened = new Set<string>();
  const seen = new Set<string>(orders.map((o) => o.id));
  let cash = account.cash;
  const sorted = [...proposed].sort((a, b) => Number(b.side === "sell") - Number(a.side === "sell"));

  for (const o of sorted) {
    const symbol = String(o.symbol).trim().toUpperCase();
    const reject = (reason: string) => rejected.push({ symbol: o.symbol, side: o.side, qty: o.qty, reason });

    if (!UNIVERSE.includes(symbol)) {
      reject(`fuori universo (ammessi: ${UNIVERSE.join(", ")})`);
      continue;
    }
    if (o.side !== "buy" && o.side !== "sell") {
      reject(`lato non valido "${o.side}"`);
      continue;
    }
    if (!Number.isInteger(o.qty) || o.qty <= 0) {
      reject("quantità non valida: solo azioni intere, maggiori di zero");
      continue;
    }
    if (stopped.has(symbol)) {
      reject("posizione già chiusa dallo stop loss in questa sveglia");
      continue;
    }
    const id = orderId(slotId, symbol, o.side);
    if (seen.has(id)) {
      reject("duplicato: stesso titolo e stesso lato nella stessa sveglia");
      continue;
    }

    if (o.side === "sell") {
      const have = held.get(symbol) ?? 0;
      if (o.qty > have) {
        reject(`vendita oltre le azioni possedute (${have}): niente short`);
        continue;
      }
      held.set(symbol, have - o.qty);
    } else {
      const price = priceOf(symbol);
      if (price == null || !(price > 0)) {
        reject("prezzo non disponibile");
        continue;
      }
      const have = held.get(symbol) ?? 0;
      const slots = new Set([...symbolsHeldAtStart, ...opened]);
      if (!slots.has(symbol) && slots.size >= CAGE.maxPositions) {
        reject(`già ${CAGE.maxPositions} titoli in portafoglio`);
        continue;
      }
      const weight = ((have + o.qty) * price) / account.equity;
      if (weight > CAGE.maxWeight + 1e-9) {
        reject(`oltre il ${CAGE.maxWeight * 100}% del conto per titolo: ${have + o.qty} azioni sarebbero il ${fmtPct(weight)}`);
        continue;
      }
      if (o.qty * price > cash) {
        reject("liquidità insufficiente: niente leva");
        continue;
      }
      cash -= o.qty * price;
      held.set(symbol, have + o.qty);
      opened.add(symbol);
    }
    seen.add(id);
    orders.push({ id, symbol, side: o.side, qty: o.qty, why: o.why, forced: false });
  }

  return { orders, rejected };
}
