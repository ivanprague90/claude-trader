# claude-trader: Bun (esegue il trader) + Node con Claude Code (il "cervello", chiamato come `claude -p`).
# Le chiavi NON stanno nell'immagine: arrivano come variabili d'ambiente (vedi docker-compose.yml).

FROM oven/bun:1 AS bun

FROM node:22-slim

# Versione di Claude Code: "latest" a ogni build. Per fissarla: --build-arg CLAUDE_CODE_VERSION=2.1.316
ARG CLAUDE_CODE_VERSION=latest

# tzdata e ca-certificates: ora di Roma nei log e HTTPS verso Alpaca / Telegram
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node test ./test

# state/ e logs/ esistono già e sono di `node`: così i volumi con nome ne ereditano i permessi
RUN mkdir -p /app/state /app/logs && chown -R node:node /app

USER node
ENV TZ=Europe/Rome \
    NODE_ENV=production

# Sempre acceso: controlla l'ora ogni 30 secondi e lancia la sveglia dovuta
CMD ["bun", "src/cli.ts", "schedule"]
