import { AudioFlowData, EditFlowData, LyricsFlowData, SearchFlowData, SessionData, SessionMode, TelegraphFlowData } from "./types";

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
  };
}
