import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { newButtonId } from "@/store";
import { customAsPalette, PALETTES } from "@/lib/palettes";
import type {
  ActionButton,
  CustomPalette,
  EditorProtocol,
  FolderButton,
  PaletteId,
  TerminalFont,
  ToolbarButton,
} from "@/types";
import { IconPicker } from "@/components/IconPicker";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  buttons: ToolbarButton[];
  onChangeButtons: (next: ToolbarButton[]) => void;
  font: TerminalFont;
  onChangeFont: (next: TerminalFont) => void;
  paletteId: PaletteId;
  onChangePaletteId: (next: PaletteId) => void;
  useWebGPU: boolean;
  onChangeUseWebGPU: (next: boolean) => void;
  customPalette: CustomPalette;
  onChangeCustomPalette: (next: CustomPalette) => void;
  editorProtocol: EditorProtocol;
  onChangeEditorProtocol: (next: EditorProtocol) => void;
}

type Tab = "toolbar" | "general" | "sessions";

export function SettingsDialog({
  open,
  onClose,
  buttons,
  onChangeButtons,
  font,
  onChangeFont,
  paletteId,
  onChangePaletteId,
  useWebGPU,
  onChangeUseWebGPU,
  customPalette,
  onChangeCustomPalette,
  editorProtocol,
  onChangeEditorProtocol,
}: SettingsDialogProps) {
  const [tab, setTab] = useState<Tab>("toolbar");

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[640px] w-[760px] flex-col rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-base font-semibold tracking-tight">Settings</h2>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200"
            aria-label="Close"
            type="button"
          >
            ×
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <nav className="w-44 shrink-0 border-r border-zinc-800 p-2">
            <SettingsNavItem
              active={tab === "toolbar"}
              onClick={() => setTab("toolbar")}
            >
              Toolbar
            </SettingsNavItem>
            <SettingsNavItem
              active={tab === "general"}
              onClick={() => setTab("general")}
            >
              General
            </SettingsNavItem>
            <SettingsNavItem
              active={tab === "sessions"}
              onClick={() => setTab("sessions")}
            >
              Sessions
            </SettingsNavItem>
          </nav>

          <div className="flex-1 overflow-y-auto p-5">
            {tab === "toolbar" && (
              <ToolbarSettings
                buttons={buttons}
                onChangeButtons={onChangeButtons}
              />
            )}
            {tab === "general" && (
              <GeneralSettings
                font={font}
                onChangeFont={onChangeFont}
                paletteId={paletteId}
                onChangePaletteId={onChangePaletteId}
                useWebGPU={useWebGPU}
                onChangeUseWebGPU={onChangeUseWebGPU}
                customPalette={customPalette}
                onChangeCustomPalette={onChangeCustomPalette}
                editorProtocol={editorProtocol}
                onChangeEditorProtocol={onChangeEditorProtocol}
              />
            )}
            {tab === "sessions" && <SessionsSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsNavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`mb-0.5 block w-full rounded px-2 py-1.5 text-left text-sm ${
        active
          ? "bg-zinc-800 text-zinc-100"
          : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
      }`}
      type="button"
    >
      {children}
    </button>
  );
}

interface ToolbarSettingsProps {
  buttons: ToolbarButton[];
  onChangeButtons: (next: ToolbarButton[]) => void;
}

function ToolbarSettings({ buttons, onChangeButtons }: ToolbarSettingsProps) {
  const sorted = [...buttons].sort((a, b) => a.order - b.order);

  const addAction = () => {
    const next: ActionButton = {
      id: newButtonId(),
      kind: "action",
      label: "",
      icon: "play",
      command: "",
      order: buttons.length,
    };
    onChangeButtons([...buttons, next]);
  };

  const addFolder = () => {
    const next: FolderButton = {
      id: newButtonId(),
      kind: "folder",
      label: "Folder",
      icon: "folder",
      children: [],
      order: buttons.length,
    };
    onChangeButtons([...buttons, next]);
  };

  const updateButton = (id: string, patch: Partial<ToolbarButton>) => {
    onChangeButtons(
      buttons.map((b) =>
        b.id === id ? ({ ...b, ...patch } as ToolbarButton) : b,
      ),
    );
  };

  const removeButton = (id: string) => {
    onChangeButtons(
      buttons
        .filter((b) => b.id !== id)
        .map((b, idx) => ({ ...b, order: idx })),
    );
  };

  const moveButton = (id: string, dir: -1 | 1) => {
    const arr = [...buttons].sort((a, b) => a.order - b.order);
    const idx = arr.findIndex((b) => b.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    onChangeButtons(arr.map((b, i) => ({ ...b, order: i })));
  };

  const updateFolderChildren = (id: string, children: ActionButton[]) => {
    onChangeButtons(
      buttons.map((b) =>
        b.id === id && b.kind === "folder" ? { ...b, children } : b,
      ),
    );
  };

  return (
    <div>
      <div className="mb-4 flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Toolbar buttons
          </h3>
          <p className="text-xs text-zinc-500">
            Each action opens a new tab in the active project and runs its
            command + Enter. A folder opens a popover containing more actions.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={addAction}
            className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            type="button"
          >
            + Action
          </button>
          <button
            onClick={addFolder}
            className="rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-800"
            type="button"
          >
            + Folder
          </button>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-500">
          no button yet
        </div>
      ) : (
        <ul className="space-y-2">
          {sorted.map((b, idx) => (
            <li
              key={b.id}
              className="rounded border border-zinc-800 bg-zinc-900/60 p-3"
            >
              {b.kind === "action" ? (
                <ActionEditor
                  button={b}
                  isFirst={idx === 0}
                  isLast={idx === sorted.length - 1}
                  onUpdate={(patch) => updateButton(b.id, patch)}
                  onRemove={() => removeButton(b.id)}
                  onMove={(dir) => moveButton(b.id, dir)}
                />
              ) : (
                <FolderEditor
                  button={b}
                  isFirst={idx === 0}
                  isLast={idx === sorted.length - 1}
                  onUpdate={(patch) => updateButton(b.id, patch)}
                  onRemove={() => removeButton(b.id)}
                  onMove={(dir) => moveButton(b.id, dir)}
                  onChangeChildren={(children) =>
                    updateFolderChildren(b.id, children)
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface MoveProps {
  isFirst: boolean;
  isLast: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

function MoveButtons({ isFirst, isLast, onMove, onRemove }: MoveProps) {
  return (
    <>
      <button
        onClick={() => onMove(-1)}
        disabled={isFirst}
        className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
        title="Move up"
        type="button"
      >
        ↑
      </button>
      <button
        onClick={() => onMove(1)}
        disabled={isLast}
        className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-30"
        title="Move down"
        type="button"
      >
        ↓
      </button>
      <button
        onClick={onRemove}
        className="rounded border border-zinc-800 px-2 py-1 text-xs text-red-400 hover:bg-red-950/30 hover:text-red-300"
        type="button"
      >
        Delete
      </button>
    </>
  );
}

interface ActionEditorProps extends MoveProps {
  button: ActionButton;
  onUpdate: (patch: Partial<ActionButton>) => void;
}

function ActionEditor({
  button,
  onUpdate,
  onRemove,
  onMove,
  isFirst,
  isLast,
}: ActionEditorProps) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
          action
        </span>
        <IconPicker
          value={button.icon}
          onChange={(icon) => onUpdate({ icon })}
        />
        <input
          value={button.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="label (optional)"
          className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-zinc-600"
        />
        <MoveButtons
          isFirst={isFirst}
          isLast={isLast}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>
      <textarea
        value={button.command}
        onChange={(e) => onUpdate({ command: e.target.value })}
        placeholder="powershell command (e.g. npm run dev)"
        rows={2}
        className="w-full resize-y rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs outline-none focus:border-zinc-600"
      />
    </div>
  );
}

interface FolderEditorProps extends MoveProps {
  button: FolderButton;
  onUpdate: (patch: Partial<FolderButton>) => void;
  onChangeChildren: (children: ActionButton[]) => void;
}

function FolderEditor({
  button,
  onUpdate,
  onRemove,
  onMove,
  isFirst,
  isLast,
  onChangeChildren,
}: FolderEditorProps) {
  const sortedChildren = [...button.children].sort((a, b) => a.order - b.order);

  const addChild = () => {
    const next: ActionButton = {
      id: newButtonId(),
      kind: "action",
      label: "",
      icon: "play",
      command: "",
      order: button.children.length,
    };
    onChangeChildren([...button.children, next]);
  };

  const updateChild = (id: string, patch: Partial<ActionButton>) => {
    onChangeChildren(
      button.children.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    );
  };

  const removeChild = (id: string) => {
    onChangeChildren(
      button.children
        .filter((c) => c.id !== id)
        .map((c, idx) => ({ ...c, order: idx })),
    );
  };

  const moveChild = (id: string, dir: -1 | 1) => {
    const arr = [...button.children].sort((a, b) => a.order - b.order);
    const idx = arr.findIndex((c) => c.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= arr.length) return;
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    onChangeChildren(arr.map((c, i) => ({ ...c, order: i })));
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded bg-amber-900/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
          folder
        </span>
        <IconPicker
          value={button.icon}
          onChange={(icon) => onUpdate({ icon })}
        />
        <input
          value={button.label}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="label (optional)"
          className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-zinc-600"
        />
        <MoveButtons
          isFirst={isFirst}
          isLast={isLast}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>

      <div className="ml-2 border-l-2 border-zinc-800 pl-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            Children ({sortedChildren.length})
          </span>
          <button
            onClick={addChild}
            className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-[10px] text-zinc-200 hover:bg-zinc-800"
            type="button"
          >
            + Action
          </button>
        </div>
        {sortedChildren.length === 0 ? (
          <div className="py-2 text-[11px] text-zinc-600">empty</div>
        ) : (
          <ul className="space-y-2">
            {sortedChildren.map((c, idx) => (
              <li
                key={c.id}
                className="rounded border border-zinc-800 bg-zinc-950 p-2"
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <IconPicker
                    value={c.icon}
                    onChange={(icon) => updateChild(c.id, { icon })}
                  />
                  <input
                    value={c.label}
                    onChange={(e) =>
                      updateChild(c.id, { label: e.target.value })
                    }
                    placeholder="label (optional)"
                    className="flex-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs outline-none focus:border-zinc-600"
                  />
                  <MoveButtons
                    isFirst={idx === 0}
                    isLast={idx === sortedChildren.length - 1}
                    onMove={(dir) => moveChild(c.id, dir)}
                    onRemove={() => removeChild(c.id)}
                  />
                </div>
                <textarea
                  value={c.command}
                  onChange={(e) =>
                    updateChild(c.id, { command: e.target.value })
                  }
                  placeholder="powershell command"
                  rows={1}
                  className="w-full resize-y rounded border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-[11px] outline-none focus:border-zinc-600"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface GeneralSettingsProps {
  font: TerminalFont;
  onChangeFont: (next: TerminalFont) => void;
  paletteId: PaletteId;
  onChangePaletteId: (next: PaletteId) => void;
  useWebGPU: boolean;
  onChangeUseWebGPU: (next: boolean) => void;
  customPalette: CustomPalette;
  onChangeCustomPalette: (next: CustomPalette) => void;
  editorProtocol: EditorProtocol;
  onChangeEditorProtocol: (next: EditorProtocol) => void;
}

const EDITOR_PROTOCOLS: { id: EditorProtocol; label: string; hint: string }[] =
  [
    { id: "vscode", label: "VS Code", hint: "vscode://file/…" },
    { id: "cursor", label: "Cursor", hint: "cursor://file/…" },
    { id: "idea", label: "IntelliJ IDEA", hint: "idea://open?file=…" },
    { id: "fleet", label: "Fleet", hint: "fleet://file/…" },
  ];

const ANSI_LABELS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright black",
  "bright red",
  "bright green",
  "bright yellow",
  "bright blue",
  "bright magenta",
  "bright cyan",
  "bright white",
] as const;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function HexInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const valid = HEX_COLOR_RE.test(value);
  return (
    <label className="flex items-center gap-2 text-[11px] text-zinc-400">
      <span
        className="h-5 w-5 shrink-0 rounded border border-zinc-700"
        style={{ backgroundColor: valid ? value : "transparent" }}
      />
      <span className="w-28 shrink-0 truncate">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={`w-20 rounded border bg-zinc-950 px-2 py-1 font-mono text-xs outline-none ${
          valid
            ? "border-zinc-800 focus:border-zinc-600"
            : "border-red-700 focus:border-red-500"
        }`}
      />
    </label>
  );
}

function CustomPaletteEditor({
  customPalette,
  onChangeCustomPalette,
}: {
  customPalette: CustomPalette;
  onChangeCustomPalette: (next: CustomPalette) => void;
}) {
  const setAnsi = (idx: number, value: string) => {
    const ansi = [...customPalette.ansi];
    ansi[idx] = value;
    onChangeCustomPalette({ ...customPalette, ansi });
  };
  return (
    <div className="mt-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <h5 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Custom palette editor
      </h5>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <HexInput
          label="background"
          value={customPalette.bg}
          onChange={(v) => onChangeCustomPalette({ ...customPalette, bg: v })}
        />
        <HexInput
          label="foreground"
          value={customPalette.fg}
          onChange={(v) => onChangeCustomPalette({ ...customPalette, fg: v })}
        />
        {customPalette.ansi.map((c, i) => (
          <HexInput
            key={i}
            label={`${i} · ${ANSI_LABELS[i]}`}
            value={c}
            onChange={(v) => setAnsi(i, v)}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-600">
        Format `#RRGGBB`. Les valeurs invalides sont ignorées au save (encadré
        rouge en attendant).
      </p>
    </div>
  );
}

const FONT_FAMILY_OPTIONS = [
  {
    label: "Maple Mono NF (WezTerm)",
    value: "Maple Mono NF, Maple Mono, Consolas, monospace",
  },
  { label: "JetBrains Mono", value: "JetBrains Mono, Consolas, monospace" },
  {
    label: "Cascadia Code",
    value: "Cascadia Code, Consolas, Courier New, monospace",
  },
  {
    label: "Cascadia Mono",
    value: "Cascadia Mono, Consolas, Courier New, monospace",
  },
  { label: "Consolas", value: "Consolas, Courier New, monospace" },
  { label: "Courier New", value: "Courier New, monospace" },
  { label: "Lucida Console", value: "Lucida Console, Consolas, monospace" },
  { label: "Fira Code", value: "Fira Code, Consolas, monospace" },
  { label: "Source Code Pro", value: "Source Code Pro, Consolas, monospace" },
  { label: "Hack", value: "Hack, Consolas, monospace" },
];

const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;

function clampSize(n: number): number {
  if (Number.isNaN(n)) return FONT_SIZE_MIN;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)));
}

function GeneralSettings({
  font,
  onChangeFont,
  paletteId,
  onChangePaletteId,
  useWebGPU,
  onChangeUseWebGPU,
  customPalette,
  onChangeCustomPalette,
  editorProtocol,
  onChangeEditorProtocol,
}: GeneralSettingsProps) {
  const allPalettes = [...PALETTES, customAsPalette(customPalette)];
  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold tracking-tight">General</h3>

      <section>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Terminal font
        </h4>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs text-zinc-400">
              Font family
            </span>
            <select
              value={font.family}
              onChange={(e) =>
                onChangeFont({ ...font, family: e.target.value })
              }
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm outline-none focus:border-zinc-600"
            >
              {!FONT_FAMILY_OPTIONS.some((o) => o.value === font.family) && (
                <option value={font.family}>Custom: {font.family}</option>
              )}
              {FONT_FAMILY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] text-zinc-600">
              La première police installée sur le système est utilisée, avec
              fallback automatique sur Consolas / monospace.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 flex items-baseline justify-between text-xs text-zinc-400">
              <span>Font size</span>
              <span className="font-mono text-zinc-300">{font.size}px</span>
            </span>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={1}
                value={font.size}
                onChange={(e) =>
                  onChangeFont({
                    ...font,
                    size: clampSize(parseInt(e.target.value, 10)),
                  })
                }
                className="flex-1 accent-zinc-300"
              />
              <input
                type="number"
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                value={font.size}
                onChange={(e) =>
                  onChangeFont({
                    ...font,
                    size: clampSize(parseInt(e.target.value, 10)),
                  })
                }
                className="w-16 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm outline-none focus:border-zinc-600"
              />
            </div>
          </label>

          <div
            style={{
              fontFamily: font.family,
              fontSize: `${font.size}px`,
              lineHeight: 1.25,
            }}
            className="rounded border border-zinc-800 bg-black px-3 py-2 text-zinc-200"
          >
            <div>The quick brown fox jumps over the lazy dog 0123456789</div>
            <div className="text-zinc-500">
              PS C:\Users\you&gt;{" "}
              <span className="text-zinc-200">npm run dev</span>
            </div>
            <div className="text-emerald-400">{"→ ✓ ready in 234ms"}</div>
          </div>
        </div>
      </section>

      <section>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Renderer
        </h4>
        <label className="flex items-start gap-3 rounded border border-zinc-800 bg-zinc-900/40 p-3">
          <input
            type="checkbox"
            checked={useWebGPU}
            onChange={(e) => onChangeUseWebGPU(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-zinc-300"
          />
          <span>
            <span className="block text-sm text-zinc-200">
              Renderer GPU (expérimental)
            </span>
            <span className="mt-0.5 block text-[11px] text-zinc-500">
              Utilise WebGPU + un atlas Cascadia Code embedded au lieu du rendu
              HTML. Recharge ou réactive le pane pour appliquer.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Color palette
        </h4>
        <div className="grid grid-cols-2 gap-3">
          {allPalettes.map((p) => {
            const selected = p.id === paletteId;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChangePaletteId(p.id)}
                style={{ backgroundColor: p.bg, color: p.fg }}
                className={`rounded border p-3 text-left transition ${
                  selected
                    ? "border-zinc-300 ring-1 ring-zinc-300"
                    : "border-zinc-800 hover:border-zinc-600"
                }`}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span
                    style={{
                      fontFamily: font.family,
                      fontSize: 13,
                    }}
                  >
                    {p.name}
                  </span>
                  {selected && (
                    <span
                      className="text-[10px] uppercase tracking-wide"
                      style={{ color: p.fg, opacity: 0.7 }}
                    >
                      selected
                    </span>
                  )}
                </div>
                <div className="mb-1.5 flex h-3 overflow-hidden rounded">
                  {p.ansi.slice(0, 8).map((c, i) => (
                    <div
                      key={i}
                      style={{ backgroundColor: c }}
                      className="flex-1"
                    />
                  ))}
                </div>
                <div className="flex h-3 overflow-hidden rounded">
                  {p.ansi.slice(8, 16).map((c, i) => (
                    <div
                      key={i + 8}
                      style={{ backgroundColor: c }}
                      className="flex-1"
                    />
                  ))}
                </div>
              </button>
            );
          })}
        </div>
        {paletteId === "custom" && (
          <CustomPaletteEditor
            customPalette={customPalette}
            onChangeCustomPalette={onChangeCustomPalette}
          />
        )}
      </section>

      <section>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Editor protocol
        </h4>
        <p className="mb-3 text-[11px] text-zinc-500">
          Schéma utilisé quand on clique sur un `path:line:col` dans le
          terminal.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {EDITOR_PROTOCOLS.map((opt) => {
            const selected = opt.id === editorProtocol;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onChangeEditorProtocol(opt.id)}
                className={`rounded border p-3 text-left transition ${
                  selected
                    ? "border-zinc-300 bg-zinc-900 ring-1 ring-zinc-300"
                    : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-600"
                }`}
              >
                <div className="text-sm text-zinc-100">{opt.label}</div>
                <div className="mt-0.5 font-mono text-[11px] text-zinc-500">
                  {opt.hint}
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SessionsSettings() {
  const [status, setStatus] = useState<"idle" | "clearing" | "cleared">("idle");

  const onClear = async () => {
    setStatus("clearing");
    try {
      await invoke("session_clear");
      setStatus("cleared");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("idle");
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold tracking-tight">Sessions</h3>

      <section>
        <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
          Persistance
        </h4>
        <p className="mb-3 text-[11px] text-zinc-500">
          La session courante (projets, onglets, splits, cwd) est sauvegardée
          automatiquement toutes les 30 secondes et restaurée au démarrage. Pour
          les panes Claude Code détectés en idle/waiting, la commande `ccd
          --resume &lt;session_id&gt;` est rejouée à la restauration.
        </p>
        <button
          onClick={onClear}
          disabled={status === "clearing"}
          className="rounded border border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/70 disabled:opacity-50"
          type="button"
        >
          {status === "clearing"
            ? "Effacement…"
            : status === "cleared"
              ? "Session effacée"
              : "Effacer la session sauvegardée"}
        </button>
      </section>
    </div>
  );
}
