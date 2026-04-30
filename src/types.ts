export type CellColor =
  | { kind: "default" }
  | { kind: "ansi"; idx: number }
  | { kind: "rgb"; value: string };

/**
 * Underline render style. 0 = none, 1 = single, 2 = double, 3 = curly,
 * 4 = dotted, 5 = dashed. Wire format from termwiz `Underline`.
 */
export type UnderlineStyle = 0 | 1 | 2 | 3 | 4 | 5;

export interface CellRun {
  text: string;
  fg: CellColor;
  bg: CellColor;
  bold: boolean;
  italic: boolean;
  /** 0 = none, others = style (see `UnderlineStyle`). */
  underline_style: UnderlineStyle;
  inverse: boolean;
  /** Optional — backend may omit on older versions. */
  strikethrough?: boolean;
  /** OSC 8 hyperlink target. */
  hyperlink?: string;
  /**
   * Visual cell width per char in this run: `1` for normal, `2` for CJK / emoji.
   * All chars in a run share the same width — runs split at width transitions.
   * Default `1` for backward compat with payloads pre-V1.8.
   */
  cell_width?: 1 | 2;
}

/**
 * Active mouse tracking protocol negotiated via DEC private modes.
 * 0 = none, 1 = X10 (1000), 2 = ButtonEvent (1002), 3 = AnyEvent (1003).
 */
export type MouseProtocol = 0 | 1 | 2 | 3;

export interface RenderPayload {
  session_id: string;
  cols: number;
  rows: number;
  cursor_row: number;
  cursor_col: number;
  cursor_visible: boolean;
  title: string;
  lines: CellRun[][];
  /** 0 = at the bottom (live). N = scrolled N lines into history. */
  scroll_offset: number;
  /** Maximum scroll offset (= scrollback length). 0 on alt screen. */
  scroll_max: number;
  /** Mouse tracking protocol the running app requested (0 = none). */
  mouse_protocol: MouseProtocol;
  /** True iff the running app enabled SGR encoding (mode 1006). */
  mouse_sgr: boolean;
}

export interface ClosedPayload {
  session_id: string;
}

export interface CwdPayload {
  session_id: string;
  cwd: string;
}

export interface BellPayload {
  session_id: string;
}

export interface SearchHit {
  /** 0 = oldest scrollback line, scroll_max = visible row 0. */
  total_row: number;
  start_col: number;
  end_col: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  order: number;
  /** null/undefined = ungrouped (rendered in the implicit "Ungrouped" section). */
  workspaceId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  icon?: string;
  order: number;
  collapsed: boolean;
}

/** Pane id == backend session_id (1:1). Renamed for sematic clarity in the tree. */
export type PaneId = string;

export interface PaneState {
  id: PaneId;
  title: string;
  /** Live cwd reported by the shell via OSC 7 (null until the first prompt fires the hook). */
  cwd: string | null;
  screen: RenderPayload | null;
}

export type SplitDirection = "horizontal" | "vertical";

export type PaneTree =
  | { kind: "leaf"; paneId: PaneId }
  | {
      kind: "split";
      direction: SplitDirection;
      ratio: number;
      first: PaneTree;
      second: PaneTree;
    };

export interface Tab {
  id: string;
  projectId: string;
  tree: PaneTree;
  activePaneId: PaneId;
  panes: Record<PaneId, PaneState>;
}

export interface ActionButton {
  id: string;
  kind: "action";
  label: string;
  icon: string;
  command: string;
  order: number;
}

export interface FolderButton {
  id: string;
  kind: "folder";
  label: string;
  icon: string;
  children: ActionButton[];
  order: number;
}

export type ToolbarButton = ActionButton | FolderButton;

export interface TerminalFont {
  family: string;
  size: number;
}

export const DEFAULT_TERMINAL_FONT: TerminalFont = {
  family: "Cascadia Code, Consolas, Courier New, monospace",
  size: 14,
};

export type PaletteId =
  | "wez"
  | "wezterm"
  | "dracula"
  | "solarized-dark"
  | "tokyo-night"
  | "custom";

export interface TerminalPalette {
  id: PaletteId;
  name: string;
  bg: string;
  fg: string;
  /** 16 colors: 0-7 normal, 8-15 bright. Used to resolve {kind: "ansi", idx}. */
  ansi: readonly string[];
}

/** Editable palette used when `paletteId === "custom"`. Persisted as-is. */
export interface CustomPalette {
  bg: string;
  fg: string;
  ansi: string[]; // length 16
}

export const DEFAULT_PALETTE_ID: PaletteId = "wez";

/**
 * URL scheme used to open `path:line:col` matches detected in the terminal.
 * `custom` lets the user provide an arbitrary `<scheme>://file/` prefix.
 */
export type EditorProtocol = "vscode" | "cursor" | "idea" | "fleet";

export const DEFAULT_EDITOR_PROTOCOL: EditorProtocol = "vscode";
