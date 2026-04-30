import type { AgentStateValue } from "@/lib/agentState";

interface AgentBadgeProps {
  state: AgentStateValue;
  size?: number;
}

export function AgentBadge({ state, size = 8 }: AgentBadgeProps) {
  if (state.kind === "none" || state.kind === "idle") return null;
  const cls =
    state.kind === "busy" ? "bg-amber-500 animate-pulse" : "bg-cyan-500";
  const tooltip =
    state.kind === "busy"
      ? state.tool
        ? `Claude bosse: ${state.tool}…`
        : "Claude bosse…"
      : "Claude attend une réponse";
  return (
    <span
      title={tooltip}
      className={`absolute -top-0.5 -right-0.5 rounded-full ring-1 ring-zinc-900/50 ${cls}`}
      style={{ width: size, height: size }}
    />
  );
}
