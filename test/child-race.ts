// Figlio per il test della gara sul lucchetto: stampa lo stato finale della sveglia.
import { FakeBrain } from "../src/fake.ts";
import { runWakeup } from "../src/run.ts";
import { SMALL_DECISION, setup } from "./helpers.ts";

const [dir, nowIso] = process.argv.slice(2) as [string, string];
const e = setup({ dir, now: nowIso, brain: new FakeBrain({ decision: SMALL_DECISION }) });
const r = await runWakeup(e.deps, e.slot("1540"));
console.log(r.status);
