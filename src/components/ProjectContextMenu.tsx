import { useEffect, useRef, useState } from "react";
import type { Workspace } from "@/types";

interface ProjectContextMenuProps {
  x: number;
  y: number;
  workspaces: Workspace[];
  currentWorkspaceId: string | null | undefined;
  onRename: () => void;
  onChangeColor: () => void;
  onDelete: () => void;
  onMoveToWorkspace: (workspaceId: string | null) => void;
  onClose: () => void;
}

export function ProjectContextMenu({
  x,
  y,
  workspaces,
  currentWorkspaceId,
  onRename,
  onChangeColor,
  onDelete,
  onMoveToWorkspace,
  onClose,
}: ProjectContextMenuProps) {
  const [moveOpen, setMoveOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp inside viewport (rough — assume menu is ~160x100 px)
  const clampedX = Math.min(x, window.innerWidth - 170);
  const clampedY = Math.min(y, window.innerHeight - 110);

  const Item = ({
    label,
    danger = false,
    action,
  }: {
    label: string;
    danger?: boolean;
    action: () => void;
  }) => (
    <button
      onClick={() => {
        action();
        onClose();
      }}
      className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-zinc-800 ${
        danger ? "text-red-400 hover:text-red-300" : "text-zinc-200"
      }`}
    >
      {label}
    </button>
  );

  const sortedWorkspaces = [...workspaces].sort((a, b) => a.order - b.order);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] rounded border border-zinc-800 bg-zinc-950 py-1 shadow-xl"
      style={{ top: clampedY, left: clampedX }}
    >
      <Item label="Renommer" action={onRename} />
      <Item label="Changer la couleur" action={onChangeColor} />
      <div className="relative">
        <button
          onMouseEnter={() => setMoveOpen(true)}
          onClick={() => setMoveOpen((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800"
        >
          <span>Déplacer vers…</span>
          <span className="text-zinc-500">›</span>
        </button>
        {moveOpen && (
          <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded border border-zinc-800 bg-zinc-950 py-1 shadow-xl">
            <button
              onClick={() => {
                onMoveToWorkspace(null);
                onClose();
              }}
              disabled={!currentWorkspaceId}
              className="block w-full px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Aucun (Ungrouped)
            </button>
            {sortedWorkspaces.length > 0 && (
              <div className="my-1 border-t border-zinc-800" />
            )}
            {sortedWorkspaces.map((w) => (
              <button
                key={w.id}
                onClick={() => {
                  onMoveToWorkspace(w.id);
                  onClose();
                }}
                disabled={currentWorkspaceId === w.id}
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              >
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="my-1 border-t border-zinc-800" />
      <Item label="Supprimer" danger action={onDelete} />
    </div>
  );
}
