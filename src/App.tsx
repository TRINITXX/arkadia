import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { arrayMove } from "@dnd-kit/sortable";
import { TabBar } from "@/components/TabBar";
import { Sidepanel } from "@/components/Sidepanel";
import { Toolbar } from "@/components/Toolbar";
import { PaneTreeView } from "@/components/PaneTreeView";
import { AddProjectDialog } from "@/components/AddProjectDialog";
import { ProjectContextMenu } from "@/components/ProjectContextMenu";
import { PaneContextMenu } from "@/components/PaneContextMenu";
import { RenameDialog } from "@/components/RenameDialog";
import { ColorPickerDialog } from "@/components/ColorPickerDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { loadState, saveState, newProjectId } from "@/store";
import {
  collectPaneIds,
  firstPaneId,
  removePaneFromTree,
  splitTreeAt,
  updateTreeRatio,
} from "@/lib/paneTree";
import { DEFAULT_CUSTOM_PALETTE, resolveActivePalette } from "@/lib/palettes";
import type { AgentEventPayload, AgentStateValue } from "@/lib/agentState";
import {
  DEFAULT_EDITOR_PROTOCOL,
  DEFAULT_PALETTE_ID,
  DEFAULT_TERMINAL_FONT,
  type ActionButton,
  type BellPayload,
  type ClosedPayload,
  type CustomPalette,
  type CwdPayload,
  type EditorProtocol,
  type PaletteId,
  type PaneState,
  type Project,
  type RenderPayload,
  type SplitDirection,
  type Tab,
  type TerminalFont,
  type ToolbarButton,
} from "@/types";

const COLS = 120;
const ROWS = 30;
const TOOLBAR_RUN_DELAY_MS = 600;

let tabCounter = 0;
function newTabId() {
  tabCounter += 1;
  return `tab-${tabCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ProjectMenuState {
  project: Project;
  x: number;
  y: number;
}

interface PaneMenuState {
  tabId: string;
  paneId: string;
  x: number;
  y: number;
}

export function App() {
  const [loaded, setLoaded] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [toolbarButtons, setToolbarButtons] = useState<ToolbarButton[]>([]);
  const [font, setFont] = useState<TerminalFont>(DEFAULT_TERMINAL_FONT);
  const [paletteId, setPaletteId] = useState<PaletteId>(DEFAULT_PALETTE_ID);
  const [useWebGPU, setUseWebGPU] = useState<boolean>(false);
  const [customPalette, setCustomPalette] = useState<CustomPalette>(
    DEFAULT_CUSTOM_PALETTE,
  );
  const [editorProtocol, setEditorProtocol] = useState<EditorProtocol>(
    DEFAULT_EDITOR_PROTOCOL,
  );
  const palette = useMemo(
    () => resolveActivePalette(paletteId, customPalette),
    [paletteId, customPalette],
  );

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabIdByProject, setActiveTabIdByProject] = useState<
    Record<string, string>
  >({});
  /** tabIds that have a pending bell. Cleared when the tab is activated. */
  const [bellTabs, setBellTabs] = useState<Record<string, true>>({});
  /** paneId → current agent state, mirrored from the backend watcher via cwd.
   *  Consumed by T8 (Sidepanel badge) and T9 (TabBar badge). */
  const [paneAgentStates, setPaneAgentStates] = useState<
    Record<string, AgentStateValue>
  >({});
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState | null>(null);
  const [paneMenu, setPaneMenu] = useState<PaneMenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<Project | null>(null);
  const [colorTarget, setColorTarget] = useState<Project | null>(null);

  // paneId (= backend session_id) → tabId for fast routing of render/closed events.
  const paneToTab = useRef<Map<string, string>>(new Map());

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const visibleTabs = useMemo(
    () =>
      activeProjectId
        ? tabs.filter((t) => t.projectId === activeProjectId)
        : [],
    [tabs, activeProjectId],
  );
  const activeTabId = activeProjectId
    ? (activeTabIdByProject[activeProjectId] ?? null)
    : null;

  // ─── Persistence ────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    loadState()
      .then((state) => {
        if (cancelled) return;
        setProjects(state.projects);
        setActiveProjectId(state.activeProjectId);
        setToolbarButtons(state.toolbarButtons);
        setFont(state.font);
        setPaletteId(state.paletteId);
        setUseWebGPU(state.useWebGPU);
        setCustomPalette(state.customPalette);
        setEditorProtocol(state.editorProtocol);
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`failed to load store: ${String(e)}`);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      void saveState({
        projects,
        activeProjectId,
        toolbarButtons,
        font,
        paletteId,
        useWebGPU,
        customPalette,
        editorProtocol,
      });
    }, 500);
    return () => clearTimeout(t);
  }, [
    loaded,
    projects,
    activeProjectId,
    toolbarButtons,
    font,
    paletteId,
    useWebGPU,
    customPalette,
    editorProtocol,
  ]);

  // ─── Pane / tab spawning ────────────────────────────────────────

  const spawnPane = useCallback(async (cwd: string): Promise<string | null> => {
    try {
      const sessionId = await invoke<string>("spawn_terminal", {
        cwd,
        cols: COLS,
        rows: ROWS,
      });
      return sessionId;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, []);

  const spawnTabFor = useCallback(
    async (
      project: Project,
    ): Promise<{ tabId: string; paneId: string } | null> => {
      const paneId = await spawnPane(project.path);
      if (!paneId) return null;
      const tabId = newTabId();
      paneToTab.current.set(paneId, tabId);
      const pane: PaneState = {
        id: paneId,
        title: project.name,
        cwd: null,
        screen: null,
      };
      const tab: Tab = {
        id: tabId,
        projectId: project.id,
        tree: { kind: "leaf", paneId },
        activePaneId: paneId,
        panes: { [paneId]: pane },
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabIdByProject((prev) => ({ ...prev, [project.id]: tabId }));
      return { tabId, paneId };
    },
    [spawnPane],
  );

  // ─── Closing ───────────────────────────────────────────────────

  const closeTab = useCallback(async (tabId: string) => {
    let removed: Tab | undefined;
    let projId: string | null = null;
    let nextActiveForProj: string | undefined;

    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx === -1) return prev;
      removed = prev[idx];
      projId = removed.projectId;
      const next = prev.filter((t) => t.id !== tabId);
      const remainingInProj = next.filter((t) => t.projectId === projId);
      if (remainingInProj.length > 0) {
        const newIdx = Math.min(idx, remainingInProj.length - 1);
        nextActiveForProj = remainingInProj[newIdx].id;
      }
      return next;
    });

    if (projId) {
      setActiveTabIdByProject((prev) => {
        const copy = { ...prev };
        if (nextActiveForProj) copy[projId!] = nextActiveForProj;
        else delete copy[projId!];
        return copy;
      });
    }

    if (removed) {
      const paneIds = collectPaneIds(removed.tree);
      for (const pid of paneIds) {
        paneToTab.current.delete(pid);
        try {
          await invoke("close_terminal", { sessionId: pid });
        } catch {
          /* ignore */
        }
      }
    }
  }, []);

  const closePane = useCallback(
    async (tabId: string, paneId: string) => {
      let shouldCloseTab = false;
      setTabs((prev) => {
        const tab = prev.find((t) => t.id === tabId);
        if (!tab) return prev;
        const newTree = removePaneFromTree(tab.tree, paneId);
        if (newTree === null) {
          shouldCloseTab = true;
          return prev; // closeTab will handle the removal + PTY teardown
        }
        const newPanes = { ...tab.panes };
        delete newPanes[paneId];
        const newActive =
          tab.activePaneId === paneId ? firstPaneId(newTree) : tab.activePaneId;
        return prev.map((t) =>
          t.id === tabId
            ? { ...t, tree: newTree, panes: newPanes, activePaneId: newActive }
            : t,
        );
      });

      if (shouldCloseTab) {
        await closeTab(tabId);
        return;
      }

      paneToTab.current.delete(paneId);
      try {
        await invoke("close_terminal", { sessionId: paneId });
      } catch {
        /* ignore */
      }
    },
    [closeTab],
  );

  // ─── Pane operations ───────────────────────────────────────────

  const focusPane = useCallback((tabId: string, paneId: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
    );
  }, []);

  const splitPane = useCallback(
    async (tabId: string, paneId: string, direction: SplitDirection) => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return;
      const project = projects.find((p) => p.id === tab.projectId);
      if (!project) return;
      // Inherit the live cwd of the parent pane if known (OSC 7 reported); else fall back to project root.
      const parentCwd = tab.panes[paneId]?.cwd ?? project.path;
      const newPaneId = await spawnPane(parentCwd);
      if (!newPaneId) return;
      paneToTab.current.set(newPaneId, tabId);
      const newPane: PaneState = {
        id: newPaneId,
        title: project.name,
        cwd: null,
        screen: null,
      };
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? {
                ...t,
                tree: splitTreeAt(t.tree, paneId, direction, newPaneId),
                activePaneId: newPaneId,
                panes: { ...t.panes, [newPaneId]: newPane },
              }
            : t,
        ),
      );
    },
    [tabs, projects, spawnPane],
  );

  const setPaneRatio = useCallback(
    (tabId: string, path: number[], ratio: number) => {
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tabId
            ? { ...t, tree: updateTreeRatio(t.tree, path, ratio) }
            : t,
        ),
      );
    },
    [],
  );

  // ─── Event listeners (render + closed) ─────────────────────────

  useEffect(() => {
    let unlistenRender: UnlistenFn | undefined;
    let unlistenClosed: UnlistenFn | undefined;
    let unlistenCwd: UnlistenFn | undefined;
    let unlistenBell: UnlistenFn | undefined;
    let unlistenAgent: UnlistenFn | undefined;
    let active = true;

    async function setup() {
      unlistenRender = await listen<RenderPayload>(
        "terminal-render",
        (event) => {
          if (!active) return;
          const paneId = event.payload.session_id;
          const tabId = paneToTab.current.get(paneId);
          if (!tabId) return;
          setTabs((prev) =>
            prev.map((t) => {
              if (t.id !== tabId) return t;
              const pane = t.panes[paneId];
              if (!pane) return t;
              return {
                ...t,
                panes: {
                  ...t.panes,
                  [paneId]: {
                    ...pane,
                    screen: event.payload,
                    title: event.payload.title || pane.title,
                  },
                },
              };
            }),
          );
        },
      );
      unlistenClosed = await listen<ClosedPayload>(
        "terminal-closed",
        (event) => {
          if (!active) return;
          const paneId = event.payload.session_id;
          const tabId = paneToTab.current.get(paneId);
          if (!tabId) return;
          void closePane(tabId, paneId);
        },
      );
      unlistenCwd = await listen<CwdPayload>("terminal-cwd", async (event) => {
        if (!active) return;
        const paneId = event.payload.session_id;
        const tabId = paneToTab.current.get(paneId);
        if (!tabId) return;
        setTabs((prev) =>
          prev.map((t) => {
            if (t.id !== tabId) return t;
            const pane = t.panes[paneId];
            if (!pane || pane.cwd === event.payload.cwd) return t;
            return {
              ...t,
              panes: {
                ...t.panes,
                [paneId]: { ...pane, cwd: event.payload.cwd },
              },
            };
          }),
        );
        // Refresh agent state from the registry — the watcher may already have a
        // session at this cwd from before this pane reported its cwd.
        try {
          const fresh = await invoke<AgentStateValue>("agent_state_for_pane", {
            paneId,
          });
          if (!active) return;
          setPaneAgentStates((prev) => ({ ...prev, [paneId]: fresh }));
        } catch {
          /* ignore */
        }
      });
      unlistenBell = await listen<BellPayload>("terminal-bell", (event) => {
        if (!active) return;
        const paneId = event.payload.session_id;
        const tabId = paneToTab.current.get(paneId);
        if (!tabId) return;
        setBellTabs((prev) =>
          prev[tabId] ? prev : { ...prev, [tabId]: true },
        );
      });
      unlistenAgent = await listen<AgentEventPayload>(
        "agent-state-changed",
        (event) => {
          if (!active) return;
          const { cwd, state } = event.payload;
          // Find all panes whose live cwd matches this event's cwd, update their
          // states. We read tabs through setTabs's updater to avoid stale closures.
          setTabs((currentTabs) => {
            const matchingPaneIds: string[] = [];
            for (const tab of currentTabs) {
              for (const paneId of Object.keys(tab.panes)) {
                const pane = tab.panes[paneId];
                if (pane.cwd === cwd) matchingPaneIds.push(paneId);
              }
            }
            if (matchingPaneIds.length === 0) return currentTabs;
            setPaneAgentStates((prev) => {
              const next = { ...prev };
              for (const id of matchingPaneIds) next[id] = state;
              return next;
            });
            return currentTabs;
          });
        },
      );
    }
    setup();

    return () => {
      active = false;
      unlistenRender?.();
      unlistenClosed?.();
      unlistenCwd?.();
      unlistenBell?.();
      unlistenAgent?.();
    };
  }, [closePane]);

  // ─── Auto-spawn first tab when activating an empty project ────

  useEffect(() => {
    if (!activeProject) return;
    const hasTab = tabs.some((t) => t.projectId === activeProject.id);
    if (!hasTab) {
      void spawnTabFor(activeProject);
    } else if (!activeTabIdByProject[activeProject.id]) {
      const first = tabs.find((t) => t.projectId === activeProject.id);
      if (first) {
        setActiveTabIdByProject((prev) => ({
          ...prev,
          [activeProject.id]: first.id,
        }));
      }
    }
  }, [activeProject, tabs, activeTabIdByProject, spawnTabFor]);

  // Cleanup all sessions on unmount (HMR / app close)
  useEffect(() => {
    return () => {
      paneToTab.current.forEach((_tabId, paneId) => {
        void invoke("close_terminal", { sessionId: paneId });
      });
      paneToTab.current.clear();
    };
  }, []);

  // Ctrl+T new tab
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "t") {
        if (activeProject) {
          e.preventDefault();
          void spawnTabFor(activeProject);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeProject, spawnTabFor]);

  // ─── Project + tab handlers ────────────────────────────────────

  const onActivateTab = (id: string) => {
    if (!activeProjectId) return;
    setActiveTabIdByProject((prev) => ({ ...prev, [activeProjectId]: id }));
    setBellTabs((prev) => {
      if (!prev[id]) return prev;
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
  };

  const onAddProject = (data: {
    name: string;
    path: string;
    color: string;
  }) => {
    const project: Project = {
      id: newProjectId(),
      name: data.name,
      path: data.path,
      color: data.color,
      order: projects.length,
    };
    setProjects((prev) => [...prev, project]);
    setActiveProjectId(project.id);
    setAddOpen(false);
  };

  const onDeleteProject = (id: string) => {
    const tabsOfProj = tabs.filter((t) => t.projectId === id);
    tabsOfProj.forEach((t) => {
      const paneIds = collectPaneIds(t.tree);
      paneIds.forEach((pid) => {
        paneToTab.current.delete(pid);
        void invoke("close_terminal", { sessionId: pid });
      });
    });
    setTabs((prev) => prev.filter((t) => t.projectId !== id));
    setActiveTabIdByProject((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });
    setProjects((prev) =>
      prev.filter((p) => p.id !== id).map((p, idx) => ({ ...p, order: idx })),
    );
    setActiveProjectId((cur) => {
      if (cur !== id) return cur;
      const remaining = projects.filter((p) => p.id !== id);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  };

  const onRenameProject = (id: string, name: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const onChangeColor = (id: string, color: string) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, color } : p)));
  };

  const onReorderProjects = (oldIndex: number, newIndex: number) => {
    setProjects((prev) => {
      const sorted = [...prev].sort((a, b) => a.order - b.order);
      const reordered = arrayMove(sorted, oldIndex, newIndex);
      return reordered.map((p, idx) => ({ ...p, order: idx }));
    });
  };

  const onReorderTabs = (oldIndex: number, newIndex: number) => {
    if (!activeProjectId) return;
    setTabs((prev) => {
      const inProject = prev.filter((t) => t.projectId === activeProjectId);
      const reordered = arrayMove(inProject, oldIndex, newIndex);
      let i = 0;
      return prev.map((t) =>
        t.projectId === activeProjectId ? reordered[i++] : t,
      );
    });
  };

  const runToolbarAction = useCallback(
    async (button: ActionButton) => {
      if (!activeProject) return;
      const spawned = await spawnTabFor(activeProject);
      if (!spawned) return;
      // Wait for pwsh + PSReadLine to be ready, then send the command.
      setTimeout(async () => {
        try {
          const text = button.command + "\r";
          const bytes = Array.from(new TextEncoder().encode(text));
          await invoke("send_input", {
            sessionId: spawned.paneId,
            bytes,
          });
        } catch (e) {
          setError(String(e));
        }
      }, TOOLBAR_RUN_DELAY_MS);
    },
    [activeProject, spawnTabFor],
  );

  if (!loaded) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-xs text-zinc-600">
        loading…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen bg-zinc-950 text-zinc-100">
      <Sidepanel
        projects={projects}
        activeProjectId={activeProjectId}
        onActivate={setActiveProjectId}
        onAdd={() => setAddOpen(true)}
        onContextMenu={(project, x, y) => setProjectMenu({ project, x, y })}
        onReorder={onReorderProjects}
        tabs={tabs}
        paneAgentStates={paneAgentStates}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        <TabBar
          tabs={visibleTabs}
          activeTabId={activeTabId}
          bellTabs={bellTabs}
          onActivate={onActivateTab}
          onClose={closeTab}
          onSpawn={() => activeProject && spawnTabFor(activeProject)}
          onReorder={onReorderTabs}
          disabled={!activeProject}
          paneAgentStates={paneAgentStates}
        />

        <Toolbar
          buttons={toolbarButtons}
          onRunAction={runToolbarAction}
          onOpenSettings={() => setSettingsOpen(true)}
          disabled={!activeProject}
        />

        {error && (
          <div className="mx-4 mt-2 rounded border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          {!activeProject && (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
              {projects.length === 0
                ? "no project yet — add one in the sidepanel"
                : "select a project in the sidepanel"}
            </div>
          )}
          {activeProject &&
            visibleTabs.map((tab) => (
              <div
                key={tab.id}
                className={`flex min-h-0 min-w-0 flex-1 ${
                  tab.id === activeTabId ? "" : "hidden"
                }`}
              >
                <PaneTreeView
                  tree={tab.tree}
                  panes={tab.panes}
                  activePaneId={tab.activePaneId}
                  font={font}
                  palette={palette}
                  useWebGPU={useWebGPU}
                  editorProtocol={editorProtocol}
                  onActivate={(paneId) => focusPane(tab.id, paneId)}
                  onContextMenu={(paneId, x, y) =>
                    setPaneMenu({ tabId: tab.id, paneId, x, y })
                  }
                  onSetRatio={(path, ratio) =>
                    setPaneRatio(tab.id, path, ratio)
                  }
                />
              </div>
            ))}
        </div>
      </div>

      <AddProjectDialog
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onSubmit={onAddProject}
      />

      {projectMenu && (
        <ProjectContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          onRename={() => setRenameTarget(projectMenu.project)}
          onChangeColor={() => setColorTarget(projectMenu.project)}
          onDelete={() => {
            const proj = projectMenu.project;
            if (confirm(`Delete project "${proj.name}"?`)) {
              onDeleteProject(proj.id);
            }
          }}
          onClose={() => setProjectMenu(null)}
        />
      )}

      {paneMenu && (
        <PaneContextMenu
          x={paneMenu.x}
          y={paneMenu.y}
          canClose={true}
          onSplitHorizontal={() =>
            splitPane(paneMenu.tabId, paneMenu.paneId, "horizontal")
          }
          onSplitVertical={() =>
            splitPane(paneMenu.tabId, paneMenu.paneId, "vertical")
          }
          onClose={() => closePane(paneMenu.tabId, paneMenu.paneId)}
          onDismiss={() => setPaneMenu(null)}
        />
      )}

      <RenameDialog
        open={!!renameTarget}
        initialValue={renameTarget?.name ?? ""}
        onCancel={() => setRenameTarget(null)}
        onSubmit={(name) => {
          if (renameTarget) onRenameProject(renameTarget.id, name);
          setRenameTarget(null);
        }}
      />

      <ColorPickerDialog
        open={!!colorTarget}
        initialValue={colorTarget?.color ?? "#000000"}
        onCancel={() => setColorTarget(null)}
        onSubmit={(color) => {
          if (colorTarget) onChangeColor(colorTarget.id, color);
          setColorTarget(null);
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        buttons={toolbarButtons}
        onChangeButtons={setToolbarButtons}
        font={font}
        onChangeFont={setFont}
        paletteId={paletteId}
        onChangePaletteId={setPaletteId}
        useWebGPU={useWebGPU}
        onChangeUseWebGPU={setUseWebGPU}
        customPalette={customPalette}
        onChangeCustomPalette={setCustomPalette}
        editorProtocol={editorProtocol}
        onChangeEditorProtocol={setEditorProtocol}
      />
    </div>
  );
}
