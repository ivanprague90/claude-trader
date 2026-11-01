// Copia questo file in secrets.ts (cp secrets.example.ts secrets.ts) e riempi i campi.
// secrets.ts è ignorato da git: le chiavi stanno solo lì.
// In alternativa, per Docker: variabili d'ambiente con gli stessi nomi.

export const secrets = {
  // app.alpaca.markets → Paper Trading → API Keys (le chiavi del conto PAPER, non del conto vero)
  ALPACA_KEY_ID: "",
  ALPACA_SECRET_KEY: "",
  // @BotFather → /newbot
  TELEGRAM_BOT_TOKEN: "",
  // scrivi al bot, poi apri https://api.telegram.org/bot<TOKEN>/getUpdates e cerca "chat":{"id":
  TELEGRAM_CHAT_ID: "",
  // solo su un server, dove nessuno ha fatto il login: claude setup-token
  CLAUDE_CODE_OAUTH_TOKEN: "",
};
