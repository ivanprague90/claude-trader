// Stato su disco: il testimone (le intenzioni della sveglia prima) e il lucchetto (una sveglia alla volta).
// Tutto quello che conta si scrive in modo atomico: file temporaneo + rename.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { STALE_LOCK_MIN } from "./config.ts";
import type { Baton, LockInfo } from "./types.ts";

export type AcquireResult =
  | { acquired: true; /** lucchetti di sveglie morte trovati e portati via: vanno riconciliati */ stale: LockInfo[] }
  | { acquired: false; heldBy: LockInfo | null };

export class Store {
  readonly stateDir: string;
  readonly historyDir: string;
  readonly logsDir: string;
  readonly batonPath: string;
  readonly lockPath: string;

  constructor(readonly baseDir: string) {
    this.stateDir = join(baseDir, "state");
    this.historyDir = join(this.stateDir, "history");
    this.logsDir = join(baseDir, "logs");
    this.batonPath = join(this.stateDir, "baton.json");
    this.lockPath = join(this.stateDir, "run.lock");
    mkdirSync(this.historyDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
  }

  // ---- testimone ----

  /** Il testimone, oppure null se non c'è o è illeggibile (un testimone corrotto vale come "nessun testimone"). */
  readBaton(): { baton: Baton | null; corrupted: boolean } {
    if (!existsSync(this.batonPath)) return { baton: null, corrupted: false };
    try {
      const b = JSON.parse(readFileSync(this.batonPath, "utf8")) as Baton;
      if (b?.version !== 1 || typeof b.runId !== "string" || typeof b.slotAt !== "string" || Number.isNaN(Date.parse(b.slotAt))) {
        throw new Error("struttura non valida");
      }
      return { baton: b, corrupted: false };
    } catch {
      return { baton: null, corrupted: true };
    }
  }

  writeBaton(b: Baton): void {
    const json = JSON.stringify(b, null, 2);
    atomicWrite(this.batonPath, json);
    const stamp = b.finishedAt.replace(/[-:]/g, "").replace(/\..*$/, "");
    atomicWrite(join(this.historyDir, `${b.runId}-${stamp}.json`), json);
  }

  // ---- lucchetto ----

  readLock(): LockInfo | null {
    return parseLock(this.lockPath);
  }

  /**
   * Prende il lucchetto. Se ne trova uno di una sveglia morta lo porta via con un rename (atomico:
   * se due processi ci provano insieme, ne vince uno solo) e lo restituisce in `stale` perché venga riconciliato.
   */
  acquireLock(info: Omit<LockInfo, "pid" | "host" | "startedAt" | "intended">): AcquireResult {
    const mine: LockInfo = { ...info, pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), intended: [] };
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeSync(fd, JSON.stringify(mine));
        closeSync(fd);
        return { acquired: true, stale: this.takeStaleGraves() };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const existing = this.readLock();
      if (this.isLive(existing)) return { acquired: false, heldBy: existing };
      // Illeggibile da pochi istanti = un altro processo lo sta scrivendo adesso: non è morto, è occupato.
      if (!existing && ageMs(this.lockPath) < 3000) return { acquired: false, heldBy: null };
      const grave = join(this.stateDir, `run.lock.stale.${process.pid}.${Date.now()}`);
      try {
        renameSync(this.lockPath, grave);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // l'ha già portato via un altro
        throw e;
      }
    }
    return { acquired: false, heldBy: this.readLock() };
  }

  /** Registra gli id che la sveglia sta per inviare: serve a riconciliare se muore a metà. */
  setIntended(ids: string[]): void {
    const l = this.readLock();
    if (!l || l.pid !== process.pid) return;
    atomicWrite(this.lockPath, JSON.stringify({ ...l, intended: ids }));
  }

  releaseLock(): void {
    const l = this.readLock();
    if (l && l.pid === process.pid) {
      try {
        unlinkSync(this.lockPath);
      } catch {
        /* già tolto */
      }
    }
  }

  private isLive(l: LockInfo | null): boolean {
    if (!l) return false;
    if (l.host !== hostname()) return Date.now() - Date.parse(l.startedAt) < STALE_LOCK_MIN * 60_000;
    if (Date.now() - Date.parse(l.startedAt) > STALE_LOCK_MIN * 60_000) return false;
    try {
      process.kill(l.pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /** Raccoglie (e toglie) i lucchetti di sveglie morte portati via da acquireLock. */
  takeStaleGraves(): LockInfo[] {
    const out: LockInfo[] = [];
    for (const name of readdirSync(this.stateDir)) {
      if (!name.startsWith("run.lock.stale.")) continue;
      const path = join(this.stateDir, name);
      const info = parseLock(path) ?? { runId: "sconosciuta", pid: 0, host: "?", startedAt: "", intended: [] };
      try {
        unlinkSync(path);
        out.push(info);
      } catch {
        /* lo ha preso un altro */
      }
    }
    return out;
  }
}

function parseLock(path: string): LockInfo | null {
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as LockInfo;
    return { ...l, intended: Array.isArray(l.intended) ? l.intended : [] };
  } catch {
    return null;
  }
}

function ageMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
}

export function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
