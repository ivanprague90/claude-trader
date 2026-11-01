import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeBrain, FakeBroker, type FakeFaults } from "../src/fake.ts";
import type { Decision } from "../src/types.ts";
import { ConsoleNotifier } from "../src/notify.ts";
import type { RunDeps } from "../src/run.ts";
import { Store } from "../src/state.ts";
import { slotForArg } from "../src/time.ts";

/** Lunedì 5 ottobre 2026 (ora legale, Roma = UTC+2). */
export const T = {
  briefing: "2026-10-05T07:00:30Z", // 09:00:30 Roma
  apertura: "2026-10-05T13:40:30Z", // 15:40:30
  metaSeduta: "2026-10-05T16:30:30Z", // 18:30:30
  chiusura: "2026-10-05T19:40:30Z", // 21:40:30
  dopoChiusura: "2026-10-05T20:05:00Z", // 22:05
};

export interface Env {
  dir: string;
  store: Store;
  broker: FakeBroker;
  brain: FakeBrain;
  notifier: ConsoleNotifier;
  deps: RunDeps;
  clock: { t: Date };
  setNow(iso: string): void;
  slot(arg: string): ReturnType<typeof slotForArg>;
  /** testo di tutti i messaggi Telegram finti, uno dopo l'altro */
  said(): string;
  lines: string[];
}

export function setup(opts: { now?: string; brain?: FakeBrain; faults?: FakeFaults; dir?: string } = {}): Env {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "trader-test-"));
  const clock = { t: new Date(opts.now ?? T.apertura) };
  const now = () => clock.t;
  const store = new Store(dir);
  const broker = new FakeBroker(join(store.stateDir, "fake-broker.json"), now, opts.faults);
  const brain = opts.brain ?? new FakeBrain();
  const notifier = new ConsoleNotifier(null);
  const lines: string[] = [];
  const deps: RunDeps = { broker, brain, notifier, store, now, echo: (l) => lines.push(l) };
  return {
    dir,
    store,
    broker,
    brain,
    notifier,
    deps,
    clock,
    lines,
    setNow: (iso) => {
      clock.t = new Date(iso);
    },
    slot: (arg) => slotForArg(arg, clock.t),
    said: () => notifier.messages.join("\n---\n"),
  };
}

/** Quanti ordini per simbolo ci sono sul broker finto. */
export function countBySymbol(broker: FakeBroker): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of broker.allOrders()) out[o.symbol] = (out[o.symbol] ?? 0) + 1;
  return out;
}

/**
 * Tre acquisti piccoli (5%, 4,5%, 2,4% del conto): rifarli non sfora mai la gabbia,
 * quindi l'UNICA cosa che impedisce il doppione è l'id dell'ordine.
 */
export const SMALL_DECISION: Decision = {
  orders: [
    { symbol: "SPY", side: "buy", qty: 10, why: "indice largo" },
    { symbol: "QQQ", side: "buy", qty: 10, why: "tecnologia" },
    { symbol: "GLD", side: "buy", qty: 10, why: "oro" },
  ],
  reasoning: "Tre acquisti piccoli.",
  planNext: "Controllare lo stop.",
};
