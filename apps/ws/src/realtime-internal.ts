export interface InternalBuildStatusEvent {
  type: "build";
  userId: string;
  payload: {
    projectId: string;
    buildId: string;
    status: "queued" | "compiling";
    triggeredByUserId?: string | null;
  };
}

export interface InternalBuildCompleteEvent {
  type: "build";
  userId: string;
  payload: {
    projectId: string;
    buildId: string;
    status: "success" | "error" | "timeout" | "canceled";
    pdfUrl: string | null;
    logs: string;
    durationMs: number;
    errors: unknown[];
    triggeredByUserId?: string | null;
  };
}

export interface InternalFileEvent {
  type: "file";
  payload: {
    type: "file:created" | "file:deleted" | "file:saved" | "file:renamed";
    projectId: string;
    userId: string;
    fileId: string;
    path: string;
    oldPath?: string;
    mainFile?: string;
    isDirectory?: boolean;
  };
}

export interface InternalAccessChangedEvent {
  type: "access";
  payload: {
    projectId: string;
  };
}

export type InternalRealtimeEvent =
  | InternalBuildStatusEvent
  | InternalBuildCompleteEvent
  | InternalFileEvent
  | InternalAccessChangedEvent;
