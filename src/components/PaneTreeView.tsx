import type {
  EditorProtocol,
  PaneState,
  PaneTree,
  SplitDirection,
  TerminalFont,
  TerminalPalette,
} from "@/types";
import { Terminal } from "./Terminal";
import { TerminalWebGPU } from "./TerminalWebGPU";

interface PaneTreeViewProps {
  tree: PaneTree;
  panes: Record<string, PaneState>;
  activePaneId: string;
  font: TerminalFont;
  palette: TerminalPalette;
  useWebGPU: boolean;
  editorProtocol: EditorProtocol;
  onActivate: (paneId: string) => void;
  onContextMenu: (paneId: string, x: number, y: number) => void;
  onSetRatio: (path: number[], ratio: number) => void;
  path?: number[];
}

export function PaneTreeView({
  tree,
  panes,
  activePaneId,
  font,
  palette,
  useWebGPU,
  editorProtocol,
  onActivate,
  onContextMenu,
  onSetRatio,
  path = [],
}: PaneTreeViewProps) {
  if (tree.kind === "leaf") {
    const pane = panes[tree.paneId];
    if (!pane) return null;
    const isActive = pane.id === activePaneId;
    const terminal = useWebGPU ? (
      <TerminalWebGPU
        pane={pane}
        isActive={isActive}
        font={font}
        palette={palette}
        editorProtocol={editorProtocol}
        onActivate={() => onActivate(pane.id)}
        onContextMenu={(x, y) => onContextMenu(pane.id, x, y)}
      />
    ) : (
      <Terminal
        pane={pane}
        isActive={isActive}
        font={font}
        palette={palette}
        onActivate={() => onActivate(pane.id)}
        onContextMenu={(x, y) => onContextMenu(pane.id, x, y)}
      />
    );
    return (
      <div className="relative h-full w-full">
        {terminal}
        {isActive && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{ boxShadow: "inset 0 0 0 1.5px rgba(59,130,246,0.55)" }}
          />
        )}
      </div>
    );
  }

  const isHorizontal = tree.direction === "horizontal";
  const containerClass = isHorizontal
    ? "flex flex-row h-full w-full min-h-0 min-w-0"
    : "flex flex-col h-full w-full min-h-0 min-w-0";
  const firstFlex = `${(tree.ratio * 100).toFixed(2)}%`;
  const secondFlex = `${((1 - tree.ratio) * 100).toFixed(2)}%`;

  return (
    <div className={containerClass}>
      <div
        style={{ flexBasis: firstFlex }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <PaneTreeView
          tree={tree.first}
          panes={panes}
          activePaneId={activePaneId}
          font={font}
          palette={palette}
          useWebGPU={useWebGPU}
          editorProtocol={editorProtocol}
          onActivate={onActivate}
          onContextMenu={onContextMenu}
          onSetRatio={onSetRatio}
          path={[...path, 0]}
        />
      </div>
      <ResizeHandle
        direction={tree.direction}
        onSetRatio={(ratio) => onSetRatio(path, ratio)}
      />
      <div
        style={{ flexBasis: secondFlex }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <PaneTreeView
          tree={tree.second}
          panes={panes}
          activePaneId={activePaneId}
          font={font}
          palette={palette}
          useWebGPU={useWebGPU}
          editorProtocol={editorProtocol}
          onActivate={onActivate}
          onContextMenu={onContextMenu}
          onSetRatio={onSetRatio}
          path={[...path, 1]}
        />
      </div>
    </div>
  );
}

interface ResizeHandleProps {
  direction: SplitDirection;
  onSetRatio: (ratio: number) => void;
}

function ResizeHandle({ direction, onSetRatio }: ResizeHandleProps) {
  const isHorizontal = direction === "horizontal";

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const parent = e.currentTarget.parentElement;
    if (!parent) return;

    const onMove = (ev: MouseEvent) => {
      const rect = parent.getBoundingClientRect();
      const pos = isHorizontal
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      const clamped = Math.min(0.95, Math.max(0.05, pos));
      onSetRatio(clamped);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      onMouseDown={onMouseDown}
      className={
        isHorizontal
          ? "w-1 shrink-0 cursor-col-resize bg-zinc-900 transition-colors hover:bg-zinc-700"
          : "h-1 shrink-0 cursor-row-resize bg-zinc-900 transition-colors hover:bg-zinc-700"
      }
    />
  );
}
