import type { ParsedLogEntry } from "./project";

export type RealtimeAccessRole = "owner" | "viewer" | "editor";

export interface RealtimeAuthorizationRequest {
  projectId: string;
  sessionToken: string | null;
  shareToken: string | null;
}

export interface RealtimeAuthorizationGranted {
  access: true;
  userId: string;
  email: string;
  name: string;
  role: RealtimeAccessRole;
  isAnonymous: boolean;
}

export interface RealtimeAuthorizationDenied {
  access: false;
}

export type RealtimeAuthorizationResponse =
  | RealtimeAuthorizationGranted
  | RealtimeAuthorizationDenied;

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
    errors: ParsedLogEntry[];
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
