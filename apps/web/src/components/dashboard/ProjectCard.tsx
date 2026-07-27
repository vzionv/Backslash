"use client";

import { useState } from "react";
import Link from "next/link";
import {
  Clock,
  FileText,
  Globe2,
  Lock,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils/cn";

import type { ProjectCardData } from "./project-types";

interface ProjectCardProps {
  project: ProjectCardData;
  onEdit: (project: ProjectCardData) => void;
  onDelete: (project: ProjectCardData) => void;
}

interface ProjectCardMenuProps {
  onEdit: () => void;
  onDelete: () => void;
}

function formatRelativeDate(dateString: string): string {
  const difference = Date.now() - new Date(dateString).getTime();
  const minutes = Math.floor(difference / 60_000);
  const hours = Math.floor(difference / 3_600_000);
  const days = Math.floor(difference / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(dateString).toLocaleDateString();
}

function buildStatusColor(status: string | null): string {
  switch (status) {
    case "success":
      return "bg-success";
    case "error":
      return "bg-error";
    case "canceled":
      return "bg-text-muted";
    case "compiling":
    case "queued":
      return "bg-warning";
    default:
      return "bg-text-muted";
  }
}

function buildStatusLabel(status: string | null): string {
  switch (status) {
    case "success":
      return "Built successfully";
    case "error":
      return "Build failed";
    case "canceled":
      return "Build canceled";
    case "compiling":
      return "Compiling";
    case "queued":
      return "Queued";
    default:
      return "No builds";
  }
}

function ProjectCardMenu({ onEdit, onDelete }: ProjectCardMenuProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div
      className="relative"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
        className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
      >
        <MoreVertical className="h-4 w-4" />
      </button>
      {isOpen && (
        <>
          <div
            className="fixed inset-0 z-10"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsOpen(false);
            }}
          />
          <div className="absolute right-0 top-full z-20 mt-1 min-w-[140px] rounded-lg border border-border bg-bg-secondary py-1 shadow-lg">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-text-primary transition-colors hover:bg-bg-elevated"
            >
              <Pencil className="h-4 w-4" />
              Edit
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-sm text-error transition-colors hover:bg-bg-elevated"
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface SharedProjectCardData {
  id: string;
  name: string;
  description: string | null;
  engine: string;
  ownerName: string;
  role: "viewer" | "editor";
  lastBuildStatus: string | null;
  updatedAt: string;
}

interface SharedProjectCardProps {
  project: SharedProjectCardData;
}

export function ProjectCard({ project, onEdit, onDelete }: ProjectCardProps) {
  const statusLabel = buildStatusLabel(project.lastBuildStatus);
  const sharingLabel = project.anyoneShared
    ? project.sharedWithCount > 0
      ? `Public +${project.sharedWithCount}`
      : "Public"
    : project.sharedWithCount > 0
      ? `Shared ${project.sharedWithCount}`
      : "Private";

  return (
    <Link
      href={`/editor/${project.id}`}
      className="group rounded-lg border border-border bg-bg-secondary p-5 transition-colors hover:border-accent/30 hover:bg-bg-elevated/50"
    >
      <div className="flex items-start justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-accent" />
          <h3 className="truncate text-sm font-semibold text-text-primary group-hover:text-accent">
            {project.name}
          </h3>
        </div>
        <ProjectCardMenu
          onEdit={() => onEdit(project)}
          onDelete={() => onDelete(project)}
        />
      </div>

      {project.description && (
        <p className="mt-2 line-clamp-2 text-sm text-text-secondary">
          {project.description}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs font-medium text-text-secondary">
          {project.engine}
        </span>
        {project.labels.map((label) => (
          <span
            key={label.id}
            className="inline-flex items-center rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs font-medium text-text-secondary"
          >
            {label.name}
          </span>
        ))}
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
            project.anyoneShared || project.sharedWithCount > 0
              ? "border-red-500/25 bg-red-500/10 text-red-300"
              : "border-border bg-bg-elevated text-text-muted"
          )}
        >
          {project.anyoneShared || project.sharedWithCount > 0 ? (
            <Globe2 className="h-3 w-3" />
          ) : (
            <Lock className="h-3 w-3" />
          )}
          {sharingLabel}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
          <span
            className={cn("h-2 w-2 rounded-full", buildStatusColor(project.lastBuildStatus))}
            title={statusLabel}
          />
          {statusLabel}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-text-muted">
          <Clock className="h-3 w-3" />
          {formatRelativeDate(project.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

export function SharedProjectCard({ project }: SharedProjectCardProps) {
  const statusLabel = buildStatusLabel(project.lastBuildStatus);

  return (
    <Link
      href={`/editor/${project.id}`}
      className="group rounded-lg border border-border bg-bg-secondary p-5 transition-colors hover:border-accent/30 hover:bg-bg-elevated/50"
    >
      <div className="flex items-start justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-accent" />
          <h3 className="truncate text-sm font-semibold text-text-primary group-hover:text-accent">
            {project.name}
          </h3>
        </div>
        <span className="shrink-0 inline-flex items-center rounded-full border border-border bg-bg-elevated px-2 py-0.5 text-[10px] font-medium text-text-muted">
          {project.role === "editor" ? "Editor" : "Viewer"}
        </span>
      </div>
      {project.description && (
        <p className="mt-2 line-clamp-2 text-sm text-text-secondary">
          {project.description}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs font-medium text-text-secondary">
          {project.engine}
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-text-muted">
          by {project.ownerName}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
          <span
            className={cn("h-2 w-2 rounded-full", buildStatusColor(project.lastBuildStatus))}
            title={statusLabel}
          />
          {statusLabel}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-text-muted">
          <Clock className="h-3 w-3" />
          {formatRelativeDate(project.updatedAt)}
        </span>
      </div>
    </Link>
  );
}
