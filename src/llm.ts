import { config } from "./config";
import { INTENT_SYSTEM, RECIPE_SYSTEM } from "./persona";
import type { Intent, IntentName } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function chat(messages: ChatMessage[]): Promise<string> {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Errore LLM (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Risposta LLM vuota.");
  return content;
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
  const raw = await chat([
    { role: "system", content: INTENT_SYSTEM },
    { role: "user", content: text },
  ]);

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return { intent: "unknown", items: [], query: text };
  }

  const obj = parsed as Record<string, unknown>;
  const intent = (typeof obj.intent === "string" ? obj.intent : "unknown") as IntentName;
  const items = Array.isArray(obj.items)
    ? (obj.items as Array<Record<string, unknown>>).map((i) => ({
        name: typeof i.name === "string" ? i.name : "",
        quantity: typeof i.quantity === "string" ? i.quantity : null,
        location: typeof i.location === "string" ? i.location : null,
        shelf_days_after_open:
          typeof i.shelf_days_after_open === "number" ? i.shelf_days_after_open : null,
      }))
    : [];
  const query = typeof obj.query === "string" ? obj.query : text;

  return { intent, items, query };
}

export async function suggestRecipes(inventoryText: string, query: string): Promise<string> {
  return chat([
    { role: "system", content: RECIPE_SYSTEM },
    {
      role: "user",
      content: `CURRENT SPECIMENS:\n${inventoryText || "(nessuno specimen registrato)"}\n\nRICHIESTA OPERATORE:\n${query}`,
    },
  ]);
}
