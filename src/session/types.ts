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

export interface TelegraphFlowData extends BaseFlowData {
  url?: string;
  path?: string;
  data?: unknown;
  currentLyrics?: string;
}

export interface SessionData {
  mode: SessionMode;
  version: number;
  audio: AudioFlowData;
  search: SearchFlowData;
  edit: EditFlowData;
  lyrics: LyricsFlowData;
  telegraph: TelegraphFlowData;
}

export interface SessionSnapshot {
  mode: string;
  version: number;
  audio: Record<string, unknown>;
  search: Record<string, unknown>;
  edit: Record<string, unknown>;
  lyrics: Record<string, unknown>;
  telegraph: Record<string, unknown>;
}
