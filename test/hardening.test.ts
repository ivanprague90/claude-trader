// Guasti e casi di bordo oltre ai sei del contratto: cervello che risponde male, broker in timeout,
// mercato che chiude mentre il cervello ragiona, broker spento, Telegram che non risponde, chiavi nei log.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBrain } from "../src/fake.ts";
import { runWakeup } from "../src/run.ts";
import type { Notifier } from "../src/types.ts";
import { SMALL_DECISION, countBySymbol, setup, T } from "./helpers.ts";

describe("il modello risponde male", () => {
  test.each([
    ["JSON troncato", '{"orders":[{"symbol":"SPY","side":"buy","qty":10,"why":"ind'],
    ["campo mancante (planNext)", '{"orders":[],"reasoning":"ok"}'],
    ["nessun JSON, solo testo", "Certo! Ecco cosa farei: comprerei SPY."],
    ["ordine senza quantità", '{"orders":[{"symbol":"SPY","side":"buy","why":"x"}],"reasoning":"a","planNext":"b"}'],
    ["quantità come stringa", '{"orders":[{"symbol":"SPY","side":"buy","qty":"10","why":"x"}],"reasoning":"a","planNext":"b"}'],
  ])("%s → nessun ordine nuovo, sveglia finita, avviso", async (_n, raw) => {
    const e = setup({ brain: new FakeBrain({ raw }) });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("cervello non disponibile");
    expect(e.broker.allOrders()).toHaveLength(0);
    expect(e.said()).toContain("Cervello non disponibile: applico solo lo stop loss");
    expect(e.said()).toContain("✅ Fatto"); // la sveglia finisce lo stesso e lo dice
    expect(existsSync(e.store.lockPath)).toBe(false);
  });

  test("quantità negativa o con la virgola → rifiutata dalla gabbia, le altre passano", async () => {
    const raw = JSON.stringify({
      orders: [
        { symbol: "SPY", side: "buy", qty: -5, why: "negativa" },
        { symbol: "QQQ", side: "buy", qty: 1.5, why: "non intera" },
        { symbol: "GLD", side: "buy", qty: 4, why: "ok" },
      ],
      reasoning: "prova",
      planNext: "prova",
    });
    const e = setup({ brain: new FakeBrain({ raw }) });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.orders.map((o) => o.symbol)).toEqual(["GLD"]);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0]!.reason).toContain("quantità non valida");
  });

  test("risposta avvolta in ```json … ``` → accettata", async () => {
    const raw = "```json\n" + JSON.stringify({ orders: [], reasoning: "Niente da fare.", planNext: "Aspetto." }) + "\n```";
    const e = setup({ brain: new FakeBrain({ raw }) });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("ok");
  });
});

describe("il broker non risponde o perde le risposte", () => {
  test("risposta persa dopo l'invio: si ricontrolla per id e l'ordine risulta arrivato, senza reinvio", async () => {
    const e = setup({ brain: new FakeBrain({ decision: SMALL_DECISION }), faults: { loseResponseOnSubmit: true } });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.orders.map((o) => o.status)).toEqual(["inviato", "inviato", "inviato"]);
    expect(r.orders[0]!.detail).toContain("risposta persa");
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
  });

  test("risposta persa E controllo per id che non risponde → «esito sconosciuto» con avviso", async () => {
    const e = setup({ brain: new FakeBrain({ decision: SMALL_DECISION }), faults: { loseResponseOnSubmit: true, failLookup: true } });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.orders.every((o) => o.status === "esito sconosciuto")).toBe(true);
    expect(e.said()).toContain("Esito sconosciuto per l'ordine 2026-10-05-1540-SPY-buy");
    expect(e.said()).toContain("ESITO SCONOSCIUTO, controlla su Alpaca");
  });

  test("broker spento: la sveglia fallisce pulita (testimone di errore, ❌, lucchetto rilasciato)", async () => {
    const e = setup();
    await runWakeup(e.deps, e.slot("1540")); // una sveglia buona prima, per avere un testimone
    e.broker.faults.down = true;
    e.setNow(T.metaSeduta);
    const r = await runWakeup(e.deps, e.slot("1830"));
    expect(r.status).toBe("errore");
    expect(e.said()).toContain("❌ Sveglia fallita · metà seduta");
    expect(e.said()).toContain("Nessun ordine inviato");
    expect(existsSync(e.store.lockPath)).toBe(false);
    const b = e.store.readBaton().baton!;
    expect(b.runId).toBe("2026-10-05-1830");
    expect(b.outcome).toBe("errore");
    expect(b.planNext).toContain("distanza dallo stop"); // il piano della sveglia prima non si perde
  });
});

describe("l'orologio e il mercato", () => {
  test("il cervello è lento: la sveglia delle 21:40 parte alle 22:05, a mercato chiuso → nessun ordine", async () => {
    const e = setup({ now: T.chiusura });
    const slow = new FakeBrain({ decision: SMALL_DECISION, onDecide: () => e.setNow(T.dopoChiusura) });
    const deps = { ...e.deps, brain: slow };
    const r = await runWakeup(deps, e.slot("2140"));
    expect(r.orders).toHaveLength(0);
    expect(r.rejected.map((x) => x.reason)).toEqual(Array(3).fill("mercato chiuso al momento dell'invio"));
    expect(e.broker.allOrders()).toHaveLength(0);
  });

  test("mercato chiuso fin dall'inizio → nessun ordine, e te lo scrive", async () => {
    const e = setup({ faults: { marketOpen: false } });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.orders).toHaveLength(0);
    expect(r.rejected.every((x) => x.reason === "mercato chiuso")).toBe(true);
    expect(e.said()).toContain("mercato chiuso");
  });

  test("briefing delle 09:00: il cervello propone ordini, nessuno parte", async () => {
    const e = setup({ now: T.briefing });
    const r = await runWakeup(e.deps, e.slot("0900"));
    expect(r.orders).toHaveLength(0);
    expect(r.rejected.every((x) => x.reason === "nessun ordine nel briefing")).toBe(true);
    expect(e.broker.allOrders()).toHaveLength(0);
  });

  test("briefing: nemmeno lo stop loss (il mercato USA è chiuso)", async () => {
    const e = setup({ now: T.briefing });
    e.broker.seedPosition("NVDA", 30, 100, 90);
    const r = await runWakeup(e.deps, e.slot("0900"));
    expect(r.orders).toHaveLength(0);
  });
});

describe("Telegram, testimone, chiavi", () => {
  test("Telegram che non risponde (anche se lancia) non ferma la sveglia", async () => {
    const e = setup();
    const broken: Notifier = {
      send: async () => {
        throw new Error("telegram è giù");
      },
    };
    const r = await runWakeup({ ...e.deps, notifier: broken }, e.slot("1540"));
    expect(r.status).toBe("ok");
    expect(e.broker.allOrders()).toHaveLength(3);
    expect(e.lines.join("\n")).toContain("messaggio non inviato: telegram è giù");
  });

  test("il testimone è scritto PRIMA del messaggio finale, e senza file temporanei", async () => {
    const e = setup();
    const seen: { baton: boolean | null } = { baton: null };
    const spy: Notifier = {
      send: async (text) => {
        if (text.startsWith("✅")) seen.baton = existsSync(e.store.batonPath);
        return true;
      },
    };
    await runWakeup({ ...e.deps, notifier: spy }, e.slot("1540"));
    expect(seen.baton).toBe(true);
    expect(readdirSync(e.store.stateDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(e.store.historyDir).filter((f) => f.startsWith("2026-10-05-1540"))).toHaveLength(1);
  });

  test("la storia si accumula: una copia del testimone per sveglia", async () => {
    const e = setup({ now: T.briefing });
    await runWakeup(e.deps, e.slot("0900"));
    e.setNow(T.apertura);
    await runWakeup(e.deps, e.slot("1540"));
    expect(readdirSync(e.store.historyDir)).toHaveLength(2);
  });

  test("le chiavi non compaiono mai: né nel log, né a schermo, né nei messaggi", async () => {
    const SECRET = "PKSUPERSEGRETA123456";
    const brain = new FakeBrain({
      decision: { orders: [], reasoning: `Per sbaglio ho scritto la chiave ${SECRET} nel ragionamento.`, planNext: `Non ripetere ${SECRET}.` },
    });
    const e = setup({ brain });
    await runWakeup({ ...e.deps, secrets: [SECRET] }, e.slot("1540"));
    const logFile = readFileSync(join(e.store.logsDir, "2026-10-05-1540.log"), "utf8");
    expect(logFile).toContain("***");
    expect(logFile).not.toContain(SECRET);
    expect(e.lines.join("\n")).not.toContain(SECRET);
    expect(e.said()).not.toContain(SECRET);
  });

  test("un lucchetto di una sveglia viva (questo stesso processo) non viene toccato", async () => {
    const e = setup();
    const first = e.store.acquireLock({ runId: "2026-10-05-1540" });
    expect(first.acquired).toBe(true);
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("occupata");
    expect(e.store.readLock()!.runId).toBe("2026-10-05-1540");
    e.store.releaseLock();
  });

  test("lucchetto illeggibile e vecchio → trattato come di una sveglia morta e riconciliato", async () => {
    const e = setup();
    writeFileSync(e.store.lockPath, "{rotto");
    const old = new Date(Date.now() - 60_000);
    (await import("node:fs")).utimesSync(e.store.lockPath, old, old);
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("ok");
    expect(e.said()).toContain("lucchetto illeggibile");
  });
});
