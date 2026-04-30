import { useMemo, useState } from "react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { ChevronDown, ChevronRight } from "lucide-react";
import { shortenPath } from "@/store";
import { aggregate, type AgentStateValue } from "@/lib/agentState";
import type { Project, Tab, Workspace } from "@/types";
import { AgentBadge } from "./AgentBadge";

interface SidepanelProps {
  projects: Project[];
  workspaces: Workspace[];
  activeProjectId: string | null;
  onActivate: (id: string) => void;
  onAdd: () => void;
  onAddWorkspace: () => void;
  onProjectContextMenu: (project: Project, x: number, y: number) => void;
  onWorkspaceContextMenu: (workspace: Workspace, x: number, y: number) => void;
  onMoveProject: (
    projectId: string,
    targetWorkspaceId: string | null,
    insertBeforeProjectId: string | null,
  ) => void;
  onReorderWorkspaces: (oldIndex: number, newIndex: number) => void;
  onToggleWorkspaceCollapsed: (id: string) => void;
  tabs: Tab[];
  paneAgentStates: Record<string, AgentStateValue>;
}

const UNGROUPED_ID = "__ungrouped__";

interface ProjectDragData {
  type: "project";
  projectId: string;
  workspaceId: string | null;
}

interface WorkspaceDragData {
  type: "workspace";
  workspaceId: string;
}

interface WorkspaceDropData {
  type: "workspace-drop";
  workspaceId: string | null;
}

interface ProjectDropData {
  type: "project-drop";
  projectId: string;
  workspaceId: string | null;
}

type DragData = ProjectDragData | WorkspaceDragData;
type DropData = WorkspaceDropData | ProjectDropData | DragData;

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

function workspaceAgentState(
  workspaceId: string | null,
  projects: Project[],
  tabs: Tab[],
  paneAgentStates: Record<string, AgentStateValue>,
): AgentStateValue {
  const states: AgentStateValue[] = [];
  for (const p of projects) {
    const pws = p.workspaceId ?? null;
    if (pws !== workspaceId) continue;
    for (const tab of tabs) {
      if (tab.projectId !== p.id) continue;
      for (const paneId of Object.keys(tab.panes)) {
        states.push(paneAgentStates[paneId] ?? { kind: "none" });
      }
    }
  }
  return aggregate(states);
}

export function Sidepanel({
  projects,
  workspaces,
  activeProjectId,
  onActivate,
  onAdd,
  onAddWorkspace,
  onProjectContextMenu,
  onWorkspaceContextMenu,
  onMoveProject,
  onReorderWorkspaces,
  onToggleWorkspaceCollapsed,
  tabs,
  paneAgentStates,
}: SidepanelProps) {
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);

  const sortedWorkspaces = useMemo(
    () => [...workspaces].sort((a, b) => a.order - b.order),
    [workspaces],
  );

  // Group projects by workspaceId (null = ungrouped). Each group is sorted by order.
  const projectsByWorkspace = useMemo(() => {
    const map = new Map<string | null, Project[]>();
    for (const p of projects) {
      const ws = p.workspaceId ?? null;
      if (!map.has(ws)) map.set(ws, []);
      map.get(ws)!.push(p);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.order - b.order);
    return map;
  }, [projects]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (data) setActiveDrag(data);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const activeData = active.data.current as DragData | undefined;
    const overData = over.data.current as DropData | undefined;
    if (!activeData || !overData) return;

    if (activeData.type === "workspace" && overData.type === "workspace") {
      const oldIndex = sortedWorkspaces.findIndex(
        (w) => w.id === activeData.workspaceId,
      );
      const newIndex = sortedWorkspaces.findIndex(
        (w) => w.id === overData.workspaceId,
      );
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      onReorderWorkspaces(oldIndex, newIndex);
      return;
    }

    if (activeData.type === "project") {
      if (overData.type === "project-drop") {
        // Drop before this project (within its workspace).
        onMoveProject(
          activeData.projectId,
          overData.workspaceId,
          overData.projectId,
        );
        return;
      }
      if (overData.type === "workspace-drop") {
        // Drop into the workspace area (or header) → append to the end.
        onMoveProject(activeData.projectId, overData.workspaceId, null);
        return;
      }
    }
  };

  const renderGroup = (
    workspaceId: string | null,
    workspace: Workspace | null,
  ) => {
    const projectsInGroup = projectsByWorkspace.get(workspaceId) ?? [];
    const isCollapsed = workspace?.collapsed ?? false;
    const groupAgent = workspaceAgentState(
      workspaceId,
      projects,
      tabs,
      paneAgentStates,
    );
    return (
      <WorkspaceSection
        key={workspaceId ?? UNGROUPED_ID}
        workspace={workspace}
        workspaceId={workspaceId}
        projects={projectsInGroup}
        collapsed={isCollapsed}
        agentState={groupAgent}
        onToggleCollapsed={
          workspace ? () => onToggleWorkspaceCollapsed(workspace.id) : undefined
        }
        onWorkspaceContextMenu={onWorkspaceContextMenu}
        onProjectContextMenu={onProjectContextMenu}
        onActivate={onActivate}
        activeProjectId={activeProjectId}
        tabs={tabs}
        paneAgentStates={paneAgentStates}
      />
    );
  };

  const ungroupedHasProjects = (projectsByWorkspace.get(null) ?? []).length > 0;

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="flex-1 overflow-y-auto py-2">
        {projects.length === 0 && workspaces.length === 0 ? (
          <div className="px-3 py-2 text-xs text-zinc-500">
            no project yet — click + to add one
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveDrag(null)}
          >
            {sortedWorkspaces.map((w) => renderGroup(w.id, w))}
            {(ungroupedHasProjects || sortedWorkspaces.length === 0) &&
              renderGroup(null, null)}
            <DragOverlay>
              {activeDrag?.type === "project" ? (
                <DragProjectPreview
                  project={projects.find((p) => p.id === activeDrag.projectId)}
                />
              ) : activeDrag?.type === "workspace" ? (
                <DragWorkspacePreview
                  workspace={workspaces.find(
                    (w) => w.id === activeDrag.workspaceId,
                  )}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <button
          onClick={onAdd}
          className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
        >
          + New project
        </button>
        <button
          onClick={onAddWorkspace}
          className="rounded border border-zinc-800/60 bg-transparent px-2 py-1.5 text-xs text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        >
          + New workspace
        </button>
      </div>
    </aside>
  );
}

interface WorkspaceSectionProps {
  workspace: Workspace | null;
  workspaceId: string | null;
  projects: Project[];
  collapsed: boolean;
  agentState: AgentStateValue;
  onToggleCollapsed?: () => void;
  onWorkspaceContextMenu: (workspace: Workspace, x: number, y: number) => void;
  onProjectContextMenu: (project: Project, x: number, y: number) => void;
  onActivate: (id: string) => void;
  activeProjectId: string | null;
  tabs: Tab[];
  paneAgentStates: Record<string, AgentStateValue>;
}

function WorkspaceSection({
  workspace,
  workspaceId,
  projects,
  collapsed,
  agentState,
  onToggleCollapsed,
  onWorkspaceContextMenu,
  onProjectContextMenu,
  onActivate,
  activeProjectId,
  tabs,
  paneAgentStates,
}: WorkspaceSectionProps) {
  const isGrouped = !!workspace;
  return (
    <div className="mb-2">
      {workspace && (
        <DraggableWorkspaceHeader
          workspace={workspace}
          collapsed={collapsed}
          agentState={agentState}
          onToggle={onToggleCollapsed}
          onContextMenu={onWorkspaceContextMenu}
        />
      )}
      {!collapsed && (
        <DroppableGroup
          workspaceId={workspaceId}
          hasProjects={projects.length > 0}
          bordered={isGrouped}
        >
          {projects.map((p) => (
            <DraggableProjectRow
              key={p.id}
              project={p}
              active={p.id === activeProjectId}
              onActivate={onActivate}
              onContextMenu={onProjectContextMenu}
              agentState={projectAgentState(p.id, tabs, paneAgentStates)}
            />
          ))}
        </DroppableGroup>
      )}
    </div>
  );
}

interface DraggableWorkspaceHeaderProps {
  workspace: Workspace;
  collapsed: boolean;
  agentState: AgentStateValue;
  onToggle?: () => void;
  onContextMenu: (workspace: Workspace, x: number, y: number) => void;
}

function DraggableWorkspaceHeader({
  workspace,
  collapsed,
  agentState,
  onToggle,
  onContextMenu,
}: DraggableWorkspaceHeaderProps) {
  // Headers are both a drag source (reorder workspaces) and a drop target
  // (catch projects when collapsed/empty).
  const dragData: WorkspaceDragData = {
    type: "workspace",
    workspaceId: workspace.id,
  };
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `ws-drag:${workspace.id}`, data: dragData });
  const dropData: WorkspaceDropData = {
    type: "workspace-drop",
    workspaceId: workspace.id,
  };
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `ws-drop:${workspace.id}`,
    data: dropData,
  });

  const setRef = (el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  return (
    <div
      ref={setRef}
      {...attributes}
      {...listeners}
      onClick={() => onToggle?.()}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(workspace, e.clientX, e.clientY);
      }}
      className={`mx-1.5 flex cursor-pointer select-none items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-2 text-xs uppercase tracking-wider text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100 ${
        isOver ? "ring-1 ring-zinc-600 bg-zinc-800/80" : ""
      } ${isDragging ? "opacity-40" : ""} ${
        collapsed ? "" : "rounded-b-none border-b-0"
      }`}
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400"
        aria-hidden="true"
      >
        {collapsed ? (
          <ChevronRight size={14} strokeWidth={2} />
        ) : (
          <ChevronDown size={14} strokeWidth={2} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold">
        {workspace.name}
      </span>
      <AgentBadge state={agentState} size={7} inline />
    </div>
  );
}

interface DroppableGroupProps {
  workspaceId: string | null;
  hasProjects: boolean;
  bordered: boolean;
  children: React.ReactNode;
}

function DroppableGroup({
  workspaceId,
  hasProjects,
  bordered,
  children,
}: DroppableGroupProps) {
  const dropData: WorkspaceDropData = {
    type: "workspace-drop",
    workspaceId,
  };
  const { setNodeRef, isOver } = useDroppable({
    id: `ws-area:${workspaceId ?? UNGROUPED_ID}`,
    data: dropData,
  });

  return (
    <div
      ref={setNodeRef}
      className={`min-h-[6px] ${
        bordered
          ? "mx-1.5 rounded-b border border-t-0 border-zinc-800 bg-zinc-950/50 pt-1 pb-1.5"
          : ""
      } ${
        isOver && !hasProjects
          ? "bg-zinc-900/60 outline-dashed outline-1 outline-zinc-700"
          : ""
      }`}
    >
      {children}
      {!hasProjects && (
        <div
          className={`my-0.5 px-2 py-1 text-[10px] italic text-zinc-600 ${
            bordered ? "mx-1.5" : "mx-1.5"
          } ${isOver ? "text-zinc-400" : ""}`}
        >
          (drop a project here)
        </div>
      )}
    </div>
  );
}

interface DraggableProjectRowProps {
  project: Project;
  active: boolean;
  onActivate: (id: string) => void;
  onContextMenu: (project: Project, x: number, y: number) => void;
  agentState: AgentStateValue;
}

function DraggableProjectRow({
  project,
  active,
  onActivate,
  onContextMenu,
  agentState,
}: DraggableProjectRowProps) {
  const dragData: ProjectDragData = {
    type: "project",
    projectId: project.id,
    workspaceId: project.workspaceId ?? null,
  };
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: `proj-drag:${project.id}`, data: dragData });
  const dropData: ProjectDropData = {
    type: "project-drop",
    projectId: project.id,
    workspaceId: project.workspaceId ?? null,
  };
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `proj-drop:${project.id}`,
    data: dropData,
  });

  const setRef = (el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  return (
    <div
      ref={setRef}
      {...attributes}
      {...listeners}
      style={{ borderLeftColor: project.color }}
      onClick={() => onActivate(project.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(project, e.clientX, e.clientY);
      }}
      className={`group mx-1.5 mb-0.5 flex cursor-pointer items-start gap-2 rounded border-l-[3px] py-1.5 pl-2 pr-2 ${
        active ? "bg-zinc-800 text-zinc-100" : "text-zinc-300 hover:bg-zinc-900"
      } ${isDragging ? "opacity-40" : ""} ${
        isOver ? "ring-1 ring-zinc-600" : ""
      }`}
      title={project.path}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{project.name}</div>
        <div className="truncate font-mono text-[10px] text-zinc-500">
          {shortenPath(project.path)}
        </div>
      </div>
      <span className="shrink-0 self-center">
        <AgentBadge state={agentState} size={8} inline />
      </span>
    </div>
  );
}

function DragProjectPreview({ project }: { project: Project | undefined }) {
  if (!project) return null;
  return (
    <div
      style={{ borderLeftColor: project.color }}
      className="flex w-52 items-center gap-2 rounded border-l-[3px] border-y border-r border-zinc-700 bg-zinc-900 py-1.5 pl-2 pr-2 text-sm text-zinc-100 shadow-xl"
    >
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
    </div>
  );
}

function DragWorkspacePreview({
  workspace,
}: {
  workspace: Workspace | undefined;
}) {
  if (!workspace) return null;
  return (
    <div className="flex w-52 items-center gap-2 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] uppercase tracking-wider text-zinc-300 shadow-xl">
      {workspace.name}
    </div>
  );
}
