"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";

import { LabelPicker } from "./LabelPicker";
import type { LabelDraft, ProjectCardData, ProjectLabel } from "./project-types";

interface EditProjectDialogProps {
  open: boolean;
  project: ProjectCardData | null;
  defaultLabels: ProjectLabel[];
  onClose: () => void;
  onUpdated: () => void;
}

export function EditProjectDialog({
  open,
  project,
  defaultLabels,
  onClose,
  onUpdated,
}: EditProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState<LabelDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setDescription(project.description ?? "");
    setLabels(project.labels.map((label) => ({ id: label.id, name: label.name })));
    setError("");
  }, [open, project]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!project) return;

    setSaving(true);
    setError("");
    try {
      const updateResponse = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
        }),
      });
      if (!updateResponse.ok) {
        const payload = await updateResponse.json().catch(() => ({}));
        setError(payload.error || "Failed to update project");
        return;
      }

      const originalByName = new Map(
        project.labels.map((label) => [label.name.trim().toLowerCase(), label])
      );
      const selectedByName = new Map(
        labels.map((label) => [label.name.trim().toLowerCase(), label])
      );
      const labelsToRemove = project.labels.filter(
        (label) => !selectedByName.has(label.name.trim().toLowerCase())
      );
      const labelsToAdd = labels.filter(
        (label) => !originalByName.has(label.name.trim().toLowerCase())
      );

      await Promise.all(
        labelsToRemove.map(async (label) => {
          const response = await fetch("/api/labels/detach", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: project.id, labelId: label.id }),
          });
          if (!response.ok && response.status !== 404) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Failed to detach ${label.name}`);
          }
        })
      );
      await Promise.all(
        labelsToAdd.map(async (label) => {
          const response = await fetch("/api/labels/attach", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: project.id, labelName: label.name }),
          });
          if (!response.ok && response.status !== 409) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.error || `Failed to attach ${label.name}`);
          }
        })
      );

      onUpdated();
      onClose();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Failed to update project"
      );
    } finally {
      setSaving(false);
    }
  };

  if (!open || !project) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-bg-primary p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">Edit Project</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary">
            <X className="h-5 w-5" />
          </button>
        </div>
        {error && <div className="mb-4 rounded-lg bg-error/10 px-4 py-3 text-sm text-error">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="edit-project-name" className="mb-1.5 block text-sm font-medium text-text-secondary">Project name</label>
            <input id="edit-project-name" type="text" value={name} onChange={(event) => setName(event.target.value)} required maxLength={255} className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label htmlFor="edit-project-description" className="mb-1.5 block text-sm font-medium text-text-secondary">Description <span className="font-normal text-text-muted">(optional)</span></label>
            <textarea id="edit-project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="A brief description of your project" className="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent" />
          </div>
          <div>
            <label htmlFor="edit-project-labels" className="mb-1.5 block text-sm font-medium text-text-secondary">Labels</label>
            <LabelPicker inputId="edit-project-labels" selectedLabels={labels} defaultLabels={defaultLabels} onChange={setLabels} />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-border">Cancel</button>
            <button type="submit" disabled={saving || !name.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Saving...</span> : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
