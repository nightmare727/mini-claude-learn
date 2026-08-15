import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserTurn } from "./agent.js";
import type { FileHistoryState } from "./file-history.js";
import type { Message } from "./types.js";

export type SessionState = {
  version?: 2;
  messages: Message[];
  userTurns: UserTurn[];
  fileHistory: FileHistoryState;
};

function sessionFile(): string {
  return join(process.cwd(), ".mini-session.json");
}

export function saveSession(state: SessionState | Message[]): void {
  try {
    const payload: SessionState = Array.isArray(state)
      ? { version: 2, messages: state, userTurns: [], fileHistory: { snapshots: {} } }
      : state;
    writeFileSync(sessionFile(), JSON.stringify(payload, null, 2));
  } catch {
    // session persistence is best-effort
  }
}

export function loadSession(): SessionState | null {
  const file = sessionFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as SessionState | Message[];
    if (Array.isArray(parsed)) {
      return { version: 2, messages: parsed, userTurns: [], fileHistory: { snapshots: {} } };
    }
    return {
      version: 2,
      messages: parsed.messages ?? [],
      userTurns: parsed.userTurns ?? [],
      fileHistory: parsed.fileHistory ?? { snapshots: {} },
    };
  } catch {
    return null;
  }
}

export function sessionPath(): string {
  return sessionFile();
}

export function appendSessionJsonl(event: Record<string, unknown>): void {
  try {
    appendFileSync(join(process.cwd(), ".mini-session.jsonl"), `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
  } catch {
    // best-effort audit log
  }
}
