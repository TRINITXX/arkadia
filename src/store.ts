import { Store } from "@tauri-apps/plugin-store";
import { DEFAULT_CUSTOM_PALETTE } from "@/lib/palettes";
import {
  DEFAULT_EDITOR_PROTOCOL,
  DEFAULT_PALETTE_ID,
  DEFAULT_TERMINAL_FONT,
  type ActionButton,
  type CustomPalette,
  type EditorProtocol,
  type PaletteId,
  type Project,
  type TerminalFont,
  type ToolbarButton,
  type Workspace,
} from "@/types";

const STORE_FILE = "store.json";
const LEGACY_LOCAL_STORAGE_KEY = "arkadia.v1";

const KEY_PROJECTS = "projects";
const KEY_WORKSPACES = "workspaces";
const KEY_ACTIVE_PROJECT = "activeProjectId";
const KEY_TOOLBAR_BUTTONS = "toolbarButtons";
const KEY_FONT = "font";
const KEY_PALETTE_ID = "paletteId";
const KEY_USE_WEBGPU = "useWebGPU";
const KEY_CUSTOM_PALETTE = "customPalette";
const KEY_EDITOR_PROTOCOL = "editorProtocol";

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
const VALID_PALETTE_IDS: PaletteId[] = [
  "wez",
  "wezterm",
  "dracula",
  "solarized-dark",
  "tokyo-night",
  "custom",
];
const VALID_EDITOR_PROTOCOLS: EditorProtocol[] = [
  "vscode",
  "cursor",
  "idea",
  "fleet",
];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface PersistedState {
  projects: Project[];
  workspaces: Workspace[];
  activeProjectId: string | null;
  toolbarButtons: ToolbarButton[];
  font: TerminalFont;
  paletteId: PaletteId;
  useWebGPU: boolean;
  customPalette: CustomPalette;
  editorProtocol: EditorProtocol;
}

const DEFAULT_STATE: PersistedState = {
  projects: [],
  workspaces: [],
  activeProjectId: null,
  toolbarButtons: [],
  font: DEFAULT_TERMINAL_FONT,
  paletteId: DEFAULT_PALETTE_ID,
  useWebGPU: false,
  customPalette: DEFAULT_CUSTOM_PALETTE,
  editorProtocol: DEFAULT_EDITOR_PROTOCOL,
};

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) {
    storePromise = Store.load(STORE_FILE, { autoSave: false, defaults: {} });
  }
  return storePromise;
}

function normalizeAction(b: unknown): ActionButton {
  const x = (b ?? {}) as Record<string, unknown>;
  return {
    id: typeof x.id === "string" ? x.id : newButtonId(),
    kind: "action",
    label: typeof x.label === "string" ? x.label : "",
    icon: typeof x.icon === "string" ? x.icon : "",
    command: typeof x.command === "string" ? x.command : "",
    order: typeof x.order === "number" ? x.order : 0,
  };
}

function normalizePaletteId(p: unknown): PaletteId {
  if (typeof p === "string" && (VALID_PALETTE_IDS as string[]).includes(p)) {
    return p as PaletteId;
  }
  return DEFAULT_PALETTE_ID;
}

function normalizeFont(f: unknown): TerminalFont {
  const x = (f ?? {}) as Record<string, unknown>;
  const family =
    typeof x.family === "string" && x.family.trim().length > 0
      ? x.family
      : DEFAULT_TERMINAL_FONT.family;
  const rawSize =
    typeof x.size === "number" ? x.size : DEFAULT_TERMINAL_FONT.size;
  const size = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, Math.round(rawSize)),
  );
  return { family, size };
}

function normalizeHex(s: unknown, fallback: string): string {
  if (typeof s !== "string") return fallback;
  return HEX_COLOR_RE.test(s) ? s : fallback;
}

function normalizeCustomPalette(p: unknown): CustomPalette {
  const x = (p ?? {}) as Record<string, unknown>;
  const ansiRaw = Array.isArray(x.ansi) ? x.ansi : [];
  const ansi: string[] = Array.from({ length: 16 }, (_, i) =>
    normalizeHex(ansiRaw[i], DEFAULT_CUSTOM_PALETTE.ansi[i]),
  );
  return {
    bg: normalizeHex(x.bg, DEFAULT_CUSTOM_PALETTE.bg),
    fg: normalizeHex(x.fg, DEFAULT_CUSTOM_PALETTE.fg),
    ansi,
  };
}

function normalizeEditorProtocol(p: unknown): EditorProtocol {
  if (
    typeof p === "string" &&
    (VALID_EDITOR_PROTOCOLS as string[]).includes(p)
  ) {
    return p as EditorProtocol;
  }
  return DEFAULT_EDITOR_PROTOCOL;
}

function normalizeProject(p: unknown): Project | null {
  const x = (p ?? {}) as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.name !== "string") return null;
  return {
    id: x.id,
    name: x.name,
    path: typeof x.path === "string" ? x.path : "",
    color: typeof x.color === "string" ? x.color : PROJECT_COLORS[0],
    order: typeof x.order === "number" ? x.order : 0,
    workspaceId:
      typeof x.workspaceId === "string" && x.workspaceId.length > 0
        ? x.workspaceId
        : null,
  };
}

function normalizeWorkspace(w: unknown): Workspace | null {
  const x = (w ?? {}) as Record<string, unknown>;
  if (typeof x.id !== "string" || typeof x.name !== "string") return null;
  return {
    id: x.id,
    name: x.name,
    icon: typeof x.icon === "string" ? x.icon : undefined,
    order: typeof x.order === "number" ? x.order : 0,
    collapsed: typeof x.collapsed === "boolean" ? x.collapsed : false,
  };
}

function normalizeButton(b: unknown): ToolbarButton {
  const x = (b ?? {}) as Record<string, unknown>;
  if (x.kind === "folder") {
    return {
      id: typeof x.id === "string" ? x.id : newButtonId(),
      kind: "folder",
      label: typeof x.label === "string" ? x.label : "",
      icon: typeof x.icon === "string" ? x.icon : "folder",
      children: Array.isArray(x.children)
        ? x.children.map(normalizeAction)
        : [],
      order: typeof x.order === "number" ? x.order : 0,
    };
  }
  return normalizeAction(x);
}

async function tryMigrateFromLocalStorage(
  store: Store,
): Promise<PersistedState | null> {
  try {
    const raw = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const state: PersistedState = {
      projects: Array.isArray(parsed.projects)
        ? (parsed.projects.map(normalizeProject).filter(Boolean) as Project[])
        : [],
      workspaces: [],
      activeProjectId: parsed.activeProjectId ?? null,
      toolbarButtons: Array.isArray(parsed.toolbarButtons)
        ? parsed.toolbarButtons.map(normalizeButton)
        : [],
      font: DEFAULT_TERMINAL_FONT,
      paletteId: DEFAULT_PALETTE_ID,
      useWebGPU: false,
      customPalette: DEFAULT_CUSTOM_PALETTE,
      editorProtocol: DEFAULT_EDITOR_PROTOCOL,
    };
    await store.set(KEY_PROJECTS, state.projects);
    await store.set(KEY_WORKSPACES, state.workspaces);
    await store.set(KEY_ACTIVE_PROJECT, state.activeProjectId);
    await store.set(KEY_TOOLBAR_BUTTONS, state.toolbarButtons);
    await store.set(KEY_FONT, state.font);
    await store.set(KEY_PALETTE_ID, state.paletteId);
    await store.set(KEY_USE_WEBGPU, state.useWebGPU);
    await store.set(KEY_CUSTOM_PALETTE, state.customPalette);
    await store.set(KEY_EDITOR_PROTOCOL, state.editorProtocol);
    await store.save();
    localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
    return state;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<PersistedState> {
  const store = await getStore();

  const hasProjects = (await store.has(KEY_PROJECTS)) === true;
  if (!hasProjects) {
    const migrated = await tryMigrateFromLocalStorage(store);
    if (migrated) return migrated;
  }

  const rawProjects = (await store.get<unknown[]>(KEY_PROJECTS)) ?? [];
  const rawWorkspaces = (await store.get<unknown[]>(KEY_WORKSPACES)) ?? [];
  const activeProjectId =
    (await store.get<string | null>(KEY_ACTIVE_PROJECT)) ??
    DEFAULT_STATE.activeProjectId;
  const rawButtons = (await store.get<unknown[]>(KEY_TOOLBAR_BUTTONS)) ?? [];
  const rawFont = await store.get<unknown>(KEY_FONT);
  const rawPaletteId = await store.get<unknown>(KEY_PALETTE_ID);
  const rawUseWebGPU = await store.get<unknown>(KEY_USE_WEBGPU);
  const rawCustomPalette = await store.get<unknown>(KEY_CUSTOM_PALETTE);
  const rawEditorProtocol = await store.get<unknown>(KEY_EDITOR_PROTOCOL);

  return {
    projects: Array.isArray(rawProjects)
      ? (rawProjects.map(normalizeProject).filter(Boolean) as Project[])
      : DEFAULT_STATE.projects,
    workspaces: Array.isArray(rawWorkspaces)
      ? (rawWorkspaces.map(normalizeWorkspace).filter(Boolean) as Workspace[])
      : DEFAULT_STATE.workspaces,
    activeProjectId,
    toolbarButtons: Array.isArray(rawButtons)
      ? rawButtons.map(normalizeButton)
      : DEFAULT_STATE.toolbarButtons,
    font: normalizeFont(rawFont),
    paletteId: normalizePaletteId(rawPaletteId),
    useWebGPU:
      typeof rawUseWebGPU === "boolean"
        ? rawUseWebGPU
        : DEFAULT_STATE.useWebGPU,
    customPalette: normalizeCustomPalette(rawCustomPalette),
    editorProtocol: normalizeEditorProtocol(rawEditorProtocol),
  };
}

export async function saveState(state: PersistedState): Promise<void> {
  const store = await getStore();
  await store.set(KEY_PROJECTS, state.projects);
  await store.set(KEY_WORKSPACES, state.workspaces);
  await store.set(KEY_ACTIVE_PROJECT, state.activeProjectId);
  await store.set(KEY_TOOLBAR_BUTTONS, state.toolbarButtons);
  await store.set(KEY_FONT, state.font);
  await store.set(KEY_PALETTE_ID, state.paletteId);
  await store.set(KEY_USE_WEBGPU, state.useWebGPU);
  await store.set(KEY_CUSTOM_PALETTE, state.customPalette);
  await store.set(KEY_EDITOR_PROTOCOL, state.editorProtocol);
  await store.save();
}

export function newProjectId() {
  return `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newWorkspaceId() {
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newButtonId() {
  return `btn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const PROJECT_COLORS = [
  "#ff6b6b",
  "#ee9b00",
  "#84c452",
  "#4ecdc4",
  "#4f9dff",
  "#c671ff",
  "#ff61a6",
  "#a8a8a8",
];

export function shortenPath(path: string): string {
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  if (parts.length <= 2) return parts.join("\\");
  return parts.slice(-2).join("\\");
}
