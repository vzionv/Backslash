"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import type { LabelDraft, ProjectLabel } from "./project-types";

interface LabelPickerProps {
  inputId: string;
  selectedLabels: LabelDraft[];
  defaultLabels: ProjectLabel[];
  onChange: (labels: LabelDraft[]) => void;
}

export function LabelPicker({
  inputId,
  selectedLabels,
  defaultLabels,
  onChange,
}: LabelPickerProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const selectedNameSet = useMemo(
    () => new Set(selectedLabels.map((label) => label.name.trim().toLowerCase())),
    [selectedLabels]
  );
  const availableLabels = useMemo(
    () =>
      defaultLabels.filter(
        (label) => !selectedNameSet.has(label.name.trim().toLowerCase())
      ),
    [defaultLabels, selectedNameSet]
  );
  const normalizedQuery = query.trim();
  const normalizedQueryLower = normalizedQuery.toLowerCase();
  const matchingLabels = useMemo(() => {
    const pool = normalizedQueryLower
      ? availableLabels.filter((label) =>
          label.name.toLowerCase().includes(normalizedQueryLower)
        )
      : availableLabels;
    return pool.slice(0, 6);
  }, [availableLabels, normalizedQueryLower]);
  const exactMatch = useMemo(
    () =>
      availableLabels.find(
        (label) => label.name.trim().toLowerCase() === normalizedQueryLower
      ),
    [availableLabels, normalizedQueryLower]
  );
  const canCreateFromQuery =
    normalizedQuery.length > 0 &&
    !selectedNameSet.has(normalizedQueryLower) &&
    !exactMatch;

  const addLabel = useCallback(
    (nextLabel: LabelDraft) => {
      const normalizedName = nextLabel.name.trim();
      if (!normalizedName || selectedNameSet.has(normalizedName.toLowerCase())) {
        return;
      }

      onChange([
        ...selectedLabels,
        { id: nextLabel.id, name: normalizedName },
      ]);
      setQuery("");
      setOpen(false);
    },
    [onChange, selectedLabels, selectedNameSet]
  );

  const removeLabel = useCallback(
    (index: number) => {
      onChange(selectedLabels.filter((_, currentIndex) => currentIndex !== index));
    },
    [onChange, selectedLabels]
  );

  const handleAddFromInput = useCallback(() => {
    if (!normalizedQuery) return;
    if (exactMatch) {
      addLabel({ id: exactMatch.id, name: exactMatch.name });
      return;
    }
    if (canCreateFromQuery) {
      addLabel({ name: normalizedQuery });
    }
  }, [addLabel, canCreateFromQuery, exactMatch, normalizedQuery]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  return (
    <div className="space-y-2">
      <div ref={wrapperRef} className="relative">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              id={inputId}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddFromInput();
                }
              }}
              placeholder="Search existing labels or add a new one"
              className="w-full rounded-lg border border-border bg-bg-secondary py-2 pl-9 pr-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
            />
          </div>
          <button
            type="button"
            onClick={handleAddFromInput}
            disabled={!normalizedQuery || selectedNameSet.has(normalizedQueryLower)}
            className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg-primary transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {open && (matchingLabels.length > 0 || canCreateFromQuery) && (
          <div className="absolute left-0 right-0 z-20 mt-2 overflow-hidden rounded-lg border border-border bg-bg-secondary shadow-lg">
            {matchingLabels.map((label) => (
              <button
                key={`LABEL_SUGGESTION__${label.id}`}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addLabel({ id: label.id, name: label.name })}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
              >
                <span>{label.name}</span>
                <span className="text-xs text-text-muted">existing</span>
              </button>
            ))}
            {canCreateFromQuery && (
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => addLabel({ name: normalizedQuery })}
                className="flex w-full items-center justify-between border-t border-border px-3 py-2 text-left text-sm text-text-secondary transition-colors hover:bg-bg-elevated hover:text-text-primary"
              >
                <span>{`Create "${normalizedQuery}"`}</span>
                <span className="text-xs text-text-muted">new</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {selectedLabels.length === 0 && (
          <span className="text-xs text-text-muted">No labels selected.</span>
        )}
        {selectedLabels.map((label, index) => (
          <span
            key={`SELECTED_LABEL__${label.id ?? label.name}__${index}`}
            className="inline-flex items-center rounded-full bg-bg-elevated px-2.5 py-0.5 text-xs font-medium text-text-secondary"
          >
            {label.name}
            <button
              type="button"
              onClick={() => removeLabel(index)}
              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-bg-secondary hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
