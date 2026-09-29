import { AudioFlowData, DbBrowserState, EditFlowData, LyricsFlowData, MigrationState, SearchFlowData, SessionData, SessionMode, TelegraphFlowData } from "./types";

export function createAudioFlow(): AudioFlowData {
  return {
    locked: false,
    fileId: undefined,
    title: undefined,
    artist: undefined,
    messageId: undefined,
    caption: undefined,
    pendingDecision: undefined,
    pendingFileId: undefined,
    pendingCaption: undefined,
    pendingTelegraphUrl: undefined,
    sendChannelPromptId: undefined,
  };
}

export function createSearchFlow(): SearchFlowData {
  return {
    locked: false,
    results: undefined,
    page: 0,
  };
}

export function createEditFlow(): EditFlowData {
  return {
    locked: false,
    field: undefined,
    promptId: undefined,
  };
}

export function createLyricsFlow(): LyricsFlowData {
  return {
    locked: false,
    buffer: [],
    messageIds: [],
  };
}

export function createDbBrowserState(): DbBrowserState {
  return {
    locked: false,
    awaitingQuery: undefined,
    collectingLyrics: undefined,
    query: undefined,
    page: undefined,
    trackId: undefined,
    albumMode: undefined,
    candidates: undefined,
    buffer: [],
    messageIds: [],
    promptId: undefined,
  };
}

// Persisted sessions predate dbBrowser — lazily materialize it so handlers
// never touch undefined. This is the ONLY sanctioned access path.
export function dbBrowserOf(session: SessionData): DbBrowserState {
  if (!session.dbBrowser) {
    session.dbBrowser = createDbBrowserState();
  }
  return session.dbBrowser;
}

// Clear transient browser state; keeps whatever list/record context the
// browser is in so Back navigation keeps working.
export function resetDbBrowserInput(db: DbBrowserState) {
  db.awaitingQuery = undefined;
  db.awaitingCustomSearch = undefined;
  db.collectingLyrics = undefined;
  db.buffer = [];
  db.messageIds = [];
  db.promptId = undefined;
  db.candidates = undefined;
  db.customQuery = undefined;
}

export function createMigrationState(): MigrationState {
  return {
    phase: "idle",
    channelId: undefined,
    channelIdList: undefined,
    nextOffsetId: undefined,
    scanExhausted: undefined,
    readingMessageId: undefined,
    cursorId: undefined,
    added: 0,
    declined: 0,
    edited: 0,
    failed: 0,
    returnArmed: false,
    cardMessageId: undefined,
    researchResults: undefined,
    researchPromptId: undefined,
  };
}

// Persisted sessions predate migration — lazily materialize it so handlers
// never touch undefined. This is the ONLY sanctioned access path, matching
// dbBrowserOf().
export function migrationOf(session: SessionData): MigrationState {
  if (!session.migration) {
    session.migration = createMigrationState();
  }
  return session.migration;
}

// Clear the run back to idle. Called when a run finishes, is cancelled, or is
// abandoned — counters included, since scan_queue.outcome is the authoritative
// record and these only mirror it for the summary.
export function resetMigrationInput(m: MigrationState) {
  m.phase = "idle";
  m.channelId = undefined;
  m.channelIdList = undefined;
  m.nextOffsetId = undefined;
  m.scanExhausted = undefined;
  m.readingMessageId = undefined;
  m.cursorId = undefined;
  m.added = 0;
  m.declined = 0;
  m.edited = 0;
  m.failed = 0;
  m.returnArmed = false;
  m.cardMessageId = undefined;
  m.researchResults = undefined;
  m.researchPromptId = undefined;
}

export function createTelegraphFlow(): TelegraphFlowData {
  return {
    locked: false,
    url: undefined,
    path: undefined,
    data: undefined,
    originalLyrics: undefined,
    translatedLyrics: undefined,
    activeLang: undefined,
    sourceLang: undefined,
    translationRequestId: undefined,
    isTranslating: false,
    translateMessageId: undefined,
    translationCooldownUntil: undefined,
    pendingTranslationLang: undefined,
    languageAnalysis: undefined,
    bridgeReqToken: undefined,
  };
}

export function createSessionData(): SessionData {
  return {
    mode: SessionMode.IDLE,
    version: 0,
    audio: createAudioFlow(),
    search: createSearchFlow(),
    edit: createEditFlow(),
    lyrics: createLyricsFlow(),
    telegraph: createTelegraphFlow(),
    dbBrowser: createDbBrowserState(),
    migration: createMigrationState(),
  };
}

export function resetSessionData(session: SessionData) {
  session.mode = SessionMode.IDLE;
  session.version += 1;
  session.audio = createAudioFlow();
  session.search = createSearchFlow();
  session.edit = createEditFlow();
  session.lyrics = createLyricsFlow();
  session.telegraph = createTelegraphFlow();
  session.dbBrowser = createDbBrowserState();
  session.migration = createMigrationState();
}

export function clearAudioState(session: SessionData) {
  session.audio.fileId = undefined;
  session.audio.title = undefined;
  session.audio.artist = undefined;
  session.audio.messageId = undefined;
}

export function resetFlow(flow: AudioFlowData | SearchFlowData | EditFlowData | LyricsFlowData | TelegraphFlowData) {
  if ("fileId" in flow) {
    flow.fileId = undefined;
    flow.title = undefined;
    flow.artist = undefined;
    flow.messageId = undefined;
    flow.caption = undefined;
    flow.pendingDecision = undefined;
    flow.pendingFileId = undefined;
    flow.pendingCaption = undefined;
    flow.pendingTelegraphUrl = undefined;
    flow.sendChannelPromptId = undefined;
    flow.locked = false;
    return;
  }
  if ("page" in flow) {
    flow.page = 0;
    flow.results = undefined;
    flow.locked = false;
    return;
  }
  if ("field" in flow) {
    flow.field = undefined;
    flow.promptId = undefined;
    flow.locked = false;
    return;
  }
  if ("buffer" in flow) {
    flow.buffer = [];
    flow.messageIds = [];
    flow.locked = false;
    return;
  }
  if ("url" in flow) {
    flow.url = undefined;
    flow.path = undefined;
    flow.data = undefined;
    flow.originalLyrics = undefined;
    flow.translatedLyrics = undefined;
    flow.activeLang = undefined;
    flow.sourceLang = undefined;
    flow.translationRequestId = undefined;
    flow.isTranslating = false;
    flow.translateMessageId = undefined;
    flow.translationCooldownUntil = undefined;
    flow.pendingTranslationLang = undefined;
    flow.languageAnalysis = undefined;
    flow.bridgeReqToken = undefined;
    flow.locked = false;
    return;
  }
}

export function snapshotSession(session: SessionData) {
  return {
    mode: session.mode,
    version: session.version,
    audio: { ...session.audio },
    search: { ...session.search },
    edit: { ...session.edit },
    lyrics: { ...session.lyrics },
    telegraph: { ...session.telegraph },
    dbBrowser: { ...session.dbBrowser },
    migration: { ...session.migration },
  };
}
