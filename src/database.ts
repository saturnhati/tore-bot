import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { EventType, InventoryEvent, Item, Location } from "./types";

let db: Database.Database;

export function init(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      location TEXT NOT NULL DEFAULT 'dispensa',
      quantity TEXT,
      opened_at TEXT,
      expires_at TEXT,
      shelf_days_after_open INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_name TEXT NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function now(): string {
  return new Date().toISOString();
}

function normalizeLocation(location?: string | null): Location {
  const l = (location ?? "").toLowerCase().trim();
  if (l.includes("freezer") || l.includes("congel")) return "freezer";
  if (l.includes("frig") || l.includes("fridge")) return "frigo";
  return "dispensa";
}

function logEvent(itemName: string, type: EventType, note: string | null = null): void {
  db.prepare("INSERT INTO events (item_name, type, note, created_at) VALUES (?, ?, ?, ?)").run(
    itemName,
    type,
    note,
    now(),
  );
}

export function addItem(input: {
  name: string;
  quantity?: string | null;
  location?: string | null;
  category?: string | null;
}): Item {
  const name = input.name.trim();
  const info = db
    .prepare(
      "INSERT INTO items (name, category, location, quantity, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(name, input.category ?? null, normalizeLocation(input.location), input.quantity ?? null, now());
  logEvent(name, "bought", input.quantity ?? null);
  return getItem(Number(info.lastInsertRowid))!;
}

export function getItem(id: number): Item | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item | undefined;
}

export function findItemsByName(name: string): Item[] {
  const n = `%${name.trim().toLowerCase()}%`;
  return db
    .prepare("SELECT * FROM items WHERE lower(name) LIKE ? ORDER BY created_at DESC")
    .all(n) as Item[];
}

export function openItem(id: number, shelfDays: number | null = null): Item | undefined {
  const item = getItem(id);
  if (!item) return undefined;
  db.prepare("UPDATE items SET opened_at = ?, shelf_days_after_open = ? WHERE id = ?").run(
    now(),
    shelfDays ?? item.shelf_days_after_open,
    id,
  );
  logEvent(item.name, "opened", shelfDays ? `dura ${shelfDays} giorni da aperto` : null);
  return getItem(id);
}

export function consumeItem(id: number): Item | undefined {
  const item = getItem(id);
  if (!item) return undefined;
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  logEvent(item.name, "consumed");
  return item;
}

export function removeItem(id: number): Item | undefined {
  const item = getItem(id);
  if (!item) return undefined;
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  logEvent(item.name, "removed");
  return item;
}

export function listItems(): Item[] {
  return db.prepare("SELECT * FROM items ORDER BY location, lower(name)").all() as Item[];
}

export function recentEvents(limit = 20): InventoryEvent[] {
  return db
    .prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?")
    .all(limit) as InventoryEvent[];
}

export function countItems(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number };
  return row.n;
}

export function close(): void {
  db?.close();
}
