import { readFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, writePrivateFile } from "./config.js";

export interface HistoryEntry {
  /** 원고 파일 내용의 SHA-256 */
  sha256: string;
  blog: string;
  mode: "draft" | "published";
  title: string;
  at: string;
}

const HISTORY_FILE = path.join(DATA_DIR, "history.json");

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function findEntry(
  sha256: string,
  blog: string,
): Promise<HistoryEntry | undefined> {
  const entries = await loadHistory();
  const matches = entries.filter((e) => e.sha256 === sha256 && e.blog === blog);
  return matches[matches.length - 1];
}

export async function addEntry(entry: HistoryEntry): Promise<void> {
  const entries = await loadHistory();
  entries.push(entry);
  await writePrivateFile(HISTORY_FILE, JSON.stringify(entries, null, 2));
}
