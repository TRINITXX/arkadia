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
  const order: Record<AgentStateValue["kind"], number> = {
    busy: 4,
    waiting: 3,
    idle: 2,
    none: 1,
  };
  return states.reduce<AgentStateValue>(
    (best, s) => (order[s.kind] > order[best.kind] ? s : best),
    { kind: "none" },
  );
}
