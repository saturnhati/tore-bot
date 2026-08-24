import { config } from "./config";
import { log } from "./logger";
import { CHAT_SYSTEM, INTENT_SYSTEM, RECIPE_SYSTEM } from "./persona";
import type { Intent, IntentName } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Recipe {
  name: string;
  ingredients: string[];
  note: string;
}

export interface RecipeResult {
  recipes: Recipe[];
  anomalies: string[];
  finale: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chat(messages: ChatMessage[]): Promise<string> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.llmApiKey}`,
        },
        body: JSON.stringify({
          model: config.llmModel,
          messages,
          temperature: 0.3,
        }),
      });
    } catch (err) {
      if (attempt === maxAttempts) {
        throw new Error(`Errore di rete verso l'LLM: ${(err as Error).message}`);
      }
      log(`LLM: errore di rete — nuovo tentativo ${attempt + 1}/${maxAttempts}`);
      await sleep(attempt * 1000);
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error("Risposta LLM vuota.");
      return content;
    }

    const body = await res.text();
    const message = `Errore LLM (${res.status}): ${body.slice(0, 500)}`;
    const isClientError = res.status >= 400 && res.status < 500;
    if (isClientError || attempt === maxAttempts) {
      throw new Error(message);
    }
    log(`LLM: ${message} — nuovo tentativo ${attempt + 1}/${maxAttempts}`);
    await sleep(attempt * 1000);
  }

  throw new Error("Errore LLM sconosciuto");
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`JSON non trovato nella risposta LLM: ${candidate.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function parseIntent(text: string): Promise<Intent> {
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const todayHuman = today.toLocaleDateString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const raw = await chat([
    { role: "system", content: `${INTENT_SYSTEM}\n\nDATA DI OGGI: ${todayHuman} (${todayISO}).` },
    { role: "user", content: text },
  ]);

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return { intent: "chat", items: [], query: text, note: "" };
  }

  const obj = parsed as Record<string, unknown>;
  const intent = (typeof obj.intent === "string" ? obj.intent : "chat") as IntentName;
  const items = Array.isArray(obj.items)
    ? (obj.items as Array<Record<string, unknown>>).map((i) => ({
        name: typeof i.name === "string" ? i.name : "",
        quantity: typeof i.quantity === "string" ? i.quantity : null,
        location: typeof i.location === "string" ? i.location : null,
        shelf_days_after_open:
          typeof i.shelf_days_after_open === "number" ? i.shelf_days_after_open : null,
        opened_days_ago: typeof i.opened_days_ago === "number" ? i.opened_days_ago : null,
      }))
    : [];
  const query = typeof obj.query === "string" ? obj.query : text;
  const note = typeof obj.note === "string" ? obj.note : "";

  return { intent, items, query, note };
}

export async function suggestRecipes(
  inventoryText: string,
  notesText: string,
  query: string,
): Promise<RecipeResult> {
  const raw = await chat([
    { role: "system", content: RECIPE_SYSTEM },
    {
      role: "user",
      content: `CURRENT SPECIMENS:\n${inventoryText || "(nessuno specimen registrato)"}\n\nOBSERVATIONS:\n${notesText || "(nessuna)"}\n\nRICHIESTA OPERATORE:\n${query}`,
    },
  ]);

  try {
    const obj = extractJson(raw) as Record<string, unknown>;
    const recipes = Array.isArray(obj.recipes)
      ? (obj.recipes as Array<Record<string, unknown>>).map((r) => ({
          name: typeof r.name === "string" ? r.name : "",
          ingredients: Array.isArray(r.ingredients)
            ? (r.ingredients as unknown[]).filter((x): x is string => typeof x === "string")
            : [],
          note: typeof r.note === "string" ? r.note : "",
        }))
      : [];
    const anomalies = Array.isArray(obj.anomalies)
      ? (obj.anomalies as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    const finale = typeof obj.finale === "string" ? obj.finale : "";

    if (recipes.length === 0 && !finale) {
      return { recipes: [], anomalies: [], finale: raw };
    }
    return { recipes, anomalies, finale };
  } catch {
    return { recipes: [], anomalies: [], finale: raw };
  }
}

export async function chatReply(
  inventoryText: string,
  notesText: string,
  history: ChatMessage[],
  message: string,
): Promise<string> {
  const messages: ChatMessage[] = [{ role: "system", content: CHAT_SYSTEM }, ...history];
  messages.push({
    role: "user",
    content: `CURRENT SPECIMENS:\n${inventoryText || "(nessuno specimen registrato)"}\n\nOBSERVATIONS:\n${notesText || "(nessuna)"}\n\nMESSAGGIO OPERATORE:\n${message}`,
  });
  return chat(messages);
}
