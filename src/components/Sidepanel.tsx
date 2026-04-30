import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { shortenPath } from "@/store";
import { aggregate, type AgentStateValue } from "@/lib/agentState";
import type { Project, Tab } from "@/types";
import { AgentBadge } from "./AgentBadge";

interface SidepanelProps {
  projects: Project[];
  activeProjectId: string | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onContextMenu: (project: Project, x: number, y: number) => void;
  onReorder: (oldIndex: number, newIndex: number) => void;
  tabs: Tab[];
  paneAgentStates: Record<string, AgentStateValue>;
}

function projectAgentState(
  projectId: string,
  tabs: Tab[],
  paneAgentStates: Record<string, AgentStateValue>,
): AgentStateValue {
  const states: AgentStateValue[] = [];
  for (const tab of tabs) {
    if (tab.projectId !== projectId) continue;
    for (const paneId of Object.keys(tab.panes)) {
      states.push(paneAgentStates[paneId] ?? { kind: "none" });
    }
  }
  return aggregate(states);
}

export function Sidepanel({
  projects,
  activeProjectId,
  onActivate,
  onAdd,
  onContextMenu,
  onReorder,
  tabs,
  paneAgentStates,
}: SidepanelProps) {
  const sortedProjects = [...projects].sort((a, b) => a.order - b.order);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = sortedProjects.findIndex((p) => p.id === active.id);
    const newIndex = sortedProjects.findIndex((p) => p.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    onReorder(oldIndex, newIndex);
  };

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex-1 overflow-y-auto py-2">
        {sortedProjects.length === 0 ? (
          <div className="px-3 py-2 text-xs text-zinc-500">
            no project yet — click + to add one
          </div>
        ) : (
          <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
            <SortableContext
              items={sortedProjects.map((p) => p.id)}
              strategy={verticalListSortingStrategy}
            >
              {sortedProjects.map((p) => (
                <SortableProjectRow
                  key={p.id}
                  project={p}
                  active={p.id === activeProjectId}
                  onActivate={onActivate}
                  onContextMenu={onContextMenu}
                  agentState={projectAgentState(p.id, tabs, paneAgentStates)}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>
      <button
        onClick={onAdd}
        className="m-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
      >
        + New project
      </button>
    </aside>
  );
}

interface SortableProjectRowProps {
  project: Project;
  active: boolean;
  onActivate: (id: string) => void;
  onContextMenu: (project: Project, x: number, y: number) => void;
  agentState: AgentStateValue;
}

function SortableProjectRow({
  project,
  active,
  onActivate,
  onContextMenu,
  agentState,
}: SortableProjectRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, borderLeftColor: project.color }}
      {...attributes}
      {...listeners}
      onClick={() => onActivate(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(project, e.clientX, e.clientY);
      }}
      className={`group mx-1.5 mb-0.5 flex cursor-pointer items-start gap-2 border-l-[3px] rounded py-1.5 pl-2 pr-2 ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"
      }`}
      title={project.path}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{project.name}</div>
        <div className="truncate font-mono text-[10px] text-zinc-500">
          {shortenPath(project.path)}
        </div>
      </div>
      <span className="mt-1.5 shrink-0">
        <AgentBadge state={agentState} size={8} inline />
      </span>
    </div>
  );
}
