export type AgentStateValue =
  | { kind: "none" }
  | { kind: "idle"; session_id: string }
  | { kind: "busy"; tool?: string | null }
  | { kind: "waiting"; session_id: string };

export interface AgentEventPayload {
  session_id: string;
  cwd: string;
  state: AgentStateValue;
}

export function isActive(s: AgentStateValue): boolean {
  return s.kind === "busy" || s.kind === "waiting";
}

export function aggregate(states: AgentStateValue[]): AgentStateValue {
  // waiting outranks busy because it requires user action (AskUserQuestion,
  // ExitPlanMode) — it must be surfaced even when other agents are working.
  const order: Record<AgentStateValue["kind"], number> = {
    waiting: 4,
    busy: 3,
    idle: 2,
    none: 1,
  };
  return states.reduce<AgentStateValue>(
    (best, s) => (order[s.kind] > order[best.kind] ? s : best),
    { kind: "none" },
  );
}
