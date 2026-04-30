import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { Tab } from "@/types";
import type { AgentStateValue } from "@/lib/agentState";
import { aggregate } from "@/lib/agentState";
import { AgentBadge } from "./AgentBadge";

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  bellTabs: Record<string, true>;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onSpawn: () => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
  disabled?: boolean;
  paneAgentStates: Record<string, AgentStateValue>;
}

function tabAgentState(
  tab: Tab,
  paneAgentStates: Record<string, AgentStateValue>,
): AgentStateValue {
  const states: AgentStateValue[] = [];
  for (const paneId of Object.keys(tab.panes)) {
    states.push(paneAgentStates[paneId] ?? { kind: "none" });
  }
  return aggregate(states);
}

export function TabBar({
  tabs,
  activeTabId,
  bellTabs,
  onActivate,
  onClose,
  onSpawn,
  onReorder,
  disabled = false,
  paneAgentStates,
}: TabBarProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tabs.findIndex((t) => t.id === active.id);
    const newIndex = tabs.findIndex((t) => t.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(oldIndex, newIndex);
  };

  return (
    <div
      className="flex h-9 items-stretch border-b border-zinc-800 bg-zinc-950 select-none"
      data-tauri-drag-region
    >
      <div
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden"
        data-tauri-drag-region
      >
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={tabs.map((t) => t.id)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map((tab) => (
              <SortableTab
                key={tab.id}
                tab={tab}
                active={tab.id === activeTabId}
                hasBell={!!bellTabs[tab.id] && tab.id !== activeTabId}
                onActivate={onActivate}
                onClose={onClose}
                paneAgentStates={paneAgentStates}
              />
            ))}
          </SortableContext>
        </DndContext>
        {!disabled && (
          <button
            onClick={onSpawn}
            className="flex w-9 items-center justify-center text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
            title="New tab (Ctrl+T)"
            aria-label="New tab"
          >
            +
          </button>
        )}
        <div className="flex-1" data-tauri-drag-region />
      </div>
      <WindowControls />
    </div>
  );
}

function WindowControls() {
  const winRef = useRef(getCurrentWindow());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = winRef.current;
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;

    const refresh = async () => {
      const m = await win.isMaximized();
      if (!cancelled) setMaximized(m);
    };

    void refresh();
    void win
      .onResized(() => {
        void refresh();
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = winRef.current;
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        onClick={() => void win.minimize()}
        className="flex w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus size={14} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void win.toggleMaximize()}
        className="flex w-11 items-center justify-center text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <RestoreIcon /> : <Square size={12} strokeWidth={1.5} />}
      </button>
      <button
        type="button"
        onClick={() => void win.close()}
        className="flex w-11 items-center justify-center text-zinc-400 hover:bg-red-600 hover:text-white"
        aria-label="Close"
        title="Close"
      >
        <X size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

/** Win11-style "restore" icon: two overlapping squares. */
function RestoreIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      {/* Back square (top-right L-shape, partially hidden by the front one) */}
      <path d="M3 3 V1 H11 V9 H9" />
      {/* Front square (bottom-left) */}
      <rect x="1" y="3" width="8" height="8" />
    </svg>
  );
}

interface SortableTabProps {
  tab: Tab;
  active: boolean;
  hasBell: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  paneAgentStates: Record<string, AgentStateValue>;
}

function SortableTab({
  tab,
  active,
  hasBell,
  onActivate,
  onClose,
  paneAgentStates,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const title = tab.panes[tab.activePaneId]?.title || "pwsh";

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={() => onActivate(tab.id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      className={`group flex min-w-[120px] max-w-[220px] cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 text-xs ${
        active
          ? "bg-zinc-900 text-zinc-100"
          : "bg-zinc-950 text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
      }`}
      title={hasBell ? `${title} · 🔔` : title}
    >
      {hasBell && (
        <span
          aria-label="bell"
          className="size-1.5 shrink-0 rounded-full bg-amber-400"
        />
      )}
      <span className="relative inline-block truncate font-medium">
        {title}
        <AgentBadge state={tabAgentState(tab, paneAgentStates)} size={6} />
      </span>
    </div>
  );
}
