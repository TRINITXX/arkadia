import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import {
  readText as readClipboard,
  writeText as writeClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import { Renderer } from "@renderer/terminal_renderer.js";
import { ensureWasmReady, paletteToWasm } from "@/lib/wasmRenderer";
import { measureCellSize } from "@/lib/cellSize";
import { findClickableAt, type ClickableMatch } from "@/lib/urlDetect";
import type {
  CellRun,
  EditorProtocol,
  PaneState,
  RenderPayload,
  SearchHit,
  TerminalFont,
  TerminalPalette,
} from "@/types";

const fontBytesCache = new Map<string, Promise<Uint8Array | null>>();

function loadFontBytes(family: string): Promise<Uint8Array | null> {
  const primary =
    family
      .split(",")[0]
      ?.trim()
      .replace(/^["']|["']$/g, "") ?? "";
  if (!primary) return Promise.resolve(null);
  let promise = fontBytesCache.get(primary);
  if (!promise) {
    promise = invoke<number[] | Uint8Array>("get_font_data", {
      family: primary,
    })
      .then((raw) => (raw instanceof Uint8Array ? raw : new Uint8Array(raw)))
      .catch((e) => {
        console.warn(`[arkadia] '${primary}' not found on system:`, e);
        return null;
      });
    fontBytesCache.set(primary, promise);
  }
  return promise;
}

interface HoverRange {
  match: ClickableMatch;
  row: number;
  startCol: number;
  endCol: number;
}

interface VisibleHit {
  row: number;
  startCol: number;
  endCol: number;
  /** True for the currently-selected hit (orange instead of yellow). */
  current: boolean;
}

/**
 * Project backend hits (`total_row`) onto the visible viewport given the
 * current scroll position. `scroll_max` is the scrollback length, so visible
 * row 0 = `scroll_max - scroll_offset` in total coords.
 */
function visibleHitsForScreen(
  screen: RenderPayload,
  hits: SearchHit[],
  currentIdx: number,
): VisibleHit[] {
  const visibleStart = screen.scroll_max - screen.scroll_offset;
  const out: VisibleHit[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const visRow = h.total_row - visibleStart;
    if (visRow < 0 || visRow >= screen.rows) continue;
    out.push({
      row: visRow,
      startCol: h.start_col,
      endCol: h.end_col,
      current: i === currentIdx,
    });
  }
  return out;
}

/** Adds a yellow background over the cells covered by `hits` (orange for current). Splits affected runs. */
function applySearchHighlight(
  screen: RenderPayload,
  hits: VisibleHit[],
  highlightColor: string,
  currentColor: string,
): RenderPayload {
  if (hits.length === 0) return screen;
  const byRow = new Map<number, VisibleHit[]>();
  for (const hit of hits) {
    const arr = byRow.get(hit.row);
    if (arr) arr.push(hit);
    else byRow.set(hit.row, [hit]);
  }
  const newLines = screen.lines.slice();
  for (const [row, rowHits] of byRow) {
    const original = newLines[row];
    if (!original) continue;
    const newRuns: CellRun[] = [];
    let col = 0; // tracked in cell columns
    for (const run of original) {
      const cellWidth = run.cell_width ?? 1;
      const chars = [...run.text];
      const runEnd = col + chars.length * cellWidth;
      let charCursor = 0;
      while (charCursor < chars.length) {
        const absCol = col + charCursor * cellWidth;
        const inHit = rowHits.find(
          (h) => absCol >= h.startCol && absCol < h.endCol,
        );
        if (inHit) {
          let endChars = charCursor + 1;
          while (
            endChars < chars.length &&
            col + endChars * cellWidth < inHit.endCol
          ) {
            endChars++;
          }
          newRuns.push({
            ...run,
            text: chars.slice(charCursor, endChars).join(""),
            bg: {
              kind: "rgb",
              value: inHit.current ? currentColor : highlightColor,
            },
            fg: { kind: "rgb", value: "#000000" },
          });
          charCursor = endChars;
        } else {
          let endChars = chars.length;
          for (const h of rowHits) {
            if (h.startCol <= absCol) continue;
            const hitStartChar = Math.ceil((h.startCol - col) / cellWidth);
            if (hitStartChar > charCursor && hitStartChar < endChars) {
              endChars = hitStartChar;
            }
          }
          newRuns.push({
            ...run,
            text: chars.slice(charCursor, endChars).join(""),
          });
          charCursor = endChars;
        }
      }
      col = runEnd;
    }
    newLines[row] = newRuns;
  }
  return { ...screen, lines: newLines };
}

/**
 * Builds the editor-specific URL for opening a file path with optional line
 * and column anchors. VSCode, Cursor and Fleet all use the
 * `<scheme>://file/<path>:line:col` convention; IntelliJ IDEA uses query
 * parameters.
 */
function buildEditorUrl(
  protocol: EditorProtocol,
  absPath: string,
  line?: number,
  col?: number,
): string {
  const fwdPath = absPath.replace(/\\/g, "/");
  if (protocol === "idea") {
    const params = new URLSearchParams();
    params.set("file", fwdPath);
    if (line !== undefined) params.set("line", String(line));
    if (col !== undefined) params.set("column", String(col));
    return `idea://open?${params.toString()}`;
  }
  let url = `${protocol}://file/${fwdPath}`;
  if (line !== undefined) {
    url += `:${line}`;
    if (col !== undefined) url += `:${col}`;
  }
  return url;
}

/** Resolves a path against `cwd` (for relative paths) and emits an editor
 *  URL with optional line/col anchors. Returns plain http(s) for URL/hyperlink. */
function clickableToOpenTarget(
  match: ClickableMatch,
  cwd: string | null,
  protocol: EditorProtocol,
): string {
  if (match.kind === "url" || match.kind === "hyperlink") return match.url;
  // path
  let abs = match.path;
  // Heuristic: a relative path doesn't start with `[A-Za-z]:` or `/` or `\`.
  const isAbs =
    /^[a-zA-Z]:[\\/]/.test(abs) || abs.startsWith("/") || abs.startsWith("\\");
  if (!isAbs && cwd) {
    const sep = cwd.includes("\\") ? "\\" : "/";
    abs = cwd.replace(/[\\/]+$/, "") + sep + abs;
  }
  return buildEditorUrl(protocol, abs, match.line, match.col);
}

/**
 * Returns a shallow-cloned screen with the cells covering `hover` flagged
 * `underline: true`. Splits the affected runs at the URL boundaries.
 */
function applyHoverUnderline(
  screen: RenderPayload,
  hover: HoverRange | null,
): RenderPayload {
  if (!hover) return screen;
  const { row, startCol, endCol } = hover;
  if (row < 0 || row >= screen.lines.length) return screen;
  const original = screen.lines[row];
  const newRuns: CellRun[] = [];
  let col = 0; // tracked in cell columns
  for (const run of original) {
    const cellWidth = run.cell_width ?? 1;
    const chars = [...run.text];
    const cellLen = chars.length * cellWidth;
    const runEnd = col + cellLen;
    if (runEnd <= startCol || col >= endCol) {
      newRuns.push(run);
    } else {
      const localStartCells = Math.max(0, startCol - col);
      const localEndCells = Math.min(cellLen, endCol - col);
      // Snap to wide-char boundaries to avoid splitting a wide grapheme.
      const localStartChars = Math.floor(localStartCells / cellWidth);
      const localEndChars = Math.ceil(localEndCells / cellWidth);
      if (localStartChars > 0) {
        newRuns.push({
          ...run,
          text: chars.slice(0, localStartChars).join(""),
        });
      }
      newRuns.push({
        ...run,
        text: chars.slice(localStartChars, localEndChars).join(""),
        underline_style: 1,
      });
      if (localEndChars < chars.length) {
        newRuns.push({ ...run, text: chars.slice(localEndChars).join("") });
      }
    }
    col = runEnd;
  }
  const newLines = screen.lines.slice();
  newLines[row] = newRuns;
  return { ...screen, lines: newLines };
}

/** True iff the running app has activated some form of mouse tracking. */
function mouseModeActive(screen: RenderPayload | null): boolean {
  return (screen?.mouse_protocol ?? 0) > 0;
}

/**
 * If `col` lands on the right half of a wide grapheme, returns the column of
 * its main (left half) so URL/path/hyperlink lookups land on the right cell.
 * Otherwise returns `col` unchanged.
 */
function snapToWideMain(
  screen: RenderPayload | null,
  col: number,
  row: number,
): number {
  if (!screen) return col;
  const line = screen.lines[row];
  if (!line) return col;
  let c = 0;
  for (const run of line) {
    const cellWidth = run.cell_width ?? 1;
    const len = [...run.text].length * cellWidth;
    if (col >= c && col < c + len) {
      if (cellWidth === 2 && (col - c) % 2 === 1) return col - 1;
      return col;
    }
    c += len;
  }
  return col;
}

/** Packs keyboard modifiers into the bit layout the backend expects. */
function mouseModifiers(e: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}): number {
  return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0);
}

function keyEventToBytes(e: React.KeyboardEvent): Uint8Array | null {
  switch (e.key) {
    case "Enter":
      return new TextEncoder().encode("\r");
    case "Backspace":
      return new Uint8Array([0x7f]);
    case "Tab":
      return new TextEncoder().encode("\t");
    case "Escape":
      return new TextEncoder().encode("\x1b");
    case "ArrowUp":
      return new TextEncoder().encode("\x1b[A");
    case "ArrowDown":
      return new TextEncoder().encode("\x1b[B");
    case "ArrowRight":
      return new TextEncoder().encode("\x1b[C");
    case "ArrowLeft":
      return new TextEncoder().encode("\x1b[D");
    case "Home":
      return new TextEncoder().encode("\x1b[H");
    case "End":
      return new TextEncoder().encode("\x1b[F");
    case "PageUp":
      return new TextEncoder().encode("\x1b[5~");
    case "PageDown":
      return new TextEncoder().encode("\x1b[6~");
    case "Insert":
      return new TextEncoder().encode("\x1b[2~");
    case "Delete":
      return new TextEncoder().encode("\x1b[3~");
  }
  if (e.key.startsWith("F") && e.key.length <= 3) {
    const n = parseInt(e.key.slice(1), 10);
    if (n >= 1 && n <= 4) {
      return new TextEncoder().encode(`\x1bO${"PQRS"[n - 1]}`);
    }
    if (n >= 5 && n <= 12) {
      const map: Record<number, string> = {
        5: "15",
        6: "17",
        7: "18",
        8: "19",
        9: "20",
        10: "21",
        11: "23",
        12: "24",
      };
      return new TextEncoder().encode(`\x1b[${map[n]}~`);
    }
  }
  if (e.key.length === 1) {
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const code = e.key.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) return new Uint8Array([code - 96]);
      if (e.key === "@") return new Uint8Array([0x00]);
      if (e.key === "[") return new Uint8Array([0x1b]);
      if (e.key === "\\") return new Uint8Array([0x1c]);
      if (e.key === "]") return new Uint8Array([0x1d]);
      if (e.key === "^") return new Uint8Array([0x1e]);
      if (e.key === "_") return new Uint8Array([0x1f]);
      return null;
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const enc = new TextEncoder().encode(e.key);
      const out = new Uint8Array(enc.length + 1);
      out[0] = 0x1b;
      out.set(enc, 1);
      return out;
    }
    return new TextEncoder().encode(e.key);
  }
  return null;
}

interface Props {
  pane: PaneState;
  isActive: boolean;
  font: TerminalFont;
  palette: TerminalPalette;
  editorProtocol: EditorProtocol;
  onActivate: () => void;
  onContextMenu: (x: number, y: number) => void;
}

export function TerminalWebGPU({
  pane,
  isActive,
  font,
  palette,
  editorProtocol,
  onActivate,
  onContextMenu,
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const readyRef = useRef(false);
  const [rendererVersion, setRendererVersion] = useState(0);
  const focusedRef = useRef(false);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHitCount, setSearchHitCount] = useState(0);
  const [searchCurrent1, setSearchCurrent1] = useState(0); // 1-based, 0 = none
  const allHitsRef = useRef<SearchHit[]>([]);
  const currentHitIdxRef = useRef<number>(-1);
  const visibleHitsRef = useRef<VisibleHit[]>([]);
  // Latest payload, kept in a ref so the resize observer can repaint
  // without re-creating itself on every render.
  const screenRef = useRef(pane.screen);
  useEffect(() => {
    screenRef.current = pane.screen;
  }, [pane.screen]);

  // Mouse-selection state. cellRef is the CSS-pixel cell size so we can
  // convert mouse coords → grid cells without a fresh measurement.
  const cellRef = useRef<{ w: number; h: number }>({ w: 1, h: 1 });
  const dragStartRef = useRef<{ col: number; row: number } | null>(null);
  const dragMovedRef = useRef(false);
  const hoveredUrlRef = useRef<HoverRange | null>(null);
  const pendingClickRef = useRef<ClickableMatch | null>(null);
  // When the running TUI has mouse tracking on and the user presses a button
  // without Shift, we forward the press to the PTY and keep the originating
  // button here so that the matching mouseup/mousemove can route too.
  const mouseEventActiveRef = useRef<{ button: number } | null>(null);
  // Dedup motion events to one per cell. Browsers fire mousemove on every
  // pixel of motion; TUIs only care when we cross a cell boundary.
  const lastMouseCellRef = useRef<{ col: number; row: number } | null>(null);

  const recomputeVisibleHits = () => {
    const screen = screenRef.current;
    if (!screen || allHitsRef.current.length === 0) {
      visibleHitsRef.current = [];
      return;
    }
    visibleHitsRef.current = visibleHitsForScreen(
      screen,
      allHitsRef.current,
      currentHitIdxRef.current,
    );
  };

  const redraw = () => {
    const r = rendererRef.current;
    const screen = screenRef.current;
    if (!readyRef.current || !r || !screen) return;
    recomputeVisibleHits();
    let modified = applySearchHighlight(
      screen,
      visibleHitsRef.current,
      "#fde047", // yellow for non-current hits
      "#fb923c", // orange for the current hit
    );
    modified = applyHoverUnderline(modified, hoveredUrlRef.current);
    r.draw(modified);
  };

  const scrollToHit = (idx: number) => {
    const screen = screenRef.current;
    if (!screen || allHitsRef.current.length === 0) return;
    const hit = allHitsRef.current[idx];
    if (!hit) return;
    // Center the hit row in the viewport.
    const desiredOffset =
      screen.scroll_max - hit.total_row + Math.floor(screen.rows / 2);
    const target = Math.max(0, Math.min(screen.scroll_max, desiredOffset));
    const delta = target - screen.scroll_offset;
    if (delta !== 0) {
      void invoke("scroll_terminal", { sessionId: pane.id, delta });
    } else {
      // Already on screen — just refresh the highlight.
      redraw();
    }
  };

  const gotoHit = (idx: number) => {
    const hits = allHitsRef.current;
    if (hits.length === 0) {
      currentHitIdxRef.current = -1;
      setSearchCurrent1(0);
      return;
    }
    const realIdx = ((idx % hits.length) + hits.length) % hits.length;
    currentHitIdxRef.current = realIdx;
    setSearchCurrent1(realIdx + 1);
    scrollToHit(realIdx);
  };

  const cellAt = (clientX: number, clientY: number) => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return { col: 0, row: 0 };
    const rect = wrapper.getBoundingClientRect();
    const col = Math.max(
      0,
      Math.floor((clientX - rect.left) / cellRef.current.w),
    );
    const row = Math.max(
      0,
      Math.floor((clientY - rect.top) / cellRef.current.h),
    );
    return { col, row };
  };

  // ─── 1. Init / teardown — once per pane ─────────────────────────
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await ensureWasmReady();
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      try {
        const renderer = await Renderer.new(canvas);
        if (cancelled) {
          renderer.free();
          return;
        }
        rendererRef.current = renderer;
        readyRef.current = true;
        renderer.set_palette(paletteToWasm(palette));
        const dpr = window.devicePixelRatio || 1;
        // Rasterize at the device-pixel size so the atlas glyphs match the
        // shader's cell_size (which is also in device pixels).
        renderer.set_font_size(Math.max(1, Math.round(font.size * dpr)));
        renderer.set_focused(focusedRef.current);
        const cell = measureCellSize(font.family, font.size);
        // Seed the swap chain with the wrapper's real pixel size. The resize
        // observer below only fires when dimensions *change* — without this,
        // the surface stays at the CSS-sized configuration set in `Renderer::new`
        // while `cell_size` is in device pixels, blowing cells up by a factor
        // of `dpr`.
        const wrapper = wrapperRef.current;
        if (wrapper) {
          const rect = wrapper.getBoundingClientRect();
          const pw = Math.max(1, Math.floor(rect.width * dpr));
          const ph = Math.max(1, Math.floor(rect.height * dpr));
          canvas.width = pw;
          canvas.height = ph;
          renderer.resize(pw, ph);
        }
        renderer.set_cell_size(cell.width * dpr, cell.height * dpr);
        const fontBytes = await loadFontBytes(font.family);
        if (cancelled) {
          renderer.free();
          return;
        }
        if (fontBytes) {
          const ok = renderer.set_primary_font(fontBytes);
          if (ok) {
            const cell2 = measureCellSize(font.family, font.size);
            renderer.set_cell_size(cell2.width * dpr, cell2.height * dpr);
          }
        }
        redraw();
        setRendererVersion((v) => v + 1);
      } catch (e) {
        console.error("[arkadia] Renderer.new failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      readyRef.current = false;
      rendererRef.current?.free();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  // ─── 2. Palette change ──────────────────────────────────────────
  useEffect(() => {
    const r = rendererRef.current;
    if (!readyRef.current || !r) return;
    r.set_palette(paletteToWasm(palette));
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palette]);

  // ─── 3. Font size change ───────────────────────────────────────
  useEffect(() => {
    const r = rendererRef.current;
    if (!readyRef.current || !r) return;
    const dpr = window.devicePixelRatio || 1;
    r.set_font_size(Math.max(1, Math.round(font.size * dpr)));
    const cell = measureCellSize(font.family, font.size);
    r.set_cell_size(cell.width * dpr, cell.height * dpr);
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font.family, font.size]);

  // ─── 3b. Font family swap (load system font into the GPU atlas) ──
  // The Rust renderer bundles Cascadia by default and has no access to
  // system fonts (WASM sandbox). We resolve the font on the Tauri host
  // via `get_font_data`, then hand the raw bytes to the renderer.
  useEffect(() => {
    let cancelled = false;
    const r = rendererRef.current;
    if (!readyRef.current || !r) return;
    const primary =
      font.family
        .split(",")[0]
        ?.trim()
        .replace(/^["']|["']$/g, "") ?? "";
    if (!primary) return;
    void (async () => {
      try {
        const raw = await invoke<number[] | Uint8Array>("get_font_data", {
          family: primary,
        });
        if (cancelled) return;
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        const live = rendererRef.current;
        if (!live || !readyRef.current) return;
        const ok = live.set_primary_font(bytes);
        if (!ok) {
          console.warn(
            `[arkadia] '${primary}' rejected by renderer, keeping previous font`,
          );
          return;
        }
        const dpr = window.devicePixelRatio || 1;
        const cell = measureCellSize(font.family, font.size);
        live.set_cell_size(cell.width * dpr, cell.height * dpr);
        redraw();
      } catch (e) {
        console.warn(`[arkadia] '${primary}' not found on system:`, e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [font.family, rendererVersion]);

  // ─── 4. New payload from backend ───────────────────────────────
  useEffect(() => {
    if (!pane.screen) return;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.screen]);

  // ─── 5. Resize: update canvas pixels + PTY cols/rows ───────────
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    const cell = measureCellSize(font.family, font.size);
    let lastCols = -1;
    let lastRows = -1;
    let timer: ReturnType<typeof setTimeout> | null = null;

    cellRef.current = { w: cell.width, h: cell.height };

    const apply = (cssWidth: number, cssHeight: number) => {
      if (cssWidth <= 0 || cssHeight <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));
      // Sync canvas backing store with the wrapper's CSS size × DPR.
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      const r = rendererRef.current;
      if (r && readyRef.current) {
        r.resize(pixelWidth, pixelHeight);
        r.set_cell_size(cell.width * dpr, cell.height * dpr);
        redraw();
      }
      const cols = Math.max(20, Math.floor(cssWidth / cell.width));
      const rows = Math.max(5, Math.floor(cssHeight / cell.height));
      if (cols === lastCols && rows === lastRows) return;
      lastCols = cols;
      lastRows = rows;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void invoke("resize_terminal", {
          sessionId: pane.id,
          cols,
          rows,
        });
      }, 50);
    };

    const observer = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      apply(e.contentRect.width, e.contentRect.height);
    });
    observer.observe(wrapper);
    const rect = wrapper.getBoundingClientRect();
    apply(rect.width, rect.height);

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id, font.family, font.size]);

  // ─── 6. Focus ─────────────────────────────────────────────────
  useEffect(() => {
    if (isActive) outerRef.current?.focus();
  }, [isActive]);

  const onKeyDown = async (e: React.KeyboardEvent<HTMLDivElement>) => {
    const r = rendererRef.current;

    // Ctrl+F: open search overlay.
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      setSearchOpen(true);
      return;
    }

    // Ctrl+V: read clipboard and inject into the PTY as input bytes.
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "v") {
      e.preventDefault();
      try {
        const text = await readClipboard();
        if (text && text.length > 0) {
          const bytes = Array.from(new TextEncoder().encode(text));
          await invoke("send_input", { sessionId: pane.id, bytes });
        }
      } catch (err) {
        console.error("[arkadia] paste failed:", err);
      }
      return;
    }

    // Ctrl+C: copy if a selection is active, otherwise fall through to SIGINT.
    if (
      r &&
      e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      e.key.toLowerCase() === "c" &&
      r.has_selection()
    ) {
      const text = r.selection_text();
      if (text.length > 0) {
        e.preventDefault();
        try {
          await writeClipboard(text);
        } catch (err) {
          console.error("[arkadia] clipboard write failed:", err);
        }
        r.clear_selection();
        redraw();
        return;
      }
    }
    const bytes = keyEventToBytes(e);
    if (bytes) {
      e.preventDefault();
      await invoke("send_input", {
        sessionId: pane.id,
        bytes: Array.from(bytes),
      });
    }
  };

  // Window-level mousemove/up listeners so a drag continues even when the
  // cursor leaves the canvas.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      // Mouse-mode passthrough: forward motion when the running app subscribes
      // to it (1003 always, 1002 only while a button is held).
      const screen = screenRef.current;
      if (mouseModeActive(screen)) {
        const proto = screen!.mouse_protocol;
        const active = mouseEventActiveRef.current;
        const shouldMove = proto === 3 || (proto === 2 && !!active);
        if (shouldMove) {
          const { col, row } = cellAt(e.clientX, e.clientY);
          const last = lastMouseCellRef.current;
          if (last && last.col === col && last.row === row) return;
          lastMouseCellRef.current = { col, row };
          const btn = active?.button ?? 3; // 3 = no button (X11 convention)
          void invoke("send_mouse_event", {
            sessionId: pane.id,
            col,
            row,
            button: btn,
            modifiers: 0,
            motion: true,
            pressed: true,
          });
        }
        return;
      }

      const start = dragStartRef.current;
      const r = rendererRef.current;
      if (!start || !r) return;
      const { col, row } = cellAt(e.clientX, e.clientY);
      if (col === start.col && row === start.row) return;
      // First real move: commit the start of the selection.
      if (!dragMovedRef.current) {
        dragMovedRef.current = true;
        // Drag cancels any pending click.
        pendingClickRef.current = null;
        // Clear any prior selection from a previous drag now that we know
        // this gesture is actually a drag.
        r.clear_selection();
      }
      r.set_selection(start.col, start.row, col, row);
    };
    const onUp = async (e: MouseEvent) => {
      // Mouse-mode passthrough: emit release for the press-button we recorded.
      const active = mouseEventActiveRef.current;
      if (active && mouseModeActive(screenRef.current)) {
        mouseEventActiveRef.current = null;
        lastMouseCellRef.current = null;
        const { col, row } = cellAt(e.clientX, e.clientY);
        void invoke("send_mouse_event", {
          sessionId: pane.id,
          col,
          row,
          button: active.button,
          modifiers: 0,
          motion: false,
          pressed: false,
        });
        return;
      }

      const start = dragStartRef.current;
      dragStartRef.current = null;
      const r = rendererRef.current;

      // Click-without-drag on a clickable target (URL, OSC 8, path) → open.
      if (start && !dragMovedRef.current && pendingClickRef.current) {
        const match = pendingClickRef.current;
        pendingClickRef.current = null;
        if (r) {
          r.clear_selection();
          redraw();
        }
        try {
          const target = clickableToOpenTarget(match, pane.cwd, editorProtocol);
          await openExternal(target);
        } catch (err) {
          console.error("[arkadia] open clickable failed:", err);
        }
        dragMovedRef.current = false;
        return;
      }

      pendingClickRef.current = null;
      if (!r || !start) return;
      // Plain click (no movement) → drop any existing selection.
      if (!dragMovedRef.current) {
        r.clear_selection();
        redraw();
      }
      dragMovedRef.current = false;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.id]);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Mouse-mode passthrough: forward press to the PTY and skip local
    // drag-select / click-to-open. Shift bypasses (selection convention).
    if (mouseModeActive(pane.screen) && !e.shiftKey && e.button <= 2) {
      e.preventDefault();
      if (!isActive) onActivate();
      outerRef.current?.focus();
      const { col, row } = cellAt(e.clientX, e.clientY);
      mouseEventActiveRef.current = { button: e.button };
      lastMouseCellRef.current = { col, row };
      void invoke("send_mouse_event", {
        sessionId: pane.id,
        col,
        row,
        button: e.button,
        modifiers: mouseModifiers(e),
        motion: false,
        pressed: true,
      });
      return;
    }

    // Local drag-select path: only the primary (left) button.
    if (e.button !== 0) return;

    if (!isActive) onActivate();
    outerRef.current?.focus();
    const { col, row } = cellAt(e.clientX, e.clientY);
    // If we're hovering a clickable target, remember it. mouseup will open it
    // iff there was no drag — drag cancels the click and starts a selection.
    pendingClickRef.current = hoveredUrlRef.current?.match ?? null;
    // Don't draw a selection yet — we wait for the first real move so a
    // pure click stays click-shaped. mousemove will commit the selection.
    dragStartRef.current = { col, row };
    dragMovedRef.current = false;
  };

  // ─── Search invocation: query the backend whenever the query changes
  // (debounced 100ms). Backend search spans full scrollback + visible.
  useEffect(() => {
    if (!searchOpen || searchQuery.length === 0) {
      allHitsRef.current = [];
      currentHitIdxRef.current = -1;
      setSearchHitCount(0);
      setSearchCurrent1(0);
      redraw();
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<SearchHit[]>("search_terminal", {
        sessionId: pane.id,
        query: searchQuery,
      })
        .then((hits) => {
          if (cancelled) return;
          allHitsRef.current = hits;
          setSearchHitCount(hits.length);
          if (hits.length > 0) {
            currentHitIdxRef.current = 0;
            setSearchCurrent1(1);
            scrollToHit(0);
          } else {
            currentHitIdxRef.current = -1;
            setSearchCurrent1(0);
            redraw();
          }
        })
        .catch((e) => {
          console.error("[arkadia] search failed:", e);
        });
    }, 100);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen, searchQuery, pane.id]);

  // Re-derive visible hits + redraw on every screen update, so the highlight
  // tracks new output without re-running the backend search.
  useEffect(() => {
    if (!searchOpen) return;
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane.screen]);

  // ─── Scrollbar fade-in/out: visible when scrolled into history,
  // fades out after 1.5s of inactivity at the bottom (live).
  const lastOffsetRef = useRef(0);
  useEffect(() => {
    const offset = pane.screen?.scroll_offset ?? 0;
    const max = pane.screen?.scroll_max ?? 0;
    if (max === 0) {
      setScrollbarVisible(false);
      return;
    }
    if (offset !== lastOffsetRef.current) {
      lastOffsetRef.current = offset;
      setScrollbarVisible(true);
    }
    if (offset === 0) {
      const t = window.setTimeout(() => setScrollbarVisible(false), 1500);
      return () => window.clearTimeout(t);
    } else {
      setScrollbarVisible(true);
    }
  }, [pane.screen?.scroll_offset, pane.screen?.scroll_max]);

  // ─── 7. Wheel scroll into history ──────────────────────────────
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    let pendingDelta = 0;
    let rafScheduled = false;
    const flush = () => {
      rafScheduled = false;
      if (pendingDelta === 0) return;
      const delta = pendingDelta;
      pendingDelta = 0;
      void invoke("scroll_terminal", { sessionId: pane.id, delta });
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      // Mouse-mode passthrough: encode wheel up/down as buttons 64/65 at the
      // cursor's current cell. One PTY event per wheel notch (no batching).
      if (mouseModeActive(screenRef.current)) {
        const button = e.deltaY > 0 ? 65 : 64;
        const { col, row } = cellAt(e.clientX, e.clientY);
        void invoke("send_mouse_event", {
          sessionId: pane.id,
          col,
          row,
          button,
          modifiers: mouseModifiers(e),
          motion: false,
          pressed: true,
        });
        return;
      }
      // Backend convention: positive delta = scroll INTO history.
      // Browser: deltaY > 0 = scroll DOWN (toward live) = decrement offset.
      pendingDelta += -Math.sign(e.deltaY) * 3;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    };
    outer.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      outer.removeEventListener("wheel", onWheel);
    };
  }, [pane.id]);

  // URL hover : pointer cursor + on-screen underline. Recomputed on every
  // mousemove (window-level so we still clear when the cursor leaves the
  // wrapper).
  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    let cursorIsPointer = false;

    const setHover = (next: HoverRange | null) => {
      const cur = hoveredUrlRef.current;
      const same =
        cur === next ||
        (!!cur &&
          !!next &&
          cur.row === next.row &&
          cur.startCol === next.startCol &&
          cur.endCol === next.endCol &&
          cur.match.kind === next.match.kind &&
          ("url" in cur.match
            ? "url" in next.match && cur.match.url === next.match.url
            : "path" in cur.match
              ? "path" in next.match && cur.match.path === next.match.path
              : true));
      if (same) return;
      hoveredUrlRef.current = next;
      redraw();
    };

    const onMove = (e: MouseEvent) => {
      const wrapper = wrapperRef.current;
      const screen = screenRef.current;
      // Mouse mode active: the running app paints its own cursors; we suppress
      // the URL/path hover affordances entirely.
      if (!wrapper || !screen || mouseModeActive(screen)) {
        if (cursorIsPointer) {
          outer.style.cursor = "";
          cursorIsPointer = false;
        }
        setHover(null);
        return;
      }
      const rect = wrapper.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        if (cursorIsPointer) {
          outer.style.cursor = "";
          cursorIsPointer = false;
        }
        setHover(null);
        return;
      }
      const cw = cellRef.current.w;
      const ch = cellRef.current.h;
      if (cw <= 0 || ch <= 0) return;
      const rawCol = Math.floor((e.clientX - rect.left) / cw);
      const row = Math.floor((e.clientY - rect.top) / ch);
      const col = snapToWideMain(screen, rawCol, row);
      const match = findClickableAt(screen, col, row);
      const next: HoverRange | null = match
        ? {
            match,
            row: match.row,
            startCol: match.startCol,
            endCol: match.endCol,
          }
        : null;
      setHover(next);
      const wantPointer = !!match;
      if (wantPointer !== cursorIsPointer) {
        outer.style.cursor = wantPointer ? "pointer" : "";
        cursorIsPointer = wantPointer;
      }
    };

    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      outer.style.cursor = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={outerRef}
      tabIndex={0}
      onFocus={() => {
        focusedRef.current = true;
        rendererRef.current?.set_focused(true);
        if (!isActive) onActivate();
      }}
      onBlur={() => {
        focusedRef.current = false;
        rendererRef.current?.set_focused(false);
      }}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onContextMenu={(e) => {
        e.preventDefault();
        // Mouse-mode: onMouseDown already encoded the right-click — swallow the
        // panel menu unless Shift bypass is held.
        if (mouseModeActive(pane.screen) && !e.shiftKey) {
          return;
        }
        if (!isActive) onActivate();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{
        backgroundColor: palette.bg,
        outline: "none",
        padding: 20,
      }}
      className="relative h-full w-full overflow-hidden"
    >
      <div ref={wrapperRef} className="relative h-full w-full">
        <canvas ref={canvasRef} className="block h-full w-full" />
        <ScrollbarOverlay
          screen={pane.screen}
          visible={scrollbarVisible}
          fg={palette.fg}
        />
        {searchOpen && (
          <SearchOverlay
            query={searchQuery}
            onChange={setSearchQuery}
            hitCount={searchHitCount}
            currentIdx={searchCurrent1}
            onNext={() => gotoHit(currentHitIdxRef.current + 1)}
            onPrev={() => gotoHit(currentHitIdxRef.current - 1)}
            onClose={() => {
              setSearchOpen(false);
              setSearchQuery("");
              allHitsRef.current = [];
              currentHitIdxRef.current = -1;
              setSearchHitCount(0);
              setSearchCurrent1(0);
              redraw();
              outerRef.current?.focus();
            }}
            palette={palette}
          />
        )}
      </div>
    </div>
  );
}

function SearchOverlay({
  query,
  onChange,
  hitCount,
  currentIdx,
  onNext,
  onPrev,
  onClose,
  palette,
}: {
  query: string;
  onChange: (q: string) => void;
  hitCount: number;
  /** 1-based; 0 means "no hit". */
  currentIdx: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  palette: TerminalPalette;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const btnStyle: React.CSSProperties = {
    background: "transparent",
    border: "none",
    color: palette.fg,
    opacity: hitCount === 0 ? 0.25 : 0.6,
    cursor: hitCount === 0 ? "default" : "pointer",
    padding: "0 4px",
    fontSize: 14,
    lineHeight: 1,
  };
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 10px",
        backgroundColor: "rgba(20, 20, 22, 0.92)",
        border: `1px solid ${palette.fg}33`,
        borderRadius: 6,
        boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
        color: palette.fg,
        fontFamily: "inherit",
        fontSize: 13,
        zIndex: 10,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key === "Enter" || e.key === "F3") {
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) onPrev();
            else onNext();
            return;
          }
          // Stop other keys from reaching the terminal handler.
          e.stopPropagation();
        }}
        placeholder="Search…"
        autoComplete="off"
        spellCheck={false}
        style={{
          background: "transparent",
          border: "none",
          outline: "none",
          color: palette.fg,
          width: 160,
          fontFamily: "inherit",
        }}
      />
      <span
        style={{
          opacity: 0.6,
          minWidth: 56,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {query.length === 0
          ? ""
          : hitCount === 0
            ? "no match"
            : `${currentIdx} / ${hitCount}`}
      </span>
      <button
        onClick={onPrev}
        disabled={hitCount === 0}
        style={btnStyle}
        aria-label="Previous match"
      >
        ↑
      </button>
      <button
        onClick={onNext}
        disabled={hitCount === 0}
        style={btnStyle}
        aria-label="Next match"
      >
        ↓
      </button>
      <button
        onClick={onClose}
        style={{ ...btnStyle, opacity: 0.6, cursor: "pointer", fontSize: 16 }}
        aria-label="Close search"
      >
        ×
      </button>
    </div>
  );
}

function ScrollbarOverlay({
  screen,
  visible,
  fg,
}: {
  screen: RenderPayload | null;
  visible: boolean;
  fg: string;
}) {
  if (!screen || screen.scroll_max === 0) return null;
  const total = screen.scroll_max + screen.rows;
  const thumbHeightPct = Math.max(4, (screen.rows / total) * 100);
  const thumbTopPct =
    ((screen.scroll_max - screen.scroll_offset) / total) * 100;
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        top: 2,
        right: 2,
        bottom: 2,
        width: 6,
        opacity: visible ? 0.5 : 0,
        transition: "opacity 250ms ease-out",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${thumbTopPct}%`,
          height: `${thumbHeightPct}%`,
          backgroundColor: fg,
          borderRadius: 3,
          minHeight: 12,
        }}
      />
    </div>
  );
}
