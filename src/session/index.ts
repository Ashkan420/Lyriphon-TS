import { createSessionData, resetSessionData, clearAudioState, resetFlow as resetFlowData, snapshotSession } from "./flows";
import { AudioFlowData, EditFlowData, LyricsFlowData, SearchFlowData, TelegraphFlowData, SessionData, SessionMode } from "./types";
import { captureVersion, inMode, isStale } from "./transitions";

export function createSession(): SessionData {
  return createSessionData();
}

export function getSession(session: SessionData | undefined): SessionData {
  return session ?? createSessionData();
}

export function resetSession(): SessionData {
  return createSessionData();
}

export function resetSessionDataEntry(session: SessionData) {
  resetSessionData(session);
}

export function clearAudioStateEntry(session: SessionData) {
  clearAudioState(session);
}

export function resetFlow(flow: AudioFlowData | SearchFlowData | EditFlowData | LyricsFlowData | TelegraphFlowData) {
  resetFlowData(flow as any);
}

export function snapshot(session: SessionData) {
  return snapshotSession(session);
}

export { SessionMode, captureVersion, inMode, isStale };
export type { SessionData };
