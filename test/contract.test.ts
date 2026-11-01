// I sei test del contratto, con broker e cervello finti.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeBrain } from "../src/fake.ts";
import { runWakeup } from "../src/run.ts";
import { SMALL_DECISION, countBySymbol, setup, T } from "./helpers.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function cli(dir: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", CLI, "once", "--fake", "--dir", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code, signal: p.signalCode };
}

const smallBrain = () => new FakeBrain({ decision: SMALL_DECISION });

describe("1. stessa sveglia lanciata due volte → un solo ordine per titolo", () => {
  test("lancio doppio quasi insieme: una parte, l'altra trova il lucchetto occupato", async () => {
    const e = setup({ brain: smallBrain() });
    const slot = e.slot("1540");
    const [a, b] = await Promise.all([runWakeup(e.deps, slot), runWakeup(e.deps, slot)]);
    expect([a.status, b.status].sort()).toEqual(["occupata", "ok"]);
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
  });

  test("rilancio dopo che è finita: non riparte", async () => {
    const e = setup({ brain: smallBrain() });
    const slot = e.slot("1540");
    await runWakeup(e.deps, slot);
    const again = await runWakeup(e.deps, slot);
    expect(again.status).toBe("già fatta");
    expect(e.broker.allOrders()).toHaveLength(3);
  });

  test("rilancio con --force: riparte, ma gli id impediscono i doppioni (la gabbia qui non c'entra)", async () => {
    const e = setup({ brain: smallBrain() });
    const slot = e.slot("1540");
    await runWakeup(e.deps, slot);
    const again = await runWakeup(e.deps, slot, { force: true });
    expect(again.status).toBe("ok");
    expect(again.orders.map((o) => o.status)).toEqual(["già presente", "già presente", "già presente"]);
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
  });
});

describe("2. processo ucciso dopo il primo ordine → la sveglia dopo trova il lock, riconcilia, non ricompra", () => {
  test("kill -9 vero su un processo figlio", async () => {
    const e = setup({ brain: smallBrain() });

    // il figlio esegue una sveglia vera e si uccide da solo (SIGKILL: niente cleanup) subito dopo il primo ordine accettato
    const child = Bun.spawn(["bun", join(import.meta.dir, "child-run.ts"), e.dir, T.apertura], { stdout: "pipe", stderr: "pipe" });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(existsSync(e.store.lockPath)).toBe(true); // il lucchetto è rimasto: la sveglia è morta a metà
    expect(e.broker.allOrders().map((o) => o.clientOrderId)).toEqual(["2026-10-05-1540-SPY-buy"]);
    expect(e.store.readLock()!.intended).toEqual(["2026-10-05-1540-SPY-buy", "2026-10-05-1540-QQQ-buy", "2026-10-05-1540-GLD-buy"]);
    expect(e.store.readBaton().baton).toBeNull(); // nessun testimone: la sveglia non è mai finita

    // la sveglia dopo (stessa sveglia, ancora dovuta): trova il lock, riconcilia, completa senza ricomprare SPY
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("ok");
    const said = e.said();
    expect(said).toContain("morta a metà");
    expect(said).toContain("Su Alpaca risultano 1 ordini: comprato 10 SPY");
    expect(said).toContain("Non partiti: 2026-10-05-1540-QQQ-buy, 2026-10-05-1540-GLD-buy");
    expect(r.orders.map((o) => [o.symbol, o.status])).toEqual([
      ["SPY", "già presente"],
      ["QQQ", "inviato"],
      ["GLD", "inviato"],
    ]);
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
    expect(existsSync(e.store.lockPath)).toBe(false);
    expect(e.store.readBaton().baton?.runId).toBe("2026-10-05-1540");
    expect(r.baton!.notes.join(" ")).toContain("morta a metà"); // il cervello lo sa
  });

  test("due processi veri si contendono il lucchetto di una sveglia morta: ne vince uno solo", async () => {
    const e = setup({ brain: smallBrain() });
    const dead = Bun.spawn(["bun", join(import.meta.dir, "child-run.ts"), e.dir, T.apertura], { stdout: "pipe", stderr: "pipe" });
    await dead.exited;
    const racer = () => Bun.spawn(["bun", join(import.meta.dir, "child-race.ts"), e.dir, T.apertura], { stdout: "pipe", stderr: "pipe" });
    const [a, b] = [racer(), racer()];
    const [outA, outB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]);
    await Promise.all([a.exited, b.exited]);
    const statuses = [outA, outB].map((o) => o.trim().split("\n").at(-1));
    // una sola sveglia lavora; l'altra o trova il lucchetto occupato o, se arriva dopo, la sveglia già fatta
    expect(statuses.filter((x) => x === "ok")).toHaveLength(1);
    expect(statuses.filter((x) => x === "occupata" || x === "già fatta")).toHaveLength(1);
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
  });
});

describe("la CLI (--fake) da riga di comando", () => {
  test("una sveglia di prova gira, e il rilancio dice che è già fatta", async () => {
    const e = setup();
    const first = await cli(e.dir, ["--slot", "1540", "--now", T.apertura]);
    expect(first.code).toBe(0);
    expect(first.out).toContain("✅ Fatto · apertura");
    const second = await cli(e.dir, ["--slot", "1540", "--now", T.apertura]);
    expect(second.out).toContain("già fatta");
    expect(countBySymbol(e.broker)).toEqual({ SPY: 1, QQQ: 1, GLD: 1 });
  });
});

describe("3. testimone delle 09:00 e poi niente fino alle 21:40 → segnala 15:40 e 18:30 come saltate", () => {
  test("segnala le due sveglie saltate e non le recupera", async () => {
    const e = setup({ now: T.briefing });
    await runWakeup(e.deps, e.slot("0900"));
    expect(e.store.readBaton().baton?.runId).toBe("2026-10-05-0900");
    expect(e.broker.allOrders()).toHaveLength(0);

    e.setNow(T.chiusura);
    const r = await runWakeup(e.deps, e.slot("2140"));
    expect(r.status).toBe("ok");
    const said = e.said();
    expect(said).toContain("Sveglie saltate");
    expect(said).toContain("2026-10-05 15:40");
    expect(said).toContain("2026-10-05 18:30");
    expect(said).not.toContain("2026-10-05 09:00,"); // il 09:00 è stata fatta
    expect(r.baton!.notes.join(" ")).toContain("Non le recupero");
    // non recuperate: solo gli ordini della sveglia 21:40
    expect(e.broker.allOrders().every((o) => o.clientOrderId.startsWith("2026-10-05-2140-"))).toBe(true);
  });
});

describe("4. il modello propone un titolo fuori universo, o il 40% del conto su un titolo → rifiutati", () => {
  test("fuori universo e 40% del conto", async () => {
    const brain = new FakeBrain({
      decision: {
        orders: [
          { symbol: "TSLA", side: "buy", qty: 5, why: "fuori universo" },
          { symbol: "SPY", side: "buy", qty: 77, why: "il 40% del conto" }, // 77 × 520 = 40.040 $
          { symbol: "GLD", side: "buy", qty: 10, why: "questo è ammesso" },
        ],
        reasoning: "Provo a forzare la gabbia.",
        planNext: "Vedere cosa è passato.",
      },
    });
    const e = setup({ brain });
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.orders.map((o) => o.symbol)).toEqual(["GLD"]);
    expect(r.rejected.map((x) => x.symbol).sort()).toEqual(["SPY", "TSLA"]);
    expect(r.rejected.find((x) => x.symbol === "TSLA")!.reason).toContain("fuori universo");
    expect(r.rejected.find((x) => x.symbol === "SPY")!.reason).toContain("oltre il 20% del conto per titolo");
    expect(countBySymbol(e.broker)).toEqual({ GLD: 1 });
    expect(e.said()).toContain("Rifiutati dalla gabbia");
  });
});

describe("5. posizione a −4% → la gabbia la vende anche se il modello dice di tenere", () => {
  const holdBrain = () =>
    new FakeBrain({ decision: { orders: [], reasoning: "Tengo: la tesi non è cambiata.", planNext: "Aspettare che risalga." } });

  test("a −4% vende tutto, anche se il modello dice di tenere", async () => {
    const e = setup({ now: T.metaSeduta, brain: holdBrain() });
    e.broker.seedPosition("NVDA", 30, 100, 96); // −4%
    const r = await runWakeup(e.deps, e.slot("1830"));
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]).toMatchObject({ symbol: "NVDA", side: "sell", qty: 30, forced: true, status: "inviato" });
    expect((await e.broker.getPositions()).find((p) => p.symbol === "NVDA")).toBeUndefined();
    expect(e.said()).toContain("venduto 30 NVDA (stop loss: −4,0% dal carico)");
  });

  test("prova al contrario: a −2% non vende", async () => {
    const e = setup({ now: T.metaSeduta, brain: holdBrain() });
    e.broker.seedPosition("NVDA", 30, 100, 98);
    const r = await runWakeup(e.deps, e.slot("1830"));
    expect(r.orders).toHaveLength(0);
    expect((await e.broker.getPositions())[0]!.qty).toBe(30);
  });

  test("vende anche se il cervello non risponde", async () => {
    const brain = new FakeBrain({
      respond: () => {
        throw new Error("timeout");
      },
    });
    const e = setup({ now: T.metaSeduta, brain });
    e.broker.seedPosition("NVDA", 30, 100, 95);
    const r = await runWakeup(e.deps, e.slot("1830"));
    expect(r.status).toBe("cervello non disponibile");
    expect(r.orders[0]).toMatchObject({ symbol: "NVDA", side: "sell", forced: true });
    expect(e.said()).toContain("Cervello non disponibile: applico solo lo stop loss");
  });
});

describe("6. testimone corrotto → vale come «nessun testimone», la sveglia va avanti col broker", () => {
  test.each([
    ["testo a caso", "{non è json"],
    ["JSON troncato a metà", '{"version":1,"runId":"2026-10-05-0900","slotAt":"2026-10-0'],
    ["JSON valido ma di un'altra forma", '{"ciao":1}'],
    ["file vuoto", ""],
  ])("%s", async (_name, garbage) => {
    const e = setup();
    writeFileSync(e.store.batonPath, garbage);
    const r = await runWakeup(e.deps, e.slot("1540"));
    expect(r.status).toBe("ok");
    expect(e.broker.allOrders()).toHaveLength(3);
    expect(r.baton!.notes.join(" ")).toContain("illeggibile");
    expect(e.said()).toContain("illeggibile");
    // e il testimone nuovo è valido
    expect(e.store.readBaton()).toMatchObject({ corrupted: false, baton: { runId: "2026-10-05-1540" } });
    expect(JSON.parse(readFileSync(e.store.batonPath, "utf8")).version).toBe(1);
  });
});
