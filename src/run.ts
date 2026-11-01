// Il giro di una sveglia. L'ordine dei passi è quello del contratto:
// lucchetto → testimone → broker → cervello → gabbia → ordini con id deterministico → testimone nuovo → Telegram → via il lucchetto.

import { join } from "node:path";
import { applyCage } from "./cage.ts";
import { RECENT_ORDERS_HOURS } from "./config.ts";
import { fmtSignedUsd, fmtUsd, shorten } from "./fmt.ts";
import { Logger } from "./log.ts";
import type { Store } from "./state.ts";
import { fmtRome, fmtSlot, nextSlot, slotsBetween, type SlotInstance } from "./time.ts";
import {
  BrokerError,
  DuplicateOrderError,
  type Account,
  type Baton,
  type BatonOrder,
  type Brain,
  type BrainInput,
  type Broker,
  type BrokerOrder,
  type Decision,
  type LockInfo,
  type MarketClock,
  type Notifier,
  type Position,
  type RejectedOrder,
} from "./types.ts";

export interface RunDeps {
  broker: Broker;
  brain: Brain;
  notifier: Notifier;
  store: Store;
  now: () => Date;
  /** valori da mascherare (***) in log e messaggi */
  secrets?: string[];
  /** dove va l'eco del log (default: console) */
  echo?: (line: string) => void;
}

export interface RunOptions {
  /** rifà una sveglia già fatta: gli id degli ordini impediscono i doppioni */
  force?: boolean;
}

export type RunStatus = "ok" | "cervello non disponibile" | "errore" | "già fatta" | "occupata";

export interface RunResult {
  status: RunStatus;
  runId: string;
  orders: BatonOrder[];
  rejected: RejectedOrder[];
  baton?: Baton;
}

export interface ReconcileReport {
  runId: string;
  pid: number;
  startedAt: string;
  /** ordini di quella sveglia che risultano su Alpaca */
  found: BrokerOrder[];
  /** ordini che stava per inviare e su Alpaca non ci sono */
  notFound: string[];
}

/** Cosa hanno fatto davvero, su Alpaca, gli ordini di una sveglia morta a metà. */
export async function reconcileStale(broker: Broker, stale: LockInfo): Promise<ReconcileReport> {
  const recent = await broker.getRecentOrders(RECENT_ORDERS_HOURS);
  const found = recent.filter((o) => o.clientOrderId.startsWith(`${stale.runId}-`));
  const ids = new Set(found.map((o) => o.clientOrderId));
  return {
    runId: stale.runId,
    pid: stale.pid,
    startedAt: stale.startedAt,
    found,
    notFound: stale.intended.filter((id) => !ids.has(id)),
  };
}

export function describeReconcile(r: ReconcileReport): string {
  const when = r.startedAt ? ` (partita alle ${fmtRome(new Date(r.startedAt))})` : "";
  const done = r.found.length
    ? `Su Alpaca risultano ${r.found.length} ordini: ${r.found.map((o) => `${verb(o.side)} ${o.qty} ${o.symbol} [${o.status}]`).join(", ")}.`
    : "Su Alpaca non risulta nessun suo ordine.";
  const missing = r.notFound.length ? ` Non partiti: ${r.notFound.join(", ")}.` : "";
  return `La sveglia ${r.runId}${when} è morta a metà. ${done}${missing}`;
}

const verb = (side: string) => (side === "buy" ? "comprato" : "venduto");

export async function runWakeup(deps: RunDeps, slot: SlotInstance, opts: RunOptions = {}): Promise<RunResult> {
  const { broker, brain, notifier, store, now } = deps;
  const runId = slot.id;
  const log = new Logger(join(store.logsDir, `${runId}.log`), deps.secrets ?? [], deps.echo);
  const tag = `run ${runId}`;
  const say = async (text: string) => {
    try {
      await notifier.send(log.redact(text));
    } catch (e) {
      log.line("telegram", `messaggio non inviato: ${(e as Error).message}`);
    }
  };
  const alert = (text: string) => say(`⚠️ ${text}\n· ${tag}`);
  const empty = (status: RunStatus): RunResult => ({ status, runId, orders: [], rejected: [] });

  // 1. Il lucchetto: una sveglia alla volta. Se ne trova uno di una sveglia morta, lo porta via (atomico) e lo riconcilia.
  const lock = store.acquireLock({ runId });
  if (!lock.acquired) {
    const h = lock.heldBy;
    log.line("sveglia", `${runId} · un'altra sveglia è in corso${h ? ` (${h.runId}, pid ${h.pid})` : ""}: non parto`);
    return empty("occupata");
  }

  try {
    // Una sveglia già conclusa non riparte (a meno di --force).
    const { baton: prev, corrupted } = store.readBaton();
    if (prev && !opts.force && Date.parse(prev.slotAt) >= slot.at.getTime()) {
      log.line("sveglia", `${runId} · già fatta (testimone di ${prev.runId}): non riparto. Con --force la rifai, gli id impediscono i doppioni`);
      return empty("già fatta");
    }

    log.line("sveglia", `${runId} · ${slot.def.name} · cervello: ${brain.name}`);
    await say(`▶️ Sveglia ${fmtSlot(slot)} · ${slot.def.name}\n· ${tag}`);

    const notes: string[] = [];
    if (corrupted) {
      notes.push("Il testimone era illeggibile: lo ignoro e riparto dalla verità del broker.");
      await alert(notes.at(-1)!);
    }

    // Sveglie saltate (macchina spenta o offline): si dicono, non si recuperano.
    if (prev) {
      const skipped = slotsBetween(new Date(prev.slotAt), slot.at);
      if (skipped.length) {
        const list = skipped.slice(0, 8).map(fmtSlot).join(", ") + (skipped.length > 8 ? ` … (altre ${skipped.length - 8})` : "");
        notes.push(`Sveglie saltate dall'ultimo testimone (${prev.runId}): ${list}. Non le recupero.`);
        await alert(`Sveglie saltate (macchina spenta o offline?): ${list}. Non le recupero: un ordine di ore fa non ha più senso.`);
      }
    }

    // Sveglie morte a metà: cosa hanno fatto davvero?
    for (const dead of lock.stale) {
      let text: string;
      if (dead.runId === "sconosciuta") {
        text = "Ho trovato un lucchetto illeggibile di una sveglia morta: non so quali ordini siano partiti, guardo gli ordini recenti su Alpaca.";
      } else {
        try {
          text = describeReconcile(await reconcileStale(broker, dead));
        } catch (e) {
          text = `La sveglia ${dead.runId} è morta a metà e non sono riuscito a riconciliarla con Alpaca (${(e as Error).message}).`;
        }
      }
      log.line("riconcilia", text);
      notes.push(text);
      await alert(text);
    }

    // 2. La verità sui soldi: Alpaca.
    let account: Account, positions: Position[], recentOrders: BrokerOrder[], clock: MarketClock;
    try {
      [account, positions, recentOrders, clock] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        broker.getRecentOrders(RECENT_ORDERS_HOURS),
        broker.getClock(),
      ]);
    } catch (e) {
      return await failRun(e as Error);
    }
    log.line(
      "broker",
      `equity ${fmtUsd(account.equity)} · ${positions.length} posizioni · ${recentOrders.length} ordini ${RECENT_ORDERS_HOURS}h · mercato ${clock.isOpen ? "aperto" : "chiuso"}`,
    );

    // 3. Il cervello propone.
    const input: BrainInput = {
      slot: { id: runId, time: slot.time, name: slot.def.name, label: slot.def.label, canTrade: slot.def.canTrade, at: slot.at.toISOString() },
      now: now().toISOString(),
      baton: prev,
      account,
      positions,
      recentOrders,
      marketOpen: clock.isOpen,
      notes,
    };
    let decision: Decision | null = null;
    let brainFailure: string | null = null;
    try {
      decision = await brain.decide(input);
      log.line("cervello", `${decision.orders.length} ordini proposti · ${shorten(decision.reasoning, 90)}`);
    } catch (e) {
      brainFailure = (e as Error).message;
      log.line("cervello", `non disponibile: ${brainFailure}`);
      await alert(`Cervello non disponibile: applico solo lo stop loss. Causa: ${brainFailure}`);
    }

    // 4. La gabbia dispone.
    let prices: Record<string, number> = {};
    const held = new Set(positions.map((p) => p.symbol));
    const need = [...new Set((decision?.orders ?? []).filter((o) => o.side === "buy").map((o) => String(o.symbol).trim().toUpperCase()))].filter((s) => !held.has(s));
    if (need.length && slot.def.canTrade && clock.isOpen) {
      try {
        prices = await broker.getPrices(need);
      } catch (e) {
        log.line("broker", `prezzi non disponibili: ${(e as Error).message}`);
      }
    }
    const planned = applyCage({
      decision,
      slotId: runId,
      canTrade: slot.def.canTrade,
      marketOpen: clock.isOpen,
      account,
      positions,
      prices,
    });
    const rejected = [...planned.rejected];
    log.line(
      "gabbia",
      [...planned.orders.map((o) => `ok ${o.side} ${o.qty} ${o.symbol}${o.forced ? " (stop)" : ""}`), ...rejected.map((r) => `NO ${r.side} ${r.qty} ${r.symbol}: ${r.reason}`)].join(" · ") || "nessun ordine",
    );

    // 5. Gli ordini, uno a uno, ognuno con il suo id.
    store.setIntended(planned.orders.map((o) => o.id));
    const results: BatonOrder[] = [];
    for (const o of planned.orders) {
      const base = { id: o.id, symbol: o.symbol, side: o.side, qty: o.qty, why: o.why, forced: o.forced };

      // Il mercato si ricontrolla prima di ogni invio, non solo all'inizio: un cervello lento può sforare la chiusura.
      let open: boolean;
      try {
        open = (await broker.getClock()).isOpen;
      } catch (e) {
        results.push({ ...base, status: "non partito", detail: `impossibile verificare il mercato: ${(e as Error).message}` });
        log.line("ordine", `${o.id} non inviato: impossibile verificare se il mercato è aperto`);
        continue;
      }
      if (!open) {
        rejected.push({ symbol: o.symbol, side: o.side, qty: o.qty, reason: "mercato chiuso al momento dell'invio" });
        log.line("ordine", `${o.id} non inviato: mercato chiuso al momento dell'invio`);
        continue;
      }

      // Se Alpaca ha già un ordine con questo id, non si rimanda.
      let existing: BrokerOrder | null = null;
      try {
        existing = await broker.getOrderByClientId(o.id);
      } catch {
        /* se il controllo non risponde, ci pensa l'unicità dell'id lato broker */
      }
      if (existing) {
        results.push({ ...base, status: "già presente", detail: existing.status });
        log.line("ordine", `${o.id} già presente su Alpaca (${existing.status}): non rimando`);
        continue;
      }

      try {
        const sent = await broker.submitOrder({ symbol: o.symbol, side: o.side, qty: o.qty, clientOrderId: o.id });
        results.push({ ...base, status: "inviato", detail: sent.status });
        log.line("ordine", `inviato ${o.id} · ${o.qty} az. · ${sent.status}`);
      } catch (e) {
        if (e instanceof DuplicateOrderError) {
          results.push({ ...base, status: "già presente" });
          log.line("ordine", `${o.id} rifiutato come doppione dal broker: era già partito`);
        } else if (e instanceof BrokerError && !e.retriable) {
          results.push({ ...base, status: "rifiutato dal broker", detail: e.message });
          log.line("ordine", `${o.id} rifiutato dal broker: ${e.message}`);
        } else {
          // Errore di rete: l'ordine può essere arrivato lo stesso. Si ricontrolla per id.
          log.line("ordine", `${o.id} errore di rete (${(e as Error).message}): ricontrollo per id`);
          try {
            const again = await broker.getOrderByClientId(o.id);
            if (again) {
              results.push({ ...base, status: "inviato", detail: `${again.status} (risposta persa, confermato dal broker)` });
              log.line("ordine", `${o.id} risulta arrivato: ${again.status}`);
            } else {
              results.push({ ...base, status: "non partito", detail: (e as Error).message });
              log.line("ordine", `${o.id} non risulta su Alpaca: non è partito`);
            }
          } catch (e2) {
            results.push({ ...base, status: "esito sconosciuto", detail: (e2 as Error).message });
            log.line("ordine", `${o.id} esito sconosciuto: ${(e2 as Error).message}`);
            await alert(`Esito sconosciuto per l'ordine ${o.id} (${verb(o.side)} ${o.qty} ${o.symbol}): controlla su Alpaca prima di fidarti del conto.`);
          }
        }
      }
    }

    // 6. Il conto dopo gli ordini (se Alpaca non risponde, vale quello di prima).
    let accountAfter = account;
    let positionsAfter = positions;
    if (results.some((r) => r.status === "inviato")) {
      try {
        [accountAfter, positionsAfter] = await Promise.all([broker.getAccount(), broker.getPositions()]);
      } catch {
        /* resta lo stato di prima */
      }
    }

    // 7. Il testimone nuovo, in modo atomico.
    const outcome = brainFailure ? "cervello non disponibile" : "ok";
    const next = nextSlot(now());
    const summary = decision
      ? decision.reasoning
      : `Cervello non disponibile: ho applicato solo lo stop loss (${results.filter((r) => r.forced).length} vendite forzate).`;
    const planNext = decision
      ? decision.planNext
      : `Il cervello non era disponibile alla sveglia ${runId}. ${prev?.planNext ?? "Ricontrollare conto e stop."}`;
    const baton: Baton = {
      version: 1,
      runId,
      slot: slot.time,
      slotName: slot.def.name,
      slotAt: slot.at.toISOString(),
      finishedAt: now().toISOString(),
      outcome,
      summary,
      planNext,
      orders: results,
      rejected,
      notes,
      account: accountAfter,
      positions: positionsAfter,
    };
    try {
      store.writeBaton(baton);
      log.line("testimone", `scritto · prossima sveglia ${fmtSlot(next)}`);
    } catch (e) {
      log.line("testimone", `NON scritto: ${(e as Error).message}`);
      await alert(`Non sono riuscito a scrivere il testimone: ${(e as Error).message}`);
    }

    // 8. Il resoconto su Telegram. Poi (nel finally) via il lucchetto.
    await say(finalMessage());
    return { status: outcome, runId, orders: results, rejected, baton };

    function finalMessage(): string {
      const lines = [`✅ Fatto · ${slot.def.label}`];
      lines.push(`Ordini: ${results.length ? results.map(orderLine).join("; ") : "nessuno"}`);
      if (rejected.length) lines.push(`Rifiutati dalla gabbia: ${rejected.map((r) => `${r.symbol} (${r.reason})`).join("; ")}`);
      lines.push(`Perché: ${shorten(summary, 700)}`);
      lines.push(`Prossima mossa: ${shorten(planNext, 400)}`);
      lines.push(`P&L giorno: ${fmtSignedUsd(accountAfter.equity - accountAfter.lastEquity)} · conto ${fmtUsd(accountAfter.equity)}`);
      lines.push(`Prossima sveglia: ${fmtSlot(next)}`);
      lines.push(`· ${tag}`);
      return lines.join("\n");
    }

    function orderLine(o: BatonOrder): string {
      const what = `${o.qty} ${o.symbol}`;
      switch (o.status) {
        case "inviato":
          return `${verb(o.side)} ${what} (${o.why})`;
        case "già presente":
          return `${what}: già presente su Alpaca, non rimandato`;
        case "non partito":
          return `${o.side === "buy" ? "acquisto" : "vendita"} ${what}: NON partito${o.detail ? ` (${shorten(o.detail, 80)})` : ""}`;
        case "esito sconosciuto":
          return `${o.side === "buy" ? "acquisto" : "vendita"} ${what}: ESITO SCONOSCIUTO, controlla su Alpaca`;
        case "rifiutato dal broker":
          return `${what}: rifiutato dal broker${o.detail ? ` (${shorten(o.detail, 80)})` : ""}`;
      }
    }

    /** Il broker non risponde (dopo i tentativi): la sveglia fallisce pulita, con testimone di errore e avviso. */
    async function failRun(e: Error): Promise<RunResult> {
      log.line("broker", `errore: ${e.message}`);
      const baton: Baton = {
        version: 1,
        runId,
        slot: slot.time,
        slotName: slot.def.name,
        slotAt: slot.at.toISOString(),
        finishedAt: now().toISOString(),
        outcome: "errore",
        summary: `Sveglia fallita: ${e.message}. Nessun ordine inviato.`,
        planNext: prev?.planNext ?? "Riprovare alla prossima sveglia.",
        orders: [],
        rejected: [],
        notes,
        account: prev?.account ?? { equity: 0, lastEquity: 0, cash: 0 },
        positions: prev?.positions ?? [],
      };
      try {
        store.writeBaton(baton);
      } catch (e2) {
        log.line("testimone", `NON scritto: ${(e2 as Error).message}`);
      }
      await say(`❌ Sveglia fallita · ${slot.def.label}\nCausa: ${shorten(e.message, 300)}\nNessun ordine inviato.\n· ${tag}`);
      return { status: "errore", runId, orders: [], rejected: [], baton };
    }
  } finally {
    store.releaseLock();
  }
}
