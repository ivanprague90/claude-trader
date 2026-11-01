// Processo figlio per il test del kill -9: esegue una sveglia vera con broker finto che,
// dopo il primo ordine accettato, uccide il processo con SIGKILL (nessun cleanup, nessun finally).
import { FakeBrain } from "../src/fake.ts";
import { runWakeup } from "../src/run.ts";
import { SMALL_DECISION, setup } from "./helpers.ts";

const [dir, nowIso] = process.argv.slice(2) as [string, string];
const e = setup({ dir, now: nowIso, brain: new FakeBrain({ decision: SMALL_DECISION }), faults: { killAfterOrders: 1 } });
await runWakeup(e.deps, e.slot("1540"));
console.log("ERRORE: il processo doveva morire prima di arrivare qui");
