import { SessionData, SessionMode } from "./types";
import { warn } from "../utils/logger";

export const VALID_TRANSITIONS: Record<SessionMode, SessionMode[] | null> = {
  [SessionMode.IDLE]: null,
  [SessionMode.SEARCH]: [SessionMode.IDLE, SessionMode.AUDIO_DECISION, SessionMode.SEARCH],
  [SessionMode.AUDIO_DECISION]: [SessionMode.IDLE, SessionMode.SEARCH],
  [SessionMode.EDIT_FIELD]: [SessionMode.IDLE],
  [SessionMode.EDIT_LYRICS]: [SessionMode.IDLE],
};

export type CleanupHook = (chatId: number, session: SessionData, bot: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> }) => Promise<void>;

const cleanupHooks: Partial<Record<SessionMode, CleanupHook[]>> = {};

export function captureVersion(session: SessionData) {
  return session.version;
}

export function isStale(session: SessionData, capturedVersion: number) {
  return session.version !== capturedVersion;
}

async function cleanupEdit(chatId: number, session: SessionData, bot: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> }) {
  if (session.edit.promptId !== undefined) {
    try {
      await bot.deleteMessage(chatId, session.edit.promptId);
    } catch (error) {
      warn("Cleanup: failed to delete edit prompt", session.edit.promptId, error);
    }
  }
}

async function cleanupLyrics(chatId: number, session: SessionData, bot: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> }) {
  for (const messageId of session.lyrics.messageIds) {
    try {
      await bot.deleteMessage(chatId, messageId);
    } catch (error) {
      warn("Cleanup: failed to delete lyrics message", messageId, error);
    }
  }

  if (session.edit.promptId !== undefined) {
    try {
      await bot.deleteMessage(chatId, session.edit.promptId);
    } catch (error) {
      warn("Cleanup: failed to delete edit prompt", session.edit.promptId, error);
    }
  }
}

onExitMode(SessionMode.EDIT_FIELD, cleanupEdit);
onExitMode(SessionMode.EDIT_LYRICS, cleanupLyrics);

export async function transition(session: SessionData, toMode: SessionMode, bot: { deleteMessage: (chatId: number, messageId: number) => Promise<unknown> } | null = null, chatId?: number) {
  const oldMode = session.mode;
  if (oldMode === toMode) {
    return true;
  }

  const allowed = VALID_TRANSITIONS[toMode];
  if (allowed !== null && !allowed.includes(oldMode)) {
    warn(`Unexpected transition: ${oldMode} -> ${toMode} (expected from: ${allowed.join(", ")})`);
  }

  session.version += 1;

  if (chatId !== undefined && bot && cleanupHooks[oldMode]) {
    for (const hook of cleanupHooks[oldMode]!) {
      try {
        await hook(chatId, session, bot);
      } catch (error) {
        warn(`Cleanup hook failed for mode ${oldMode}:`, error);
      }
    }
  }

  session.mode = toMode;
  return true;
}

export function onExitMode(mode: SessionMode, callback: CleanupHook) {
  cleanupHooks[mode] = cleanupHooks[mode] ?? [];
  cleanupHooks[mode]!.push(callback);
}

export function inMode(session: SessionData, mode: SessionMode) {
  return session.mode === mode;
}
