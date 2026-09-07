export enum SessionMode {
  IDLE = "idle",
  SEARCH = "search",
  AUDIO_DECISION = "audio_decision",
  EDIT_FIELD = "edit_field",
  EDIT_LYRICS = "edit_lyrics",
}

export interface BaseFlowData {
  locked: boolean;
}

export interface AudioFlowData extends BaseFlowData {
  fileId?: string;
  title?: string;
  artist?: string;
  messageId?: number;
  caption?: string;
  pendingDecision?: unknown;
  pendingFileId?: string;
  pendingCaption?: string;
  pendingTelegraphUrl?: string;
  sendChannelPromptId?: number;
}

export interface SearchFlowData extends BaseFlowData {
  results?: unknown[];
  page: number;
}

export interface EditFlowData extends BaseFlowData {
  field?: string;
  promptId?: number;
}

export interface LyricsFlowData extends BaseFlowData {
  buffer: string[];
  messageIds: number[];
}

export interface TranslationCacheEntry {
  originalHash: string;
  text: string;
}

// Owner-only DB browser state. Deliberately NOT a SessionMode: it must not
// clobber an active edit/search flow, and handlers must be safe to enter from
// any mode. Persisted sessions predate this field — always reach it through
// dbBrowserOf() (session/flows.ts), never session.dbBrowser directly.
export interface LyricsCandidate {
  trackName: string;
  artistName: string;
  albumName: string;
  source: "plain" | "synced";
  lyrics: string;
}

export interface DbBrowserState extends BaseFlowData {
  // Text input the browser currently waits for: a search query or lyrics
  // for the manual-set flow. Consumed on first use.
  awaitingQuery?: boolean;
  awaitingCustomSearch?: boolean;
  collectingLyrics?: boolean;
  query?: string;
  page?: number;
  trackId?: number;
  // List browse filter (Recent = all, Missing lyrics = rows with NULL lyrics).
  listFilter?: "all" | "missing";
  // Album filter for the LRCLIB re-fetch search (toggled per record).
  albumMode?: boolean;
  // Free-text LRCLIB search context (q= mode; no album filter).
  customQuery?: string;
  candidates?: LyricsCandidate[];
  // Lyrics being collected via DM messages (manual set), mirror of the
  // edit flow's lyrics buffer.
  buffer: string[];
  messageIds: number[];
  promptId?: number;
  // Home screen's Back row: admin panel vs /db entry (Close).
  fromAdmin?: boolean;
  // Entered via a Telegraph card's 🛠 Cache tools button: Back closes the
  // tools message instead of navigating a list.
  fromCard?: boolean;
}

export interface TelegraphFlowData extends BaseFlowData {
  url?: string;
  path?: string;
  data?: unknown;
  originalLyrics?: string;
  translatedLyrics?: Record<string, TranslationCacheEntry>;
  activeLang?: string;
  sourceLang?: string;
  translationRequestId?: string;
  isTranslating?: boolean;
  translateMessageId?: number;
  translationCooldownUntil?: number;
  pendingTranslationLang?: string;
  languageAnalysis?: import("../services/translation/language-analyzer").LanguageAnalysis;
  multilingualEnabled?: boolean;
  // Token of the in-flight deezload auto-fetch job for this track, if any.
  bridgeReqToken?: string;
  // Times the AI-summary refresh touch has fired for the current page; each
  // refresh appends this many zero-width spaces to the "Lyrics" heading so the
  // Telegraph edit always registers as a content change.
  summaryRefreshCount?: number;
}

export interface SessionData {
  mode: SessionMode;
  version: number;
  audio: AudioFlowData;
  search: SearchFlowData;
  edit: EditFlowData;
  lyrics: LyricsFlowData;
  telegraph: TelegraphFlowData;
  dbBrowser: DbBrowserState;
}

export interface SessionSnapshot {
  mode: string;
  version: number;
  audio: Record<string, unknown>;
  search: Record<string, unknown>;
  edit: Record<string, unknown>;
  lyrics: Record<string, unknown>;
  telegraph: Record<string, unknown>;
  dbBrowser: Record<string, unknown>;
}
