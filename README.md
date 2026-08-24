# T.O.R.E. — The Obscure Refrigerator Entity

Bot Telegram **personale** per gestire dispensa e frigo. Registri cosa compri e cosa hai in casa, segni quando apri una confezione, e il bot ti aiuta a **evitare gli sprechi** ricordandoti cosa va consumato in fretta e suggerendoti cosa cucinare.

## Personalità

T.O.R.E. è un'unità governativa semi-senziente di monitoraggio della refrigerazione. Parla come un burocrate distopico con ironia secca, e usa una terminologia tecnica tutta sua:

| Termine | Significato |
|---|---|
| `CURRENT SPECIMENS` | inventario |
| `ANOMALIES` | alimenti urgenti / scaduti |
| `EXPIRATION EVENTS` | scadenze / aperture |
| `CONSUMPTION RECORDS` | consumi |
| `ENTITY MEMORY` | storico eventi |
| `RECOMMENDATIONS` | suggerimenti ricette |

I prompt con personalità e terminologia sono in `src/persona.ts`.

## Cosa fa

- **Inventario** — tieni traccia di cosa hai in casa, diviso per frigo / freezer / dispensa.
- **Aperture** — segna quando apri una confezione ("ho aperto il pesto") e il bot stima entro quanti giorni va consumata.
- **Anti-spreco** — evidenzia gli alimenti aperti da più tempo o in scadenza (🔴 da finire subito, 🟠 scade a breve).
- **Suggerimenti ricette** — "cosa cucino stasera? veloce e proteico": il bot legge l'inventario e propone ricette usando prima gli alimenti urgenti.
- **Solo tu** — il bot risponde esclusivamente al tuo Telegram user ID (`OWNER_USER_ID`).

## Come funziona

Il bot combina tre componenti:

1. **[grammY](https://grammy.dev/)** per l'interfaccia Telegram (long-polling, niente IP pubblico).
2. **SQLite** ([better-sqlite3](https://github.com/WiseLibs/better-sqlite3)) per i dati, salvati in locale.
3. **Un LLM** per due compiti:
   - *capire i messaggi in linguaggio naturale* e trasformarli in azioni strutturate (aggiungi / apri / finisci / elimina / lista / suggerisci);
   - *generare le ricette* usando l'inventario corrente.

Di default usa **OpenCode Go** (`https://opencode.ai/zen/go/v1`), ma qualunque endpoint OpenAI-compatibile va bene cambiando `LLM_BASE_URL` e `LLM_MODEL`.

## Prerequisiti

- Node.js 18+
- Un bot Telegram creato con [@BotFather](https://t.me/BotFather) (comando `/newbot`)
- Il tuo Telegram user ID (chiedilo a [@userinfobot](https://t.me/userinfobot))
- Una chiave API per l'LLM (es. OpenCode Go da https://opencode.ai/auth)

## Setup

```bash
# 1. Installa le dipendenze
npm install

# 2. Crea il file .env dal template
cp .env.example .env

# 3. Compila i valori in .env (BOT_TOKEN, OWNER_USER_ID, LLM_API_KEY)

# 4. Avvia in sviluppo
npm run dev
```

## Configurazione (`.env`)

| Variabile | Descrizione |
|---|---|
| `BOT_TOKEN` | Token del bot Telegram (da @BotFather) |
| `OWNER_USER_ID` | Il tuo Telegram user ID: **solo** questo utente può usare il bot |
| `LLM_API_KEY` | Chiave API dell'LLM (es. OpenCode Go) |
| `LLM_BASE_URL` | Endpoint OpenAI-compatibile (default OpenCode Go) |
| `LLM_MODEL` | Modello da usare (default `deepseek-v4-flash`) |
| `DATA_DIR` | Cartella del database (default `./data`) |

Con OpenCode Go puoi cambiare modello tra quelli compatibili con `/chat/completions`, ad esempio `hy3`, `glm-5.2`, `kimi-k2.6`, `longcat-2.0`, `mimo-v2.5`.

## Uso

**Comandi:**

| Comando | Descrizione | Esempio |
|---|---|---|
| `/lista` | Cosa c'è in casa, con avvisi di scadenza | `/lista` |
| `/suggerisci [filtri]` | Idee ricette | `/suggerisci veloce e fresco` |
| `/memoria` | Storico eventi (ENTITY MEMORY) | `/memoria` |
| `/apri <nome>` | Segna una confezione come aperta | `/apri pesto` |
| `/finisci <nome>` | Rimuovi un alimento finito | `/finisci latte` |
| `/elimina <nome>` | Rimuovi un alimento | `/elimina pesto` |
| `/aiuto` | Mostra la lista comandi | `/aiuto` |

**Linguaggio naturale** (l'LLM capisce e agisce):

- "ho comprato 3 zucchine e un barattolo di pesto"
- "ho aperto il pesto"  *(il bot stima la durata dopo l'apertura)*
- "ho finito il latte"
- "cosa cucino stasera? veloce e proteico"
- "cosa ho in casa?"

## Dati e privacy

- I dati sono salvati **solo sul server**, in un database SQLite nella cartella `data/`.
- `data/`, `backups/` e `.env` sono **esclusi da git** (vedi `.gitignore`): non finiscono mai nella repository.
- Il backup è **locale** sul server (cartella `backups/`), mai pushato su GitHub.

## Deploy su VPS / Raspberry Pi

```bash
# Sul server
git clone <url-della-repo> ~/tore-bot
cd ~/tore-bot
npm ci
npm run build

# Crea .env con i tuoi valori reali (non committarli!)
cp .env.example .env && nano .env

# Crea le cartelle dati (richieste dal servizio systemd)
mkdir -p data backups

# Installa come servizio systemd
sudo cp torebot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now torebot
sudo journalctl -u torebot -f
```

Se il servizio non è nella home di `ubuntu`, adatta `WorkingDirectory` e `ReadWritePaths` nel file `.service`.

**Aggiornare il bot** (dopo un push su GitHub):

```bash
cd ~/tore-bot && ./deploy.sh
```

**Backup automatico** (copia locale del database, ogni notte alle 3):

```bash
crontab -e
# aggiungi:
0 3 * * * cd ~/tore-bot && ./backup.sh >> backups/backup.log 2>&1
```

## Struttura del progetto

```
src/
  bot.ts        — logica del bot e comandi (grammY)
  config.ts     — lettura e validazione delle variabili d'ambiente
  database.ts   — SQLite: schema e funzioni di accesso
  llm.ts        — chiamate LLM (interpretazione + ricette)
  persona.ts    — identità, tono e terminologia di T.O.R.E.
  logger.ts     — log su console/journal
  types.ts      — tipi condivisi
backup.js       — backup del database (eseguito da backup.sh)
deploy.sh       — aggiornamento sul server
torebot.service — unit systemd
```

## Personalizzazioni

- **Personalità**: modifica `src/persona.ts` per cambiare tono, terminologia e prompt di T.O.R.E.
- **Lingua**: i prompt sono in `src/persona.ts`; per cambiare lingua modifica `INTENT_SYSTEM` e `RECIPE_SYSTEM`.
- **Altro provider LLM**: basta cambiare `LLM_BASE_URL`, `LLM_MODEL` e `LLM_API_KEY` (es. OpenAI, Anthropic-compatibile, Ollama locale).
- **Più utenti autorizzati**: sostituisci il controllo su `OWNER_USER_ID` con una lista di ID.

## Note

- Il bot usa long-polling: non serve aprire porte o avere un IP pubblico.
- `better-sqlite3` di solito ha binari precompilati; se la build nativa fallisce sul tuo server: `sudo apt install build-essential python3`.
