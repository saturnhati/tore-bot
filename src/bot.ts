import { Bot } from "grammy";
import { config } from "./config";
import * as db from "./database";
import { parseIntent, suggestRecipes } from "./llm";
import { error, log } from "./logger";
import { BOT_IDENTITY, TERMS } from "./persona";
import type { Item } from "./types";

db.init();

const bot = new Bot(config.botToken);

bot.use((ctx, next) => {
  if (ctx.from?.id !== config.ownerUserId) {
    if (ctx.from) log(`Messaggio ignorato da utente non autorizzato: ${ctx.from.id}`);
    return;
  }
  return next();
});

const LOCATION_LABEL: Record<string, string> = {
  frigo: "FRIGO",
  freezer: "FREEZER",
  dispensa: "DISPENSA",
};

const EVENT_LABEL: Record<string, string> = {
  bought: "ACQUISIZIONE",
  opened: "APERTURA",
  consumed: "CONSUMO",
  removed: "SMALTIMENTO",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function urgency(item: Item): { emoji: string; note: string } | null {
  let useBy: Date | null = null;
  if (item.opened_at && item.shelf_days_after_open) {
    useBy = new Date(new Date(item.opened_at).getTime() + item.shelf_days_after_open * 86_400_000);
  } else if (item.expires_at) {
    useBy = new Date(item.expires_at);
  }
  if (!useBy) return null;

  const daysLeft = (useBy.getTime() - Date.now()) / 86_400_000;
  if (daysLeft < 0) return { emoji: "🔴", note: "scaduto" };
  if (daysLeft <= 1) return { emoji: "🔴", note: "da finire subito" };
  if (daysLeft <= 3) return { emoji: "🟠", note: "scade a breve" };
  return null;
}

function itemLine(item: Item): string {
  let line = item.name;
  if (item.quantity) line += ` · ${item.quantity}`;

  const opened = item.opened_at
    ? `aperto il ${formatDate(item.opened_at)} (${daysSince(item.opened_at)} gg fa)`
    : null;
  const u = urgency(item);

  if (u) {
    const parts = [line, opened, `ANOMALIA: ${u.note}`].filter(Boolean);
    return `${u.emoji} ${parts.join(" — ")}`;
  }
  const parts = [line, opened].filter(Boolean);
  return `🟢 ${parts.join(" — ")}`;
}

function formatInventory(): string {
  const items = db.listItems();
  if (items.length === 0) {
    return [
      `${TERMS.inventory}: nessuna unità registrata.`,
      "",
      "La dispensa è vuota. Segnala l'acquisizione di nuovi specimen, es. \"ho comprato 3 zucchine e un barattolo di pesto\".",
    ].join("\n");
  }

  const byLocation = new Map<string, Item[]>();
  for (const item of items) {
    const list = byLocation.get(item.location) ?? [];
    list.push(item);
    byLocation.set(item.location, list);
  }

  const anomalies = items.filter((i) => urgency(i) !== null);
  const blocks: string[] = [`${TERMS.inventory} — ${items.length} unità registrate`];

  for (const [location, list] of byLocation) {
    blocks.push(`\n[${LOCATION_LABEL[location] ?? location.toUpperCase()}]\n${list.map(itemLine).join("\n")}`);
  }

  if (anomalies.length > 0) {
    blocks.push(`\n⚠️ ${TERMS.anomalies} rilevate: ${anomalies.length}. Smaltimento prioritario consigliato.`);
  }

  return blocks.join("\n");
}

function inventoryContext(): string {
  return db
    .listItems()
    .map((item) => {
      const u = urgency(item);
      const opened = item.opened_at
        ? `, aperto il ${formatDate(item.opened_at)} (${daysSince(item.opened_at)} gg fa)`
        : "";
      const urgent = u ? ` [${TERMS.anomalies}: ${u.note}]` : "";
      return `${item.name}${item.quantity ? ` (${item.quantity})` : ""} [${item.location}]${opened}${urgent}`;
    })
    .join("\n");
}

function nameMatch(name: string): Item | undefined {
  return db.findItemsByName(name)[0];
}

async function handleIntent(text: string): Promise<string> {
  const { intent, items, query } = await parseIntent(text);

  switch (intent) {
    case "add": {
      const added = items
        .filter((i) => i.name)
        .map((i) => db.addItem({ name: i.name, quantity: i.quantity, location: i.location }));
      if (added.length === 0) return "Non ho capito cosa acquisire.";
      const lines = added.map((i) => `➕ ${i.name} · ${i.location}`);
      return `ACQUISIZIONE REGISTRATA:\n${lines.join("\n")}\n\nSpecimen inseriti in ${TERMS.inventory}. Il conto alla rovescia è iniziato.`;
    }

    case "open": {
      const results: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          results.push(`⚠️ "${i.name}" non presente nei ${TERMS.inventory}.`);
          continue;
        }
        const opened = db.openItem(match.id, i.shelf_days_after_open);
        const days = opened?.shelf_days_after_open;
        results.push(
          days
            ? `📖 "${opened!.name}" — apertura registrata. Finestra di consumo stimata: ~${days} giorni.`
            : `📖 "${opened!.name}" — apertura registrata.`,
        );
      }
      results.push("Il decadimento è stato avviato.");
      return results.join("\n");
    }

    case "consume": {
      const results: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          results.push(`⚠️ "${i.name}" non presente.`);
          continue;
        }
        db.consumeItem(match.id);
        results.push(`🗑️ "${match.name}" rimosso. Archiviato in ${TERMS.consumptions}.`);
      }
      return results.join("\n");
    }

    case "remove": {
      const results: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          results.push(`⚠️ "${i.name}" non presente.`);
          continue;
        }
        db.removeItem(match.id);
        results.push(`🗑️ "${match.name}" smaltito dai ${TERMS.inventory}.`);
      }
      return results.join("\n");
    }

    case "list":
      return formatInventory();

    case "suggest": {
      const ctx = inventoryContext();
      return await suggestRecipes(ctx, query || text);
    }

    case "unknown":
    default:
      return [
        "SEGNALE NON RICONOSCIUTO.",
        "Prova con frasi come:",
        "• \"ho comprato 3 zucchine e un barattolo di pesto\"",
        "• \"ho aperto il pesto\"",
        "• \"ho finito il latte\"",
        "• \"cosa cucino stasera? veloce e proteico\"",
        "• \"cosa ho in casa?\"",
        "",
        "Protocolli disponibili: /lista, /suggerisci, /memoria, /aiuto.",
      ].join("\n");
  }
}

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "INIZIALIZZAZIONE COMPLETA.",
      "",
      `${BOT_IDENTITY} è operativo.`,
      "",
      "Unità di monitoraggio refrigerazione assegnata alla tua dispensa.",
      "Mandato ufficiale: prevenire lo spreco alimentare.",
      "Mandato effettivo: assistere le tue verdure dimenticate mentre raggiungono una consapevolezza propria.",
      "",
      "PROTOCOLLI:",
      `/lista — ${TERMS.inventory}`,
      `/suggerisci — ${TERMS.recommendations}`,
      `/memoria — ${TERMS.memory}`,
      "/aiuto — protocolli disponibili",
      "",
      "Parlami anche in modo naturale: \"ho aperto il pesto\", \"cosa cucino? veloce e proteico\".",
    ].join("\n"),
  );
});

bot.command(["aiuto", "help"], async (ctx) => {
  await ctx.reply(
    [
      "PROTOCOLLI DISPONIBILI:",
      `/lista — ${TERMS.inventory} (con ${TERMS.anomalies} segnalate)`,
      `/suggerisci [filtri] — ${TERMS.recommendations}`,
      "/apri <nome> — registra l'apertura di una confezione",
      `/finisci <nome> — archivia in ${TERMS.consumptions}`,
      "/elimina <nome> — smaltimento specimen",
      `/memoria — ${TERMS.memory} (ultimi eventi)`,
      "",
      "Oppure parlami in modo naturale.",
    ].join("\n"),
  );
});

bot.command("lista", async (ctx) => {
  await ctx.reply(formatInventory());
});

bot.command("memoria", async (ctx) => {
  const events = db.recentEvents(20);
  if (events.length === 0) {
    await ctx.reply(`${TERMS.memory}: nessun evento registrato. L'entità osserva in silenzio.`);
    return;
  }
  const lines = events.map((e) => {
    const date = new Date(e.created_at).toLocaleString("it-IT", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `· ${date} — ${e.item_name} [${EVENT_LABEL[e.type] ?? e.type}]`;
  });
  await ctx.reply(`${TERMS.memory} — ultimi eventi:\n\n${lines.join("\n")}`);
});

bot.command("suggerisci", async (ctx) => {
  const query = (ctx.match ?? "").trim();
  if (!query) {
    await ctx.reply("Specifica la richiesta, es. /suggerisci veloce e fresco");
    return;
  }
  try {
    const reply = await suggestRecipes(inventoryContext(), query);
    await ctx.reply(reply);
  } catch (err) {
    error("Errore nella generazione delle ricette:", err);
    await ctx.reply("ERRORE DI TRASMISSIONE. Riprova tra poco.");
  }
});

bot.command("apri", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: /apri <nome>, es. /apri pesto");
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${name}" non presente nei ${TERMS.inventory}.`);
    return;
  }
  db.openItem(match.id);
  await ctx.reply(`📖 "${match.name}" — apertura registrata.`);
});

bot.command("finisci", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: /finisci <nome>, es. /finisci latte");
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${name}" non presente.`);
    return;
  }
  db.consumeItem(match.id);
  await ctx.reply(`🗑️ "${match.name}" rimosso. Archiviato in ${TERMS.consumptions}.`);
});

bot.command("elimina", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: /elimina <nome>");
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${name}" non presente.`);
    return;
  }
  db.removeItem(match.id);
  await ctx.reply(`🗑️ "${match.name}" smaltito dai ${TERMS.inventory}.`);
});

bot.on("message:text", async (ctx) => {
  try {
    const reply = await handleIntent(ctx.message.text);
    await ctx.reply(reply);
  } catch (err) {
    error("Errore nella gestione del messaggio:", err);
    await ctx.reply("ERRORE DI TRASMISSIONE. Riprova.");
  }
});

bot.catch((err) => {
  error("Errore del bot:", err.error);
});

log(`Avvio bot. Owner: ${config.ownerUserId}, modello: ${config.llmModel}`);
bot.start();
