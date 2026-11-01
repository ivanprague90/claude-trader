import { HTTP_TIMEOUT_MS } from "./config.ts";
import type { Logger } from "./log.ts";
import type { Notifier } from "./types.ts";

const MAX_LEN = 4000; // Telegram accetta 4096 caratteri

/** Telegram. Se non risponde, la sveglia non si ferma: lo scrive nel log e basta. */
export class TelegramNotifier implements Notifier {
  constructor(
    private token: string,
    private chatId: string,
    private log: Logger,
    private f: typeof fetch = fetch,
  ) {}

  async send(text: string): Promise<boolean> {
    try {
      const res = await this.f(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        body: JSON.stringify({ chat_id: this.chatId, text: text.slice(0, MAX_LEN), disable_web_page_preview: true }),
      });
      if (!res.ok) {
        this.log.line("telegram", `messaggio non inviato: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      // il messaggio d'errore di fetch può contenere l'URL con il token: il Logger lo maschera
      this.log.line("telegram", `messaggio non inviato: ${(e as Error).message}`);
      return false;
    }
  }
}

/** Per la prova con --fake e per i test: stampa invece di inviare, e tiene i messaggi. */
export class ConsoleNotifier implements Notifier {
  messages: string[] = [];
  constructor(private print: ((text: string) => void) | null = (t) => console.log(t)) {}

  async send(text: string): Promise<boolean> {
    this.messages.push(text);
    this.print?.(`[telegram ] (finto, non inviato)\n${text.split("\n").map((l) => `    ${l}`).join("\n")}`);
    return true;
  }
}
