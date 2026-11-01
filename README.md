# claude-trader

Autonomous paper-trading agent on Alpaca, with a Claude brain running on a fixed schedule. Hard-coded risk rules, idempotent orders and crash-safe state, with Telegram reports.

**Paper trading only.** The Alpaca endpoint is written in the code (`src/config.ts`) and is not configurable: the program refuses to start if anything points elsewhere. This is an experiment on a demo account, not financial advice.

The full specification is in [`CONTRATTO.md`](CONTRATTO.md) (Italian).

## How it works

Four wake-ups a day (Rome time, US market 15:30–22:00): `09:00` briefing (no orders), `15:40` open, `18:30` mid-session, `21:40` close. Every wake-up is a fresh process with no memory:

1. take the lock (`state/run.lock`); if a dead run left one, reconcile it against Alpaca
2. read the baton (`state/baton.json`), report skipped wake-ups
3. read the truth about the money from Alpaca (account, positions, last 48h of orders, market clock)
4. ask the brain (`claude -p`, headless, no tools, fixed JSON schema) for a decision
5. pass it through the **cage** (`src/cage.ts`): the model proposes, the code disposes
6. send the allowed orders, each with a deterministic id `YYYY-MM-DD-HHMM-SYMBOL-side`
7. write the new baton atomically, report on Telegram, release the lock

The cage: fixed universe (SPY QQQ IWM AAPL MSFT NVDA GLD TLT), max 5 positions, max 20% of the account per symbol, stop loss at −3% (sells even if the model doesn't ask), whole shares only, no short, no leverage, no orders in the briefing or with the market closed.

## Setup

```sh
cp secrets.example.ts secrets.ts   # Alpaca paper keys, Telegram bot token + chat id (git-ignored)
bun test                           # must end with zero fail
bun run once --fake --slot 1540    # one wake-up with a fake broker and a fake brain, no network
bun run once --slot 1540           # one real wake-up (Alpaca paper, Telegram, claude -p)
bun run schedule                   # always on: checks the clock every 30 s
bun run status                     # lock, last baton, next wake-up, account
bun run reconcile                  # what happened to an interrupted wake-up
```

Options: `--fake` (fake broker + brain), `--slot 15:40`, `--force` (redo a finished wake-up; order ids prevent duplicates), `--dir <folder>` (where `state/` and `logs/` live).

Requirements: [Bun](https://bun.sh), [Claude Code](https://claude.com/claude-code) logged in (on a server: `claude setup-token` and `CLAUDE_CODE_OAUTH_TOKEN`), an Alpaca paper account, a Telegram bot. Zero runtime dependencies. Keys can also come from environment variables with the same names as in `secrets.example.ts`.

## Run it on a server

`Dockerfile` and `docker-compose.yml` run the scheduler in a container (keys come from a git-ignored `.env`, state and logs live on volumes). A step-by-step guide for AWS, entirely with the AWS CLI (install, launch, update, backup, monitor, delete), is in [`docs/DEPLOY-AWS.md`](docs/DEPLOY-AWS.md).

## Layout

| File | Responsibility |
|---|---|
| `src/config.ts` | every number and rule: endpoint, universe, cage limits, wake-up table |
| `src/time.ts` | Rome time, wake-up calculation, skipped wake-ups |
| `src/broker.ts` | Alpaca REST v2 client (retries, order lookup by id) |
| `src/llm.ts` | the brain: `claude -p`, strict response validation |
| `src/cage.ts` | the cage, a pure function |
| `src/state.ts` | baton (atomic writes, history) and lock (atomic takeover) |
| `src/run.ts` | the life of one wake-up |
| `src/notify.ts`, `src/log.ts` | Telegram and per-run logs (secrets masked as `***`) |
| `src/fake.ts` | fake broker (file-backed, with injectable faults) and fake brain |
| `src/cli.ts` | `once`, `schedule`, `status`, `reconcile` |
| `test/` | contract tests (including a real `kill -9`), hardening tests, unit tests |

| `Dockerfile`, `docker-compose.yml` | container with Bun + Claude Code, volumes for `state/` and `logs/` |
| `deploy/aws/` | EC2 bootstrap (`user-data.sh`) and `.env` generator from SSM Parameter Store (`fetch-env.sh`) |
| `docs/DEPLOY-AWS.md` | the AWS runbook |
