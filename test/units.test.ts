// Test dei pezzi singoli: orari, gabbia, client Alpaca (con fetch finto), log, lucchetto.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AlpacaBroker, assertPaperEndpoint } from "../src/broker.ts";
import { applyCage, orderId, type CageInput } from "../src/cage.ts";
import { PAPER_ENDPOINT } from "../src/config.ts";
import { claudeErrorDetail, decisionFromClaudeOutput, decisionFromText } from "../src/llm.ts";
import { Logger } from "../src/log.ts";
import { TelegramNotifier } from "../src/notify.ts";
import { Store } from "../src/state.ts";
import { isMarketHoursRome, latestDueSlot, nextSlot, slotForArg, slotsBetween, slotsOfDay } from "../src/time.ts";
import { BrokerError, DuplicateOrderError } from "../src/types.ts";

describe("orari (Europe/Rome)", () => {
  test("15:40 a Roma è 13:40 UTC con l'ora legale e 14:40 con l'ora solare", () => {
    expect(slotForArg("15:40", new Date("2026-10-05T12:00:00Z")).at.toISOString()).toBe("2026-10-05T13:40:00.000Z");
    expect(slotForArg("1540", new Date("2026-11-02T12:00:00Z")).at.toISOString()).toBe("2026-11-02T14:40:00.000Z");
  });

  test("id della sveglia: AAAA-MM-GG-HHMM", () => {
    expect(slotForArg("0900", new Date("2026-10-05T12:00:00Z")).id).toBe("2026-10-05-0900");
    expect(() => slotForArg("16:00", new Date())).toThrow("nessuna sveglia alle 16:00");
    expect(() => slotForArg("boh", new Date())).toThrow("non valido");
  });

  test("nel weekend solo il briefing", () => {
    expect(slotsOfDay(2026, 10, 10).map((s) => s.time)).toEqual(["09:00"]); // sabato
    expect(slotsOfDay(2026, 10, 12).map((s) => s.time)).toEqual(["09:00", "15:40", "18:30", "21:40"]); // lunedì
  });

  test("sveglie fra due istanti, weekend compreso", () => {
    const fri = new Date("2026-10-09T19:40:30Z"); // venerdì 21:40 Roma
    const mon = new Date("2026-10-12T13:40:00Z"); // lunedì 15:40 Roma (estremo escluso)
    expect(slotsBetween(fri, mon).map((s) => s.id)).toEqual(["2026-10-10-0900", "2026-10-11-0900", "2026-10-12-0900"]);
  });

  test("la più recente di oggi e la prossima", () => {
    expect(latestDueSlot(new Date("2026-10-10T08:30:00Z"))?.id).toBe("2026-10-10-0900"); // sabato 10:30
    expect(latestDueSlot(new Date("2026-10-05T06:30:00Z"))).toBeUndefined(); // lunedì 08:30: ancora niente
    expect(nextSlot(new Date("2026-10-09T20:30:00Z")).id).toBe("2026-10-10-0900"); // dopo venerdì 22:30
    expect(nextSlot(new Date("2026-10-05T07:00:00Z")).id).toBe("2026-10-05-1540");
  });

  test("orario del mercato USA visto da Roma", () => {
    expect(isMarketHoursRome(new Date("2026-10-05T13:29:00Z"))).toBe(false); // 15:29
    expect(isMarketHoursRome(new Date("2026-10-05T13:30:00Z"))).toBe(true); // 15:30
    expect(isMarketHoursRome(new Date("2026-10-05T19:59:00Z"))).toBe(true); // 21:59
    expect(isMarketHoursRome(new Date("2026-10-05T20:00:00Z"))).toBe(false); // 22:00
    expect(isMarketHoursRome(new Date("2026-10-10T14:00:00Z"))).toBe(false); // sabato
  });
});

describe("la gabbia (funzione pura)", () => {
  const base = (over: Partial<CageInput> = {}): CageInput => ({
    decision: { orders: [], reasoning: "x", planNext: "y" },
    slotId: "2026-10-05-1540",
    canTrade: true,
    marketOpen: true,
    account: { equity: 100_000, lastEquity: 100_000, cash: 100_000 },
    positions: [],
    prices: { SPY: 500, QQQ: 400, GLD: 200, AAPL: 200, MSFT: 400, IWM: 200, TLT: 100, NVDA: 100 },
    ...over,
  });
  const buy = (symbol: string, qty: number) => ({ symbol, side: "buy", qty, why: "t" });
  const sell = (symbol: string, qty: number) => ({ symbol, side: "sell", qty, why: "t" });
  const dec = (...orders: ReturnType<typeof buy>[]) => ({ orders, reasoning: "x", planNext: "y" });
  const pos = (symbol: string, qty: number, avgEntry: number, price: number) => ({ symbol, qty, avgEntry, price });

  test("id deterministico", () => {
    expect(orderId("2026-09-24-1540", "SPY", "buy")).toBe("2026-09-24-1540-SPY-buy");
  });

  test("esattamente il 20% passa, un'azione in più no", () => {
    const ok = applyCage(base({ decision: dec(buy("SPY", 40)) })); // 40 × 500 = 20.000 = 20,0%
    expect(ok.orders).toHaveLength(1);
    const no = applyCage(base({ decision: dec(buy("SPY", 41)) }));
    expect(no.orders).toHaveLength(0);
    expect(no.rejected[0]!.reason).toBe("oltre il 20% del conto per titolo: 41 azioni sarebbero il 20,5%");
  });

  test("il peso conta anche le azioni già in portafoglio", () => {
    const r = applyCage(base({ decision: dec(buy("NVDA", 60)), positions: [pos("NVDA", 30, 100, 100)] })); // 90 × 100 = 9% → ok
    expect(r.orders).toHaveLength(1);
    const r2 = applyCage(base({ decision: dec(buy("NVDA", 180)), positions: [pos("NVDA", 30, 100, 100)] })); // 210 × 100 = 21%
    expect(r2.rejected[0]!.reason).toContain("210 azioni sarebbero il 21,0%");
  });

  test("massimo 5 titoli: il sesto si rifiuta, ma si può rinforzare uno esistente", () => {
    const five = ["SPY", "QQQ", "GLD", "AAPL", "MSFT"].map((s) => pos(s, 1, 100, 100));
    const sixth = applyCage(base({ decision: dec(buy("IWM", 1)), positions: five }));
    expect(sixth.rejected[0]!.reason).toBe("già 5 titoli in portafoglio");
    const more = applyCage(base({ decision: dec(buy("SPY", 1)), positions: five }));
    expect(more.orders).toHaveLength(1);
  });

  test("nel solo acquisto di questa sveglia i titoli nuovi non sforano il 5", () => {
    const r = applyCage(base({ decision: dec(...["SPY", "QQQ", "GLD", "AAPL", "MSFT", "IWM"].map((s) => buy(s, 1))) }));
    expect(r.orders).toHaveLength(5);
    expect(r.rejected.map((x) => x.symbol)).toEqual(["IWM"]);
  });

  test("niente short", () => {
    const r = applyCage(base({ decision: { orders: [sell("SPY", 5)], reasoning: "x", planNext: "y" } }));
    expect(r.rejected[0]!.reason).toContain("niente short");
    const ok = applyCage(base({ decision: { orders: [sell("SPY", 5)], reasoning: "x", planNext: "y" }, positions: [pos("SPY", 5, 500, 500)] }));
    expect(ok.orders).toHaveLength(1);
  });

  test("niente leva: non si spende più della liquidità", () => {
    const r = applyCage(
      base({ decision: dec(buy("SPY", 30)), account: { equity: 100_000, lastEquity: 100_000, cash: 10_000 } }), // 15.000 $ > 10.000 $
    );
    expect(r.rejected[0]!.reason).toContain("niente leva");
  });

  test("la liquidità si consuma ordine dopo ordine", () => {
    const r = applyCage(base({ decision: dec(buy("SPY", 30), buy("QQQ", 30)), account: { equity: 100_000, lastEquity: 100_000, cash: 20_000 } }));
    expect(r.orders.map((o) => o.symbol)).toEqual(["SPY"]); // 15.000 $ ok, poi QQQ 12.000 $ > 5.000 $ rimasti
  });

  test("solo azioni intere e positive", () => {
    const r = applyCage(base({ decision: dec(buy("SPY", 0), buy("QQQ", -3), buy("GLD", 2.5), buy("AAPL", Number.NaN)) }));
    expect(r.orders).toHaveLength(0);
    expect(r.rejected).toHaveLength(4);
  });

  test("minuscole e spazi sul simbolo si normalizzano, il resto no", () => {
    const r = applyCage(base({ decision: dec(buy(" spy ", 1), buy("BRK.B", 1)) }));
    expect(r.orders.map((o) => o.symbol)).toEqual(["SPY"]);
    expect(r.rejected[0]!.reason).toContain("fuori universo");
  });

  test("lato sconosciuto e doppioni nella stessa decisione", () => {
    const r = applyCage(base({ decision: { orders: [{ symbol: "SPY", side: "short", qty: 1, why: "t" }, buy("QQQ", 1), buy("QQQ", 2)], reasoning: "x", planNext: "y" } }));
    expect(r.orders).toHaveLength(1);
    expect(r.rejected.map((x) => x.reason.split(":")[0])).toEqual(['lato non valido "short"', "duplicato"]);
  });

  test("stop loss: esattamente −3% scatta, −2,9% no", () => {
    const at = applyCage(base({ decision: null, positions: [pos("NVDA", 10, 100, 97)] }));
    expect(at.orders[0]).toMatchObject({ symbol: "NVDA", side: "sell", qty: 10, forced: true, why: "stop loss: −3,0% dal carico" });
    const above = applyCage(base({ decision: null, positions: [pos("NVDA", 10, 100, 97.1)] }));
    expect(above.orders).toHaveLength(0);
  });

  test("lo stop non dipende dal modello, e il modello non può riaprire o rivendere il titolo stoppato", () => {
    const r = applyCage(base({ decision: { orders: [sell("NVDA", 10), buy("NVDA", 5)], reasoning: "x", planNext: "y" }, positions: [pos("NVDA", 10, 100, 95)] }));
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]!.forced).toBe(true);
    expect(r.rejected).toHaveLength(2);
  });

  test("lo stop vale anche per un titolo fuori universo già in portafoglio", () => {
    const r = applyCage(base({ decision: null, positions: [pos("TSLA", 3, 100, 90)] }));
    expect(r.orders[0]).toMatchObject({ symbol: "TSLA", side: "sell", forced: true });
  });

  test("briefing e mercato chiuso: nessun ordine, nemmeno forzato", () => {
    const p = [pos("NVDA", 10, 100, 90)];
    expect(applyCage(base({ canTrade: false, positions: p, decision: dec(buy("SPY", 1)) })).orders).toHaveLength(0);
    expect(applyCage(base({ marketOpen: false, positions: p, decision: dec(buy("SPY", 1)) })).orders).toHaveLength(0);
  });

  test("senza prezzo non si compra", () => {
    const r = applyCage(base({ prices: {}, decision: dec(buy("SPY", 1)) }));
    expect(r.rejected[0]!.reason).toBe("prezzo non disponibile");
  });
});

describe("cervello: risposta di claude -p", () => {
  const good = { orders: [{ symbol: "SPY", side: "buy", qty: 1, why: "x" }], reasoning: "r", planNext: "p" };

  test("structured_output, result testuale, JSON nudo", () => {
    expect(decisionFromClaudeOutput(JSON.stringify({ type: "result", is_error: false, structured_output: good })).orders).toHaveLength(1);
    expect(decisionFromClaudeOutput(JSON.stringify({ type: "result", result: `Ecco:\n${JSON.stringify(good)}` })).planNext).toBe("p");
    expect(decisionFromClaudeOutput(JSON.stringify(good)).reasoning).toBe("r");
  });

  test("errore di claude, o risposta senza niente dentro → BrainError", () => {
    expect(() => decisionFromClaudeOutput(JSON.stringify({ is_error: true, result: "Not logged in" }))).toThrow("Not logged in");
    expect(() => decisionFromClaudeOutput(JSON.stringify({ type: "result" }))).toThrow("né structured_output né result");
    expect(() => decisionFromText("")).toThrow("nessun JSON");
  });

  test("errore di claude con codice ≠ 0: il motivo sta su stdout, nel campo result", () => {
    expect(claudeErrorDetail(JSON.stringify({ is_error: true, result: "Authentication error" }))).toBe("Authentication error");
    expect(claudeErrorDetail("non json")).toBe("");
  });
});

describe("client Alpaca (con fetch finto)", () => {
  const keys = { keyId: "PKTESTKEY123", secret: "SECRETTEST123456" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const make = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { broker: new AlpacaBroker(keys, { fetch: f, backoffMs: 1 }), calls };
  };

  test("l'endpoint è solo quello paper; chiavi negli header", async () => {
    const { broker, calls } = make(() => json({ equity: "99880.5", last_equity: "100000", cash: "50000" }));
    expect(await broker.getAccount()).toEqual({ equity: 99880.5, lastEquity: 100000, cash: 50000 });
    expect(calls[0]!.url.startsWith(`${PAPER_ENDPOINT}/v2/account`)).toBe(true);
    const h = calls[0]!.init!.headers as Record<string, string>;
    expect(h["APCA-API-KEY-ID"]).toBe(keys.keyId);
  });

  test("assertPaperEndpoint: il vero non passa", () => {
    expect(() => assertPaperEndpoint("https://api.alpaca.markets")).toThrow("rifiutato");
    expect(() => assertPaperEndpoint("http://localhost:9999")).toThrow("rifiutato");
    expect(() => assertPaperEndpoint(undefined)).not.toThrow();
    expect(() => assertPaperEndpoint(`${PAPER_ENDPOINT}/`)).not.toThrow();
  });

  test("5xx: tre tentativi, poi BrokerError ritentabile; al secondo va a buon fine", async () => {
    let n = 0;
    const flaky = make(() => (++n < 2 ? json({}, 503) : json({ is_open: true, timestamp: "t" })));
    expect((await flaky.broker.getClock()).isOpen).toBe(true);
    expect(n).toBe(2);

    const dead = make(() => json({}, 500));
    const err = await dead.broker.getClock().catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.retriable).toBe(true);
    expect(dead.calls).toHaveLength(3);
  });

  test("403: nessun nuovo tentativo, e le chiavi non finiscono nel messaggio", async () => {
    const { broker, calls } = make(() => new Response("forbidden", { status: 403 }));
    const err = await broker.getAccount().catch((e) => e);
    expect(err.retriable).toBe(false);
    expect(calls).toHaveLength(1);
    expect(err.message).not.toContain(keys.secret);
  });

  test("errore di rete: ritentabile", async () => {
    const { broker } = make(() => {
      throw new TypeError("fetch failed");
    });
    const err = await broker.getPositions().catch((e) => e);
    expect(err.retriable).toBe(true);
  });

  test("ordine: id nel body, nessun tentativo automatico; doppione 422 → DuplicateOrderError", async () => {
    const ok = make((_u, init) => json({ id: "1", client_order_id: JSON.parse(String(init!.body)).client_order_id, symbol: "SPY", side: "buy", qty: "20", status: "accepted" }));
    const o = await ok.broker.submitOrder({ symbol: "SPY", side: "buy", qty: 20, clientOrderId: "2026-10-05-1540-SPY-buy" });
    expect(o.clientOrderId).toBe("2026-10-05-1540-SPY-buy");
    const body = JSON.parse(String(ok.calls[0]!.init!.body));
    expect(body).toMatchObject({ symbol: "SPY", qty: "20", side: "buy", type: "market", time_in_force: "day" });

    const dup = make(() => json({ code: 40010001, message: "client_order_id must be unique" }, 422));
    expect(await dup.broker.submitOrder({ symbol: "SPY", side: "buy", qty: 1, clientOrderId: "x" }).catch((e) => e)).toBeInstanceOf(DuplicateOrderError);

    const down = make(() => json({}, 502));
    const err = await down.broker.submitOrder({ symbol: "SPY", side: "buy", qty: 1, clientOrderId: "x" }).catch((e) => e);
    expect(err.retriable).toBe(true);
    expect(down.calls).toHaveLength(1); // un POST non si ripete da solo
  });

  test("ordine per id: 404 → null", async () => {
    const { broker, calls } = make(() => new Response("{}", { status: 404 }));
    expect(await broker.getOrderByClientId("nope")).toBeNull();
    expect(calls[0]!.url).toContain("orders:by_client_order_id?client_order_id=nope");
  });

  test("prezzi dal data API", async () => {
    const { broker, calls } = make(() => json({ trades: { SPY: { p: 521.3 }, QQQ: { p: 452.1 } } }));
    expect(await broker.getPrices(["SPY", "QQQ"])).toEqual({ SPY: 521.3, QQQ: 452.1 });
    expect(calls[0]!.url).toContain("data.alpaca.markets");
  });
});

describe("log e Telegram", () => {
  test("il Logger maschera i valori segreti", () => {
    const lines: string[] = [];
    const log = new Logger(null, ["TOKENSEGRETO999"], (l) => lines.push(l));
    log.line("test", "url https://api.telegram.org/botTOKENSEGRETO999/sendMessage");
    expect(lines[0]).toBe("[test     ] url https://api.telegram.org/bot***/sendMessage");
  });

  test("Telegram: se l'errore di fetch contiene l'URL col token, nel log c'è ***", async () => {
    const lines: string[] = [];
    const log = new Logger(null, ["123456:ABCDEFSECRET"], (l) => lines.push(l));
    const f = (async (url: string) => {
      throw new Error(`Unable to connect to ${url}`);
    }) as unknown as typeof fetch;
    const tg = new TelegramNotifier("123456:ABCDEFSECRET", "42", log, f);
    expect(await tg.send("ciao")).toBe(false);
    expect(lines.join("\n")).toContain("messaggio non inviato");
    expect(lines.join("\n")).not.toContain("ABCDEFSECRET");
  });

  test("Telegram: HTTP non ok → false, senza lanciare", async () => {
    const lines: string[] = [];
    const body = JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" });
    const tg = new TelegramNotifier("t", "1", new Logger(null, [], (l) => lines.push(l)), (async () => new Response(body, { status: 400 })) as unknown as typeof fetch);
    expect(await tg.send("x")).toBe(false);
    expect(lines[0]).toContain("HTTP 400 · Bad Request: chat not found");
    // risposta senza JSON: resta solo il codice
    const plain = new TelegramNotifier("t", "1", new Logger(null, [], (l) => lines.push(l)), (async () => new Response("no", { status: 502 })) as unknown as typeof fetch);
    expect(await plain.send("x")).toBe(false);
    expect(lines[1]).toBe("[telegram ] messaggio non inviato: HTTP 502");
  });
});

describe("lucchetto", () => {
  async function deadPid(): Promise<number> {
    // un processo che parte e finisce subito; il suo pid non esiste più. process.execPath = bun stesso, quindi vale anche su Windows
    const p = Bun.spawn([process.execPath, "-e", "0"]);
    await p.exited;
    return p.pid;
  }

  test("lucchetto di un processo morto: lo porta via e lo restituisce; il secondo che arriva trova il nostro, vivo", async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "lock-")));
    const pid = await deadPid();
    writeFileSync(store.lockPath, JSON.stringify({ runId: "2026-10-05-1540", pid, host: (await import("node:os")).hostname(), startedAt: new Date().toISOString(), intended: ["a", "b"] }));
    const first = store.acquireLock({ runId: "2026-10-05-1830" });
    expect(first.acquired && first.stale.map((s) => s.runId)).toEqual(["2026-10-05-1540"]);
    expect(first.acquired && first.stale[0]!.intended).toEqual(["a", "b"]);
    const second = store.acquireLock({ runId: "x" });
    expect(second.acquired).toBe(false);
    expect(!second.acquired && second.heldBy?.runId).toBe("2026-10-05-1830");
    store.releaseLock();
    expect(store.readLock()).toBeNull();
  });

  test("lucchetto vecchio di oltre 20 minuti: morto anche se il pid esiste (pid riusato dopo un riavvio)", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "lock-")));
    writeFileSync(
      store.lockPath,
      JSON.stringify({ runId: "vecchia", pid: process.pid, host: require("node:os").hostname(), startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), intended: [] }),
    );
    const r = store.acquireLock({ runId: "nuova" });
    expect(r.acquired && r.stale[0]!.runId).toBe("vecchia");
  });

  test("testimone: scrittura atomica e storia", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "baton-")));
    const baton = {
      version: 1 as const, runId: "2026-10-05-1540", slot: "15:40", slotName: "apertura", slotAt: "2026-10-05T13:40:00.000Z",
      finishedAt: "2026-10-05T13:41:00.000Z", outcome: "ok" as const, summary: "s", planNext: "p", orders: [], rejected: [], notes: [],
      account: { equity: 1, lastEquity: 1, cash: 1 }, positions: [],
    };
    store.writeBaton(baton);
    expect(store.readBaton()).toEqual({ baton, corrupted: false });
    expect(JSON.parse(readFileSync(store.batonPath, "utf8")).runId).toBe("2026-10-05-1540");
  });
});
