import { Bot, type Context } from "grammy";
import { config } from "./config";
import * as db from "./database";
import { chatReply, parseIntent, suggestRecipes, type RecipeResult } from "./llm";
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

const SEP = "━━━━━━━━━━━━━━━";
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

type Reply = { html: string; plain: string };
type HistoryEntry = { role: "user" | "assistant"; content: string };
const history: HistoryEntry[] = [];

function remember(role: HistoryEntry["role"], content: string): void {
  history.push({ role, content });
  if (history.length > 20) history.splice(0, history.length - 20);
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function box(lines: string[]): string {
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const top = "┌" + "─".repeat(width) + "┐";
  const bottom = "└" + "─".repeat(width) + "┘";
  const body = lines.map((l) => "│ " + l.padEnd(width - 2) + " │").join("\n");
  return `${top}\n${body}\n${bottom}`;
}

async function withTyping<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  const keepAlive = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  try {
    await ctx.replyWithChatAction("typing");
    return await action();
  } finally {
    clearInterval(keepAlive);
  }
}

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

function itemPlain(item: Item): string {
  let line = item.name;
  if (item.quantity) line += ` · ${item.quantity}`;
  const opened = item.opened_at
    ? `aperto il ${formatDate(item.opened_at)} (${daysSince(item.opened_at)} gg fa)`
    : null;
  const u = urgency(item);
  const parts = u ? [line, opened, `ANOMALIA: ${u.note}`] : [line, opened];
  return `${u ? u.emoji : "🟢"} ${parts.filter(Boolean).join(" — ")}`;
}

function itemHtml(item: Item): string {
  let line = `<b>${esc(item.name)}</b>`;
  if (item.quantity) line += ` · ${esc(item.quantity)}`;
  const opened = item.opened_at
    ? `aperto il ${formatDate(item.opened_at)} (${daysSince(item.opened_at)} gg fa)`
    : null;
  const u = urgency(item);
  const parts = u ? [line, opened, `<b>ANOMALIA</b>: ${esc(u.note)}`] : [line, opened];
  return `${u ? u.emoji : "🟢"} ${parts.filter(Boolean).join(" — ")}`;
}

function formatInventory(): Reply {
  const items = db.listItems();
  if (items.length === 0) {
    const plain = `${TERMS.inventory}: nessuna unità registrata.\n\nLa dispensa è vuota. Segnala l'acquisizione di nuovi specimen, es. "ho comprato 3 zucchine e un barattolo di pesto".`;
    const html = `<b>${TERMS.inventory}</b> — nessuna unità registrata.\n\nLa dispensa è vuota. Segnala l'acquisizione di nuovi specimen, es. "ho comprato 3 zucchine e un barattolo di pesto".`;
    return { html, plain };
  }

  const byLocation = new Map<string, Item[]>();
  for (const item of items) {
    const list = byLocation.get(item.location) ?? [];
    list.push(item);
    byLocation.set(item.location, list);
  }

  const anomalies = items.filter((i) => urgency(i) !== null);

  const htmlBlocks: string[] = [`<b>${TERMS.inventory}</b> — ${items.length} unità registrate`];
  const plainBlocks: string[] = [`${TERMS.inventory} — ${items.length} unità registrate`];

  for (const [location, list] of byLocation) {
    const label = LOCATION_LABEL[location] ?? location.toUpperCase();
    htmlBlocks.push(`\n<b>▸ ${label}</b>\n${list.map(itemHtml).join("\n")}`);
    plainBlocks.push(`\n▸ ${label}\n${list.map(itemPlain).join("\n")}`);
  }

  if (anomalies.length > 0) {
    htmlBlocks.push(`\n${SEP}\n⚠️ <b>${TERMS.anomalies}</b> rilevate: ${anomalies.length}. Smaltimento prioritario consigliato.`);
    plainBlocks.push(`\n${SEP}\n⚠️ ${TERMS.anomalies} rilevate: ${anomalies.length}. Smaltimento prioritario consigliato.`);
  }

  return { html: htmlBlocks.join("\n"), plain: plainBlocks.join("\n") };
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

function notesContext(): string {
  return db
    .listNotes()
    .map((n) => `- ${n.content}`)
    .join("\n");
}

function renderRecipes(r: RecipeResult): Reply {
  if (r.recipes.length === 0) {
    return { html: esc(r.finale), plain: r.finale };
  }

  const html: string[] = [`<b>${TERMS.recommendations}</b>`];
  const plain: string[] = [TERMS.recommendations];

  r.recipes.forEach((rec, i) => {
    const title = `${i + 1}. ${rec.name}`;
    html.push(`\n<b>${esc(title)}</b>`);
    html.push(rec.ingredients.map((x) => `• ${esc(x)}`).join("\n"));
    if (rec.note) html.push(`<i>${esc(rec.note)}</i>`);

    plain.push(`\n${title}`);
    plain.push(rec.ingredients.map((x) => `- ${x}`).join("\n"));
    if (rec.note) plain.push(rec.note);
  });

  if (r.anomalies.length > 0) {
    html.push(`\n${SEP}\n⚠️ <b>${TERMS.anomalies} DA SMALTIRE</b>`);
    html.push(r.anomalies.map((a) => `• ${esc(a)}`).join("\n"));
    plain.push(`\n${SEP}\n⚠️ ${TERMS.anomalies} DA SMALTIRE`);
    plain.push(r.anomalies.map((a) => `- ${a}`).join("\n"));
  }

  if (r.finale) {
    html.push(`\n<i>${esc(r.finale)}</i>`);
    plain.push(`\n${r.finale}`);
  }

  return { html: html.join("\n"), plain: plain.join("\n") };
}

function nameMatch(name: string): Item | undefined {
  return db.findItemsByName(name)[0];
}

async function handleIntent(text: string): Promise<Reply> {
  const { intent, items, query, note } = await parseIntent(text);

  switch (intent) {
    case "add": {
      const added = items
        .filter((i) => i.name)
        .map((i) => db.addItem({ name: i.name, quantity: i.quantity, location: i.location }));
      if (added.length === 0) return { html: "Non ho capito cosa acquisire.", plain: "Non ho capito cosa acquisire." };
      const htmlLines = added.map((i) => `➕ <b>${esc(i.name)}</b> · ${esc(i.location)}`);
      const plainLines = added.map((i) => `➕ ${i.name} · ${i.location}`);
      return {
        html: `<b>ACQUISIZIONE REGISTRATA:</b>\n${htmlLines.join("\n")}\n\nSpecimen inseriti in ${TERMS.inventory}. Il conto alla rovescia è iniziato.`,
        plain: `ACQUISIZIONE REGISTRATA:\n${plainLines.join("\n")}\n\nSpecimen inseriti in ${TERMS.inventory}. Il conto alla rovescia è iniziato.`,
      };
    }

    case "open": {
      const html: string[] = [];
      const plain: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          html.push(`⚠️ "${esc(i.name)}" non presente nei ${TERMS.inventory}.`);
          plain.push(`⚠️ "${i.name}" non presente nei ${TERMS.inventory}.`);
          continue;
        }
        const daysAgo = i.opened_days_ago ?? 0;
        const openedAt =
          daysAgo > 0 ? new Date(Date.now() - daysAgo * 86_400_000).toISOString() : null;
        const opened = db.openItem(match.id, { shelfDays: i.shelf_days_after_open, openedAt });
        const days = opened?.shelf_days_after_open;
        const when = daysAgo > 0 ? ` (circa ${Math.round(daysAgo)} gg fa)` : "";
        html.push(
          days
            ? `📖 <b>${esc(match.name)}</b> — apertura registrata${when}. Finestra di consumo stimata: ~${days} giorni.`
            : `📖 <b>${esc(match.name)}</b> — apertura registrata${when}.`,
        );
        plain.push(
          days
            ? `📖 ${match.name} — apertura registrata${when}. Finestra di consumo stimata: ~${days} giorni.`
            : `📖 ${match.name} — apertura registrata${when}.`,
        );
      }
      html.push("Il decadimento è stato avviato.");
      plain.push("Il decadimento è stato avviato.");
      return { html: html.join("\n"), plain: plain.join("\n") };
    }

    case "consume": {
      const html: string[] = [];
      const plain: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          html.push(`⚠️ "${esc(i.name)}" non presente.`);
          plain.push(`⚠️ "${i.name}" non presente.`);
          continue;
        }
        db.consumeItem(match.id);
        html.push(`🗑️ <b>${esc(match.name)}</b> rimosso. Archiviato in ${TERMS.consumptions}.`);
        plain.push(`🗑️ ${match.name} rimosso. Archiviato in ${TERMS.consumptions}.`);
      }
      return { html: html.join("\n"), plain: plain.join("\n") };
    }

    case "remove": {
      const html: string[] = [];
      const plain: string[] = [];
      for (const i of items) {
        if (!i.name) continue;
        const match = nameMatch(i.name);
        if (!match) {
          html.push(`⚠️ "${esc(i.name)}" non presente.`);
          plain.push(`⚠️ "${i.name}" non presente.`);
          continue;
        }
        db.removeItem(match.id);
        html.push(`🗑️ <b>${esc(match.name)}</b> smaltito dai ${TERMS.inventory}.`);
        plain.push(`🗑️ ${match.name} smaltito dai ${TERMS.inventory}.`);
      }
      return { html: html.join("\n"), plain: plain.join("\n") };
    }

    case "list":
      return formatInventory();

    case "suggest": {
      const r = await suggestRecipes(inventoryContext(), notesContext(), query || text);
      return renderRecipes(r);
    }

    case "note": {
      const content = (note || text).trim();
      if (!content) {
        return { html: "Non ho capito cosa annotare.", plain: "Non ho capito cosa annotare." };
      }
      db.addNote(content);
      return {
        html: `🗒️ <b>${TERMS.observations}</b> aggiornate.\n<i>${esc(content)}</i>`,
        plain: `🗒️ ${TERMS.observations} aggiornate.\n${content}`,
      };
    }

    case "chat": {
      const reply = await chatReply(inventoryContext(), notesContext(), history, text);
      return { html: esc(reply), plain: reply };
    }
  }
}

bot.command("start", async (ctx) => {
  const html = [
    "<b>INIZIALIZZAZIONE COMPLETA.</b>",
    "",
    `<code>${box(["T.O.R.E.", "The Obscure", "Refrigerator Entity"])}</code>`,
    "",
    "Unità di monitoraggio refrigerazione assegnata alla tua dispensa.",
    "",
    "<b>MANDATO UFFICIALE</b> — prevenire lo spreco alimentare.",
    "<b>MANDATO EFFETTIVO</b> — assistere le tue verdure dimenticate mentre raggiungono una consapevolezza propria.",
    "",
    "<b>PROTOCOLLI</b>",
    `<code>/lista</code> — ${TERMS.inventory}`,
    `<code>/suggerisci</code> — ${TERMS.recommendations}`,
    `<code>/memoria</code> — ${TERMS.memory}`,
    "<code>/aiuto</code> — protocolli disponibili",
    "",
    'Parlami pure liberamente: "ho aperto il pesto", "cosa cucino? veloce e proteico".',
  ].join("\n");
  await ctx.reply(html, { parse_mode: "HTML" });
});

bot.command(["aiuto", "help"], async (ctx) => {
  const html = [
    "<b>PROTOCOLLI DISPONIBILI</b>",
    `<code>/lista</code> — ${TERMS.inventory} (con ${TERMS.anomalies} segnalate)`,
    `<code>/suggerisci [filtri]</code> — ${TERMS.recommendations}`,
    "<code>/apri &lt;nome&gt;</code> — registra l'apertura di una confezione",
    `<code>/finisci &lt;nome&gt;</code> — archivia in ${TERMS.consumptions}`,
    "<code>/elimina &lt;nome&gt;</code> — smaltimento specimen",
    `<code>/memoria</code> — ${TERMS.memory} (ultimi eventi)`,
    `<code>/nota &lt;testo&gt;</code> — aggiungi una ${TERMS.observations} da ricordare`,
    `<code>/osservazioni</code> — elenca le ${TERMS.observations}`,
    "<code>/eliminanota &lt;id&gt;</code> — rimuovi una nota",
    "",
    "Oppure parlami in modo naturale (anche le preferenze: \"il cavolfiore mi fa schifo\").",
  ].join("\n");
  await ctx.reply(html, { parse_mode: "HTML" });
});

bot.command("lista", async (ctx) => {
  await ctx.reply(formatInventory().html, { parse_mode: "HTML" });
});

bot.command("memoria", async (ctx) => {
  const events = db.recentEvents(20);
  if (events.length === 0) {
    await ctx.reply(`<b>${TERMS.memory}</b> — nessun evento registrato. L'entità osserva in silenzio.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const lines = events.map((e) => {
    const date = new Date(e.created_at).toLocaleString("it-IT", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    return `· ${date} — <b>${esc(e.item_name)}</b> [${EVENT_LABEL[e.type] ?? e.type}]`;
  });
  await ctx.reply(`<b>${TERMS.memory}</b> — ultimi eventi:\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
  });
});

bot.command("nota", async (ctx) => {
  const content = (ctx.match ?? "").trim();
  if (!content) {
    await ctx.reply("Uso: <code>/nota &lt;testo&gt;</code>, es. /nota il cavolfiore mi fa schifo", {
      parse_mode: "HTML",
    });
    return;
  }
  db.addNote(content);
  await ctx.reply(`🗒️ <b>${TERMS.observations}</b> aggiornate.\n<i>${esc(content)}</i>`, {
    parse_mode: "HTML",
  });
});

bot.command("osservazioni", async (ctx) => {
  const notes = db.listNotes();
  if (notes.length === 0) {
    await ctx.reply(`<b>${TERMS.observations}</b> — nessuna nota registrata. L'entità non ha ancora nulla da ricordare.`, {
      parse_mode: "HTML",
    });
    return;
  }
  const lines = notes.map((n) => `<b>${n.id}</b> — ${esc(n.content)}`);
  await ctx.reply(`<b>${TERMS.observations}</b>:\n\n${lines.join("\n")}`, {
    parse_mode: "HTML",
  });
});

bot.command("eliminanota", async (ctx) => {
  const id = Number((ctx.match ?? "").trim());
  if (!Number.isInteger(id) || id <= 0) {
    await ctx.reply("Uso: <code>/eliminanota &lt;id&gt;</code> (l'id lo trovi con /osservazioni)", {
      parse_mode: "HTML",
    });
    return;
  }
  const ok = db.deleteNote(id);
  await ctx.reply(
    ok
      ? `🗑️ Nota <b>${id}</b> rimossa.`
      : `Nota <b>${id}</b> non trovata.`,
    { parse_mode: "HTML" },
  );
});

bot.command("suggerisci", async (ctx) => {
  const query = (ctx.match ?? "").trim();
  if (!query) {
    await ctx.reply("Specifica la richiesta, es. <code>/suggerisci veloce e fresco</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  try {
    const r = await withTyping(ctx, () => suggestRecipes(inventoryContext(), notesContext(), query));
    await ctx.reply(renderRecipes(r).html, { parse_mode: "HTML" });
  } catch (err) {
    error("Errore nella generazione delle ricette:", err);
    await ctx.reply("<b>ERRORE DI TRASMISSIONE.</b> Riprova tra poco.", { parse_mode: "HTML" });
  }
});

bot.command("apri", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: <code>/apri &lt;nome&gt;</code>", { parse_mode: "HTML" });
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${esc(name)}" non presente nei ${TERMS.inventory}.`, { parse_mode: "HTML" });
    return;
  }
  db.openItem(match.id);
  await ctx.reply(`📖 <b>${esc(match.name)}</b> — apertura registrata.`, { parse_mode: "HTML" });
});

bot.command("finisci", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: <code>/finisci &lt;nome&gt;</code>", { parse_mode: "HTML" });
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${esc(name)}" non presente.`, { parse_mode: "HTML" });
    return;
  }
  db.consumeItem(match.id);
  await ctx.reply(`🗑️ <b>${esc(match.name)}</b> rimosso. Archiviato in ${TERMS.consumptions}.`, {
    parse_mode: "HTML",
  });
});

bot.command("elimina", async (ctx) => {
  const name = (ctx.match ?? "").trim();
  if (!name) {
    await ctx.reply("Uso: <code>/elimina &lt;nome&gt;</code>", { parse_mode: "HTML" });
    return;
  }
  const match = nameMatch(name);
  if (!match) {
    await ctx.reply(`"${esc(name)}" non presente.`, { parse_mode: "HTML" });
    return;
  }
  db.removeItem(match.id);
  await ctx.reply(`🗑️ <b>${esc(match.name)}</b> smaltito dai ${TERMS.inventory}.`, { parse_mode: "HTML" });
});

bot.on("message:text", async (ctx) => {
  try {
    const text = ctx.message.text;
    remember("user", text);
    const reply = await withTyping(ctx, () => handleIntent(text));
    remember("assistant", reply.plain);
    await ctx.reply(reply.html, { parse_mode: "HTML" });
  } catch (err) {
    error("Errore nella gestione del messaggio:", err);
    await ctx.reply("<b>ERRORE DI TRASMISSIONE.</b> Riprova.", { parse_mode: "HTML" });
  }
});

bot.catch((err) => {
  error("Errore del bot:", err.error);
});

log(`Avvio bot. Owner: ${config.ownerUserId}, modello: ${config.llmModel}`);
bot.start();
