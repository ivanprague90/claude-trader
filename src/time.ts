import { MARKET_CLOSE_MIN, MARKET_OPEN_MIN, MAX_SLOT_LAG_MIN, SLOTS, TIMEZONE, type SlotDef } from "./config.ts";

export interface RomeParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  /** 0 = domenica … 6 = sabato */
  weekday: number;
}

const fmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function romeParts(date: Date): RomeParts {
  const m: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) m[p.type] = p.value;
  return {
    y: Number(m.year),
    mo: Number(m.month),
    d: Number(m.day),
    h: Number(m.hour),
    mi: Number(m.minute),
    s: Number(m.second),
    weekday: WEEKDAYS[m.weekday!]!,
  };
}

const partsAsUtcMs = (p: RomeParts) => Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);

/** Un orario "da muro" di Roma → l'istante vero. */
export function romeToDate(y: number, mo: number, d: number, h: number, mi: number): Date {
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 2; i++) guess += target - partsAsUtcMs(romeParts(new Date(guess)));
  return new Date(guess);
}

const p2 = (n: number) => String(n).padStart(2, "0");

export interface SlotInstance {
  /** AAAA-MM-GG-HHMM: è anche l'id della sveglia (run id) */
  id: string;
  date: string;
  /** HH:MM */
  time: string;
  def: SlotDef;
  at: Date;
}

function makeSlot(y: number, mo: number, d: number, def: SlotDef): SlotInstance {
  const [h, mi] = def.time.split(":").map(Number) as [number, number];
  const date = `${y}-${p2(mo)}-${p2(d)}`;
  return { id: `${date}-${p2(h)}${p2(mi)}`, date, time: def.time, def, at: romeToDate(y, mo, d, h, mi) };
}

/** Le sveglie di un giorno di Roma: nel weekend solo il briefing. */
export function slotsOfDay(y: number, mo: number, d: number): SlotInstance[] {
  const weekday = new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
  const weekend = weekday === 0 || weekday === 6;
  return SLOTS.filter((s) => !weekend || s.weekend).map((def) => makeSlot(y, mo, d, def));
}

function addDays(y: number, mo: number, d: number, n: number): [number, number, number] {
  const t = new Date(Date.UTC(y, mo - 1, d + n, 12));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** Le sveglie previste strettamente fra due istanti. */
export function slotsBetween(after: Date, before: Date, maxDays = 60): SlotInstance[] {
  const a = romeParts(after);
  const out: SlotInstance[] = [];
  for (let i = 0; i <= maxDays; i++) {
    const [y, mo, d] = addDays(a.y, a.mo, a.d, i);
    for (const s of slotsOfDay(y, mo, d)) {
      if (s.at > after && s.at < before) out.push(s);
    }
    if (romeToDate(y, mo, d, 0, 0) >= before) break;
  }
  return out;
}

/** La sveglia più recente di oggi (ora di Roma) già scattata. */
export function latestDueSlot(now: Date): SlotInstance | undefined {
  const p = romeParts(now);
  return slotsOfDay(p.y, p.mo, p.d)
    .filter((s) => s.at <= now)
    .at(-1);
}

/** La prima sveglia dopo `now`. */
export function nextSlot(now: Date): SlotInstance {
  const p = romeParts(now);
  for (let i = 0; i < 8; i++) {
    const [y, mo, d] = addDays(p.y, p.mo, p.d, i);
    const s = slotsOfDay(y, mo, d).find((x) => x.at > now);
    if (s) return s;
  }
  throw new Error("nessuna sveglia nei prossimi 8 giorni: config.SLOTS è vuoto?");
}

/** "15:40", "1540" o "0900" → sveglia di oggi. Lancia se non esiste. */
export function slotForArg(arg: string, now: Date): SlotInstance {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(arg.trim());
  if (!m) throw new Error(`orario sveglia non valido: "${arg}" (esempio: 15:40 o 1540)`);
  const time = `${p2(Number(m[1]))}:${m[2]}`;
  const def = SLOTS.find((s) => s.time === time);
  if (!def) throw new Error(`nessuna sveglia alle ${time}. Quelle previste: ${SLOTS.map((s) => s.time).join(", ")}`);
  const p = romeParts(now);
  return makeSlot(p.y, p.mo, p.d, def);
}

/** Dall'orologio di Roma: lun–ven 15:30–22:00. Usato solo dal broker finto. */
export function isMarketHoursRome(now: Date): boolean {
  const p = romeParts(now);
  if (p.weekday === 0 || p.weekday === 6) return false;
  const min = p.h * 60 + p.mi;
  return min >= MARKET_OPEN_MIN && min < MARKET_CLOSE_MIN;
}

export function isWithinLag(slot: SlotInstance, now: Date): boolean {
  return now.getTime() - slot.at.getTime() <= MAX_SLOT_LAG_MIN * 60_000;
}

export function fmtRome(date: Date): string {
  const p = romeParts(date);
  return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}`;
}

export function fmtSlot(slot: SlotInstance): string {
  return `${slot.date} ${slot.time}`;
}
