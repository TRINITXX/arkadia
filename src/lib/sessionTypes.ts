export interface AgentResume {
  kind: string;
  session_id: string;
  command: string;
}

export type PaneTreeSerialized =
  | {
      kind: "leaf";
      pane_id: string;
      cwd: string;
      profile_id: string;
      agent_resume: AgentResume | null;
    }
  | {
      kind: "split";
      orientation: "horizontal" | "vertical";
      ratio: number;
      left: PaneTreeSerialized;
      right: PaneTreeSerialized;
    };

export interface TabSession {
  tab_id: string;
  title: string;
  active_pane_id: string;
  pane_tree: PaneTreeSerialized;
}

export interface ProjectSession {
  project_id: string;
  active_tab_id: string | null;
  tabs: TabSession[];
}

export interface SessionFile {
  version: number;
  saved_at: string;
  active_project_id: string | null;
  projects: ProjectSession[];
}
