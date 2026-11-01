import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Log di una sveglia: un file per sveglia (logs/<run id>.log) più l'eco sul terminale.
 * Le chiavi vengono sostituite da *** ovunque: nel log, a schermo e nei messaggi d'errore.
 */
export class Logger {
  constructor(
    private file: string | null,
    private secrets: string[] = [],
    private echo: (line: string) => void = (l) => console.log(l),
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  redact(text: string): string {
    let t = text;
    for (const s of this.secrets) if (s && s.length >= 6) t = t.split(s).join("***");
    return t;
  }

  line(tag: string, message: string): void {
    const msg = this.redact(message);
    const shown = `[${tag.padEnd(9)}] ${msg}`;
    this.echo(shown);
    if (this.file) {
      try {
        appendFileSync(this.file, `${new Date().toISOString()} ${shown}\n`);
      } catch {
        /* il log non deve mai fermare la sveglia */
      }
    }
  }
}
