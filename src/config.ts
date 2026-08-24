import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Variabile d'ambiente mancante: ${name}. Copia .env.example in .env e compilala.`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  ownerUserId: Number(required("OWNER_USER_ID")),
  llmApiKey: required("LLM_API_KEY"),
  llmBaseUrl: optional("LLM_BASE_URL", "https://opencode.ai/zen/go/v1").replace(/\/+$/, ""),
  llmModel: optional("LLM_MODEL", "deepseek-v4-flash"),
  dataDir: optional("DATA_DIR", "./data"),
  dbPath: path.join(optional("DATA_DIR", "./data"), "dispensa.db"),
};

if (!Number.isInteger(config.ownerUserId) || config.ownerUserId <= 0) {
  throw new Error("OWNER_USER_ID deve essere un numero intero positivo (il tuo Telegram user ID).");
}
