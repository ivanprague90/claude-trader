#!/usr/bin/env bun
// Comandi:  once | schedule | status | reconcile      Opzioni:  --fake  --slot 15:40  --force  --now <ISO> (solo con --fake)  --dir <cartella>

import { join } from "node:path";
import { AlpacaBroker, assertPaperEndpoint } from "./broker.ts";
import { SCHEDULER_TICK_MS } from "./config.ts";
import { loadSecrets, secretValues, type Secrets } from "./env.ts";
import { FakeBrain, FakeBroker } from "./fake.ts";
import { fmtSignedUsd, fmtUsd } from "./fmt.ts";
import { ClaudeBrain } from "./llm.ts";
import { Logger } from "./log.ts";
import { ConsoleNotifier, TelegramNotifier } from "./notify.ts";
import { describeReconcile, reconcileStale, runWakeup, type RunDeps } from "./run.ts";
import { Store } from "./state.ts";
import { fmtRome, fmtSlot, isWithinLag, latestDueSlot, nextSlot, slotForArg } from "./time.ts";
import type { Broker } from "./types.ts";

interface Args {
  cmd: string;
  fake: boolean;
  force: boolean;
  slot?: string;
  now?: string;
  dir: string;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: "", fake: false, force: false, dir: process.cwd() };
  const rest = [...argv];
  while (rest.length) {
    const t = rest.shift()!;
    const [flag, inline] = t.startsWith("--") && t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
    const value = () => {
      const v = inline ?? rest.shift();
      if (v == null) throw new Error(`manca il valore di ${flag}`);
      return v;
    };
    if (flag === "--fake") a.fake = true;
    else if (flag === "--force") a.force = true;
    else if (flag === "--slot") a.slot = value();
    else if (flag === "--now") a.now = value();
    else if (flag === "--dir") a.dir = value();
    else if (flag.startsWith("--")) throw new Error(`opzione sconosciuta: ${flag}`);
    else if (!a.cmd) a.cmd = flag;
    else throw new Error(`argomento inatteso: ${flag}`);
  }
  if (a.now && !a.fake) throw new Error("--now si può usare solo con --fake");
  return a;
}

interface Wiring {
  deps: RunDeps;
  broker: Broker;
  store: Store;
  now: () => Date;
  log: Logger;
}

async function wire(a: Args): Promise<Wiring> {
  const now = a.now ? () => new Date(a.now!) : () => new Date();
  if (a.now && Number.isNaN(new Date(a.now).getTime())) throw new Error(`--now non è una data valida: ${a.now}`);
  const store = new Store(a.dir);

  if (a.fake) {
    const broker = new FakeBroker(join(store.stateDir, "fake-broker.json"), now);
    const notifier = new ConsoleNotifier();
    const log = new Logger(null);
    return { deps: { broker, brain: new FakeBrain(), notifier, store, now }, broker, store, now, log };
  }

  const secrets: Secrets = await loadSecrets();
  assertPaperEndpoint(secrets.ALPACA_ENDPOINT);
  const need = (k: keyof Secrets) => {
    if (!secrets[k]) throw new Error(`Manca ${k}: copia secrets.example.ts in secrets.ts e riempilo (oppure usa --fake per provare senza chiavi)`);
    return secrets[k]!;
  };
  const values = secretValues(secrets);
  const log = new Logger(null, values);
  const broker = new AlpacaBroker({ keyId: need("ALPACA_KEY_ID"), secret: need("ALPACA_SECRET_KEY") });
  const notifier =
    secrets.TELEGRAM_BOT_TOKEN && secrets.TELEGRAM_CHAT_ID
      ? new TelegramNotifier(secrets.TELEGRAM_BOT_TOKEN, secrets.TELEGRAM_CHAT_ID, log)
      : (log.line("telegram", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID mancanti: i messaggi vanno solo a schermo"), new ConsoleNotifier());
  const brain = new ClaudeBrain({ oauthToken: secrets.CLAUDE_CODE_OAUTH_TOKEN });
  return { deps: { broker, brain, notifier, store, now, secrets: values }, broker, store, now, log };
}

async function cmdOnce(a: Args): Promise<number> {
  const w = await wire(a);
  const now = w.now();
  const slot = a.slot ? slotForArg(a.slot, now) : latestDueSlot(now);
  if (!slot) {
    console.log("Nessuna sveglia ancora dovuta oggi. Per lanciarne una a mano: --slot 0900");
    return 0;
  }
  const r = await runWakeup(w.deps, slot, { force: a.force });
  if (r.status === "occupata") return 3;
  if (r.status === "errore") return 1;
  return 0;
}

async function cmdSchedule(a: Args): Promise<number> {
  const w = await wire(a);
  console.log(`[schedule ] acceso · controllo l'ora ogni ${SCHEDULER_TICK_MS / 1000} secondi · prossima sveglia ${fmtSlot(nextSlot(w.now()))}`);
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stop = true));
  let pause = 0;
  while (!stop) {
    try {
      const now = w.now();
      const slot = latestDueSlot(now);
      const { baton } = w.store.readBaton();
      const done = baton && Date.parse(baton.slotAt) >= (slot?.at.getTime() ?? Infinity);
      if (slot && !done && isWithinLag(slot, now) && now.getTime() >= pause) {
        const r = await runWakeup(w.deps, slot);
        if (r.status === "occupata") pause = now.getTime() + 60_000;
      }
    } catch (e) {
      console.log(`[schedule ] errore nel ciclo: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, SCHEDULER_TICK_MS));
  }
  return 0;
}

async function cmdStatus(a: Args): Promise<number> {
  const w = await wire(a);
  const lock = w.store.readLock();
  console.log(`lock:        ${lock ? `${lock.runId} · pid ${lock.pid} · dalle ${fmtRome(new Date(lock.startedAt))}` : "nessuno"}`);
  const { baton, corrupted } = w.store.readBaton();
  if (corrupted) console.log("testimone:   ILLEGGIBILE (vale come assente)");
  else if (!baton) console.log("testimone:   nessuno");
  else {
    console.log(`testimone:   ${baton.runId} · ${baton.slotName} · ${baton.outcome} · scritto ${fmtRome(new Date(baton.finishedAt))}`);
    console.log(`  prossima mossa: ${baton.planNext}`);
  }
  console.log(`prossima sveglia: ${fmtSlot(nextSlot(w.now()))}`);
  try {
    const acc = await w.broker.getAccount();
    const pos = await w.broker.getPositions();
    console.log(`conto:       ${fmtUsd(acc.equity)} · P&L giorno ${fmtSignedUsd(acc.equity - acc.lastEquity)} · liquidità ${fmtUsd(acc.cash)}`);
    for (const p of pos) console.log(`  ${p.qty} ${p.symbol} @ carico ${p.avgEntry.toFixed(2)} · ora ${p.price.toFixed(2)}`);
  } catch (e) {
    console.log(`conto:       non raggiungibile (${w.log.redact((e as Error).message)})`);
    if (baton) console.log(`  ultimo noto (${baton.runId}): ${fmtUsd(baton.account.equity)}`);
  }
  return 0;
}

async function cmdReconcile(a: Args): Promise<number> {
  const w = await wire(a);
  const lock = w.store.readLock();
  if (!lock) {
    console.log("Nessun lucchetto: nessuna sveglia interrotta.");
    return 0;
  }
  const report = await reconcileStale(w.broker, lock);
  console.log(describeReconcile(report));
  console.log("(Solo un rapporto: la prossima sveglia riconcilia e toglie il lucchetto da sola.)");
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let a: Args;
  try {
    a = parseArgs(argv);
    const commands: Record<string, (a: Args) => Promise<number>> = {
      once: cmdOnce,
      schedule: cmdSchedule,
      status: cmdStatus,
      reconcile: cmdReconcile,
    };
    const run = commands[a.cmd];
    if (!run) {
      console.log("Uso: bun run once|schedule|status|reconcile [--fake] [--slot 15:40] [--force]");
      return a.cmd ? 2 : 0;
    }
    return await run(a);
  } catch (e) {
    console.error(`Errore: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
