import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export type FileBackup = { existed: boolean; content?: string };

export type FileHistoryState = {
  snapshots: Record<string, Record<string, FileBackup>>;
};

export type RestoreResult = { restored: string[]; deleted: string[] };

export function createFileHistory(): FileHistoryState {
  return { snapshots: {} };
}

export function beginTurn(state: FileHistoryState, turnId: string, previousTurnId?: string): void {
  const snap: Record<string, FileBackup> = {};
  const base = previousTurnId ? state.snapshots[previousTurnId] : undefined;
  if (base) {
    for (const path of Object.keys(base)) snap[path] = readDisk(path);
  }
  state.snapshots[turnId] = snap;
}

export function trackBeforeWrite(state: FileHistoryState, turnId: string, filePath: string): void {
  const path = trackingPath(filePath);
  const snap = state.snapshots[turnId];
  if (!snap || snap[path]) return;
  snap[path] = readDisk(path);
}

export function restoreToTurn(state: FileHistoryState, turnId: string): RestoreResult {
  const snap = state.snapshots[turnId];
  if (!snap) return { restored: [], deleted: [] };

  const ever = new Set<string>();
  for (const one of Object.values(state.snapshots)) {
    for (const path of Object.keys(one)) ever.add(path);
  }

  const restored: string[] = [];
  const deleted: string[] = [];
  for (const path of ever) {
    const backup = snap[path];
    if (!backup) {
      if (existsSync(path)) {
        unlinkSync(path);
        deleted.push(path);
      }
      continue;
    }
    if (!backup.existed) {
      if (existsSync(path)) {
        unlinkSync(path);
        deleted.push(path);
      }
      continue;
    }
    const dir = dirname(path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, backup.content ?? "");
    restored.push(path);
  }

  return { restored, deleted };
}

export function dropTurnsAfter(state: FileHistoryState, keepIds: Set<string>): void {
  for (const id of Object.keys(state.snapshots)) {
    if (!keepIds.has(id)) delete state.snapshots[id];
  }
}

function trackingPath(filePath: string): string {
  const abs = resolve(process.cwd(), filePath);
  const rel = relative(process.cwd(), abs);
  return rel.startsWith("..") ? abs : rel || filePath;
}

function readDisk(path: string): FileBackup {
  if (!existsSync(path)) return { existed: false };
  try {
    return { existed: true, content: readFileSync(path, "utf-8") };
  } catch {
    return { existed: false };
  }
}
