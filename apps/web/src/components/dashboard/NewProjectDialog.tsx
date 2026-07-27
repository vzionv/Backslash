"use client";

import { useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { LabelPicker } from "./LabelPicker";
import type {
  LabelDraft,
  ProjectEngine,
  ProjectLabel,
  ProjectTemplate,
} from "./project-types";

interface NewProjectDialogProps {
  open: boolean;
  defaultLabels: ProjectLabel[];
  onClose: () => void;
  onCreated: () => void;
}

export function NewProjectDialog({
  open,
  defaultLabels,
  onClose,
  onCreated,
}: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("blank");
  const [labels, setLabels] = useState<LabelDraft[]>([]);
  const [engine, setEngine] = useState<ProjectEngine>("auto");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const resetForm = () => {
    setName("");
    setDescription("");
    setTemplate("blank");
    setLabels([]);
    setEngine("auto");
    setError("");
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setCreating(true);

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, template, engine }),
      });
      if (!response.ok) {
        const payload = await response.json();
        setError(payload.error || "Failed to create project");
        return;
      }

      const { project } = await response.json();
      await Promise.all(
        labels.map((label) =>
          fetch("/api/labels/attach", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ labelName: label.name, projectId: project.id }),
          })
        )
      );
      resetForm();
      onCreated();
      onClose();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setCreating(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg rounded-lg border border-border bg-bg-primary p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">New Project</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-elevated hover:text-text-primary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {error && (
          <div className="mb-4 rounded-lg bg-error/10 px-4 py-3 text-sm text-error">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="project-name" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Project name
            </label>
            <input
              id="project-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="My LaTeX Document"
              className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label htmlFor="project-description" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Description <span className="font-normal text-text-muted">(optional)</span>
            </label>
            <textarea
              id="project-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A brief description of your project"
              rows={3}
              className="w-full resize-none rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <div>
            <label htmlFor="project-template" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Template
            </label>
            <Select value={template} onValueChange={(value) => setTemplate(value as ProjectTemplate)}>
              <SelectTrigger id="project-template" className="w-full"><SelectValue placeholder="Select template" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="blank">Blank</SelectItem>
                <SelectItem value="article">Article</SelectItem>
                <SelectItem value="thesis">Thesis</SelectItem>
                <SelectItem value="beamer">Beamer (Presentation)</SelectItem>
                <SelectItem value="letter">Letter</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="project-engine" className="mb-1.5 block text-sm font-medium text-text-secondary">
              Engine
            </label>
            <Select value={engine} onValueChange={(value) => setEngine(value as ProjectEngine)}>
              <SelectTrigger id="project-engine" className="w-full"><SelectValue placeholder="Select engine" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect</SelectItem>
                <SelectItem value="pdflatex">pdfLaTeX</SelectItem>
                <SelectItem value="xelatex">XeLaTeX</SelectItem>
                <SelectItem value="latex">LaTeX (DVI)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label htmlFor="labels" className="mb-1.5 block text-sm font-medium text-text-secondary">Labels</label>
            <LabelPicker inputId="labels" selectedLabels={labels} defaultLabels={defaultLabels} onChange={setLabels} />
          </div>
          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-border bg-bg-elevated px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-border">Cancel</button>
            <button type="submit" disabled={creating || !name.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
              {creating ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Creating...</span> : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
