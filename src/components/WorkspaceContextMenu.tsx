import { useEffect, useRef } from "react";

interface WorkspaceContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function WorkspaceContextMenu({
  x,
  y,
  onRename,
  onDelete,
  onClose,
}: WorkspaceContextMenuProps) {
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

  const clampedX = Math.min(x, window.innerWidth - 170);
  const clampedY = Math.min(y, window.innerHeight - 100);

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

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] rounded border border-zinc-800 bg-zinc-950 py-1 shadow-xl"
      style={{ top: clampedY, left: clampedX }}
    >
      <Item label="Renommer" action={onRename} />
      <div className="my-1 border-t border-zinc-800" />
      <Item label="Supprimer" danger action={onDelete} />
    </div>
  );
}
