export interface ProjectLabel {
  id: string;
  name: string;
  createdAt: string;
  userId: string;
}

export interface LabelDraft {
  id?: string;
  name: string;
}

export interface ProjectCardData {
  id: string;
  name: string;
  description: string | null;
  engine: string;
  mainFile: string;
  lastBuildStatus: string | null;
  sharedWithCount: number;
  anyoneShared: boolean;
  isShared: boolean;
  createdAt: string;
  updatedAt: string;
  labels: ProjectLabel[];
}

export type ProjectTemplate =
  | "blank"
  | "article"
  | "thesis"
  | "beamer"
  | "letter";

export type ProjectEngine =
  | "auto"
  | "pdflatex"
  | "xelatex"
  | "lualatex"
  | "latex";
