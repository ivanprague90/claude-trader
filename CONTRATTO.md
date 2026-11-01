Lavori in questa cartella, che è vuota. Costruisci da zero un agente che fa **paper trading da solo**,
a orari fissi, senza nessuno davanti allo schermo. Leggi tutto prima di scrivere una riga.

## Obiettivo

Un programma che si sveglia 4 volte al giorno, guarda il conto, decide se comprare o vendere,
esegue, lascia un appunto alla sveglia dopo e mi avvisa su Telegram.
Non mi interessa che guadagni. Mi interessa che **non sbagli mai due volte la stessa cosa**
e che **mi dica sempre la verità** su cosa ha fatto e su cosa si è rotto.

## Vincoli che non si discutono

1. **Solo paper trading.** Endpoint `https://paper-api.alpaca.markets`, scritto nel codice.
   Se qualcuno configura l'endpoint vero, il programma si rifiuta di partire.
2. **Ogni sveglia parte senza memoria.** È un processo nuovo: non ricorda niente.
   Il contesto lo ricostruisce da due fonti sole:
   - **Alpaca** = la verità sui soldi (conto, posizioni, ordini delle ultime 48 ore, mercato aperto o no)
   - **il testimone** `state/baton.json` = la verità sulle intenzioni della sveglia prima
3. **Mai due volte lo stesso ordine.** Anche se la sveglia muore a metà, anche se la lancio due volte.
4. **Le chiavi non si vedono mai**: stanno in `secrets.ts` (ignorato da git), mai nei log,
   mai nei messaggi, mai stampate a schermo. Crea `secrets.example.ts` con i campi vuoti.

## Strumenti

- Bun + TypeScript, **zero dipendenze** esterne (solo `fetch` e le API di Bun).
- Il cervello è **Claude Code in modalità headless** (`claude -p`, con il mio abbonamento),
  senza strumenti, con una risposta **JSON a schema fisso**. Niente chat, niente sessioni.
- Broker: API REST v2 di Alpaca. Canale: un bot Telegram.

## Il giro di una sveglia, in quest'ordine

1. Se esiste `state/run.lock`, la sveglia prima è morta a metà: **riconcilia con Alpaca**
   (quali dei suoi ordini sono partiti davvero) e avvisami su Telegram. Poi crea il tuo lock.
2. Leggi il testimone. Se l'ultima sveglia è troppo vecchia, **dimmi quali sveglie sono saltate**
   (macchina spenta o offline). Non recuperarle: un ordine di ore fa non ha più senso.
3. Chiedi ad Alpaca conto, posizioni, ordini recenti e orologio del mercato.
4. Chiedi al cervello una decisione. Riceve testimone + stato del conto, risponde con:
   `orders` (simbolo, lato, quantità, perché in una frase), `reasoning` (3–5 frasi),
   `planNext` (cosa controllare alla prossima sveglia). Tutto in italiano.
5. Passa la decisione nella **gabbia** (sotto). Il modello propone, il codice dispone.
6. Invia gli ordini ammessi, ognuno con un **id deterministico**:
   `AAAA-MM-GG-HHMM-SIMBOLO-lato` (es. `2026-09-24-1540-SPY-buy`).
   Stessa sveglia + stesso titolo + stesso lato = stesso id, così Alpaca rifiuta il doppione da sola.
   Prima di inviare, se Alpaca ha già un ordine con quell'id, non rimandarlo e scrivilo nel log.
7. Scrivi il testimone nuovo in modo **atomico** (file temporaneo + rename), in italiano semplice,
   e tienine una copia in `state/history/`.
8. Mandami su Telegram il resoconto e togli il lock.

## Le sveglie (ora di Roma, borsa USA 15:30–22:00)

| Ora | Nome | Cosa fa |
|---|---|---|
| 09:00 | briefing | legge il conto e fissa il piano. **Nessun ordine.** |
| 15:40 | apertura | entra o aggiusta |
| 18:30 | metà seduta | controlla, stop loss |
| 21:40 | chiusura | chiude la giornata e scrive il resoconto |

`bun run schedule` controlla l'ora ogni 30 secondi e lancia la sveglia dovuta, solo se è più nuova
dell'ultimo testimone. `bun run once` lancia subito la sveglia più recente di oggi
(`--slot 15:40` per sceglierla, `--force` per rifarla). `bun run status` stampa lock,
ultimo testimone, conto.

## La gabbia (regole nel codice, non nel prompt del modello)

- universo fisso: SPY QQQ IWM AAPL MSFT NVDA GLD TLT — il resto si rifiuta
- massimo 5 titoli in portafoglio, massimo 20% del conto per titolo
- stop loss a −3% dal prezzo di carico: vende **anche se il modello non lo chiede**
- niente short, niente leva, solo azioni intere
- nessun ordine nel briefing o a mercato chiuso

Ogni ordine rifiutato va nel log e nel messaggio, con il motivo.

## Telegram

Ogni messaggio porta l'id della sveglia (`run 2026-09-24-1540`), lo stesso del file di log.
- **Fine sveglia**: ordini inviati, ordini rifiutati e perché, motivazione in 2 righe,
  conto e P&L del giorno, prossima sveglia.
- **Allarmi** (messaggio a parte, con ⚠): sveglia precedente interrotta, sveglie saltate,
  errore del broker o del cervello.
- Se Telegram non risponde, la sveglia non si ferma: lo scrive nel log.

## Per provarlo senza soldi e senza rete

- Un **broker finto** persistito su file, con la stessa interfaccia di quello vero.
- Un **cervello finto** che risponde sempre la stessa cosa.
- Opzione `--fake` su ogni comando per usarli entrambi.

## Test che devono passare (con broker e cervello finti)

1. Stessa sveglia lanciata due volte → un solo ordine per titolo.
2. Processo ucciso dopo il primo ordine → la sveglia dopo trova il lock, riconcilia, non ricompra.
3. Testimone delle 09:00 e poi niente fino alle 21:40 → segnala 15:40 e 18:30 come saltate.
4. Il modello propone un titolo fuori universo, o il 40% del conto su un titolo → rifiutati.
5. Posizione a −4% → la gabbia la vende anche se il modello dice di tenere.
6. Testimone corrotto → vale come "nessun testimone", la sveglia va avanti col broker.

## Come lavori

- Prima di scrivere codice mostrami il **piano in 10 righe** (file e responsabilità), poi procedi
  senza aspettare una mia conferma.
- File piccoli, uno per responsabilità. Commenti solo dove il perché non è ovvio.
- Alla fine lancia `bun test` e correggi finché è verde.
- Chiudi con un **resoconto**: cosa hai costruito, come si lancia, e i **limiti che conosci**
  (scritti chiari, non nascosti). Non committare.
