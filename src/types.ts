export type Location = "frigo" | "freezer" | "dispensa";

export interface Item {
  id: number;
  name: string;
  category: string | null;
  location: Location;
  quantity: string | null;
  opened_at: string | null;
  expires_at: string | null;
  shelf_days_after_open: number | null;
  created_at: string;
}

export type EventType = "bought" | "opened" | "consumed" | "removed";

export interface InventoryEvent {
  id: number;
  item_name: string;
  type: EventType;
  note: string | null;
  created_at: string;
}

export type IntentName =
  | "add"
  | "open"
  | "consume"
  | "remove"
  | "list"
  | "suggest"
  | "note"
  | "chat";

export interface IntentItem {
  name: string;
  quantity?: string | null;
  location?: string | null;
  shelf_days_after_open?: number | null;
  opened_days_ago?: number | null;
}

export interface Intent {
  intent: IntentName;
  items: IntentItem[];
  query: string;
  note: string;
}

export interface Note {
  id: number;
  content: string;
  created_at: string;
}
