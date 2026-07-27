"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ProjectCard,
  SharedProjectCard,
} from "@/components/dashboard/ProjectCard";
import {
  Plus,
  FileText,
  Loader2,
  Filter,
  Tag,
} from "lucide-react";
import { NewProjectDialog } from "@/components/dashboard/NewProjectDialog";
import { EditProjectDialog } from "@/components/dashboard/EditProjectDialog";

// ─── Types ──────────────────────────────────────────
interface PrimitiveLabel {
  name: string;
}

interface Label extends PrimitiveLabel {
  id: string;
  createdAt: string;
  userId : string;
}

interface Project {
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
  labels : Label[];
}

interface SharedProject {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  engine: string;
  mainFile: string;
  createdAt: string;
  updatedAt: string;
  ownerName: string;
  ownerEmail: string;
  role: "viewer" | "editor";
  lastBuildStatus: string | null;
}


const DASHBOARD_REFRESH_INTERVAL_MS = Math.max(
  Number(process.env.NEXT_PUBLIC_DASHBOARD_REFRESH_INTERVAL_MS ?? "60000"),
  1_000
);

// ─── Skeleton Card ──────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-border bg-bg-secondary p-5 animate-pulse">
      <div className="flex items-start justify-between">
        <div className="h-5 w-40 rounded bg-bg-elevated" />
        <div className="h-5 w-5 rounded bg-bg-elevated" />
      </div>
      <div className="mt-3 h-4 w-full rounded bg-bg-elevated" />
      <div className="mt-1 h-4 w-3/4 rounded bg-bg-elevated" />
      <div className="mt-4 flex items-center gap-4">
        <div className="h-5 w-16 rounded-full bg-bg-elevated" />
        <div className="h-4 w-20 rounded bg-bg-elevated" />
        <div className="h-4 w-24 rounded bg-bg-elevated" />
      </div>
    </div>
  );
}

// ─── Delete Confirmation Dialog ─────────────────────

interface DeleteDialogProps {
  open: boolean;
  projectName: string;
  onClose: () => void;
  onConfirm: () => void;
  deleting: boolean;
}

function DeleteDialog({
  open,
  projectName,
  onClose,
  onConfirm,
  deleting,
}: DeleteDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-bg-primary p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-primary">
          Delete Project
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          Are you sure you want to delete{" "}
          <span className="font-medium text-text-primary">{projectName}</span>?
          This action cannot be undone.
        </p>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-border disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="rounded-lg bg-error px-4 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-error/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleting ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting...
              </span>
            ) : (
              "Delete"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Filter Labels Dialog ─────────────────────

interface FilterLabelsDialogProps {
  open: boolean;
  onClose: () => void;
  filteredLabels : Label[];
  labels : Label[];
  onSubmit : (labels: Label[]) => void;
}

function FilterLabelsDialog({
  open,
  onClose,
  filteredLabels,
  labels,
  onSubmit
}: FilterLabelsDialogProps) {
  const [selectedLabels, setSelectedLabels] = useState<Label[]>(filteredLabels);

  useEffect(() => {
    setSelectedLabels(filteredLabels);
  }, [filteredLabels, open]);

  if (!open) return null;

  const toggleLabel = (label: Label) => {
    setSelectedLabels((prev) => {
      const exists = prev.some((l) => l.id === label.id);
      if (exists) return prev.filter((l) => l.id !== label.id);
      return [...prev, label];
    });
  };

  const isSelected = (label: Label) =>
    selectedLabels.some((l) => l.id === label.id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-sm rounded-lg border border-border bg-bg-primary p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-text-primary">
          Filter Labels
        </h2>

        <p className="mt-1 text-sm text-text-muted">
          Select one or more labels to filter projects.
        </p>

        <div className="mt-4 max-h-72 overflow-y-auto pr-1">
          {labels.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-bg-secondary/50 px-3 py-6 text-center text-sm text-text-muted">
              No labels available.
            </div>
          ) : (
            <div className="space-y-3">
              {labels.map((label) => {
                const selected = isSelected(label);

                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors ${
                      selected
                        ? "border-accent bg-accent/20 text-text-primary"
                        : "border-border bg-bg-primary text-text-secondary hover:bg-bg-secondary"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Tag className="h-4 w-4"/>
                      <span>{label.name}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>


        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-lg border border-border bg-bg-primary px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-secondary"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={() => onSubmit(selectedLabels)}
            className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard Page ─────────────────────────────────

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  const [editTarget, setEditTarget] = useState<Project | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [labels, setLabels] = useState<Label[]>([]);
  const [filteredLabels, setFilteredLabels] = useState<Label[]>([]);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
        setSharedProjects(data.sharedProjects ?? []);
      }
    } catch {
      // Silently fail -- user sees empty state
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLabels = useCallback(async () => {
    try {
      const res = await fetch("/api/labels", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setLabels(data.labels);
      }
    } catch {
      // Silently fail -- user sees no labels
    }
  }, []);

  const fetchAll = useCallback(() => {
    fetchProjects();
    fetchLabels();
  }, [fetchProjects, fetchLabels]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      fetchAll();
    }, DASHBOARD_REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [fetchAll]);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    try {
      const res = await fetch(`/api/projects/${deleteTarget.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setProjects((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      }
    } catch {
      // Silently fail
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  const filteredProjects = useMemo(() => {
    if (filteredLabels.length === 0) return projects;
    return projects.filter((project) =>
      filteredLabels.every((label) =>
        project.labels.some((projectLabel) => projectLabel.id === label.id)
      )
    );
  }, [filteredLabels, projects]);

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">My Projects</h1>
          <p className="mt-1 text-sm text-text-secondary">
            Manage your LaTeX documents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
          type="button"
          onClick={() => setShowFilterDialog(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
        >
          <Filter className="h-4 w-4" />
          
          {filteredLabels.length > 0 && (<span>Filter Labels ({filteredLabels.length})</span>)}
          {filteredLabels.length === 0 && (<span>Filter Labels</span>)}
        </button>
        <button
          type="button"
          onClick={() => setShowNewDialog(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" />
          New Project
        </button>
        </div>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && projects.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-secondary/50 px-6 py-16">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-elevated">
            <FileText className="h-7 w-7 text-text-muted" />
          </div>
          <h3 className="mt-4 text-lg font-medium text-text-primary">
            No projects yet
          </h3>
          <p className="mt-1 text-sm text-text-secondary">
            Create your first project to get started.
          </p>
          <button
            type="button"
            onClick={() => setShowNewDialog(true)}
            className="mt-6 flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
        </div>
      )}

      {/* Project Grid */}
      {!loading && filteredProjects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onEdit={setEditTarget}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {!loading && filteredProjects.length === 0 && projects.length > 0 && 
        (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-bg-secondary/50 px-6 py-16">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-bg-elevated">
            <Filter className="h-7 w-7 text-text-muted" />
          </div>
          <h3 className="mt-4 text-lg font-medium text-text-primary">
            Your filter returned no results
          </h3>
          <p className="mt-1 text-sm text-text-secondary">
            Please refine your search, or create a project which matches the selected labels.
          </p>
          <button
            type="button"
            onClick={() => setShowFilterDialog(true)}
            className="mt-6 flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
          >
            <Filter className="h-4 w-4" />
            Filter Labels
          </button>
          <button
            type="button"
            onClick={() => setShowNewDialog(true)}
            className="mt-6 flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" />
            New Project
          </button>
          </div>
        )
      }

      {/* Shared with me section */}
      {!loading && sharedProjects.length > 0 && (
        <div className="mt-10">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-text-primary">
              Shared with me
            </h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              Projects others have shared with you
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sharedProjects.map((project) => (
              <SharedProjectCard key={project.id} project={project} />
            ))}
          </div>
        </div>
      )}

      {/* Dialogs */}
      <NewProjectDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        onCreated={fetchAll}
        defaultLabels={labels}
      />

      <EditProjectDialog
        open={editTarget !== null}
        project={editTarget}
        defaultLabels={labels}
        onClose={() => setEditTarget(null)}
        onUpdated={fetchAll}
      />

      <DeleteDialog
        open={deleteTarget !== null}
        projectName={deleteTarget?.name ?? ""}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        deleting={deleting}
      />

      <FilterLabelsDialog
        open={showFilterDialog}
        onClose={() => setShowFilterDialog(false)}
        onSubmit={filtered => {
          setFilteredLabels(filtered);
          setShowFilterDialog(false);
        }}
        filteredLabels={filteredLabels}
        labels={labels}
      >
      </FilterLabelsDialog>
    </>
  );
}
