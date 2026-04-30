use std::time::{Duration, Instant};

use super::parse::Entry;

#[derive(Debug, Clone, PartialEq)]
pub enum AgentState {
    None,
    Idle { session_id: String },
    Busy { tool: Option<String> },
    Waiting { session_id: String },
}

const WAITING_TO_IDLE: Duration = Duration::from_secs(60);
const STREAMING_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_BUSY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct StateMachine {
    session_id: String,
    last_entry: Option<Entry>,
    last_event_at: Instant,
    current: AgentState,
}

impl StateMachine {
    pub fn new(session_id: String, now: Instant) -> Self {
        Self {
            session_id: session_id.clone(),
            last_entry: None,
            last_event_at: now,
            current: AgentState::Idle { session_id },
        }
    }

    pub fn observe(&mut self, entry: Entry, now: Instant) -> AgentState {
        self.last_entry = Some(entry.clone());
        self.last_event_at = now;
        self.current = match entry {
            Entry::User => AgentState::Busy { tool: None },
            Entry::ToolUse { name } => AgentState::Busy { tool: Some(name) },
            Entry::AssistantPartial => AgentState::Busy { tool: None },
            Entry::AssistantComplete => AgentState::Waiting {
                session_id: self.session_id.clone(),
            },
            Entry::ToolResult | Entry::Other => self.current.clone(),
        };
        self.current.clone()
    }

    pub fn tick(&mut self, now: Instant) -> AgentState {
        let elapsed = now.saturating_duration_since(self.last_event_at);
        match (&self.current, &self.last_entry) {
            (AgentState::Busy { .. }, Some(Entry::AssistantPartial))
                if elapsed > STREAMING_BUSY_TIMEOUT =>
            {
                self.current = AgentState::Waiting {
                    session_id: self.session_id.clone(),
                };
            }
            (AgentState::Busy { .. }, Some(Entry::ToolUse { .. }))
                if elapsed > TOOL_BUSY_TIMEOUT =>
            {
                self.current = AgentState::Waiting {
                    session_id: self.session_id.clone(),
                };
            }
            (AgentState::Waiting { .. }, _) if elapsed > WAITING_TO_IDLE => {
                self.current = AgentState::Idle {
                    session_id: self.session_id.clone(),
                };
            }
            _ => {}
        }
        self.current.clone()
    }

    pub fn current(&self) -> &AgentState {
        &self.current
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn user_event_triggers_busy() {
        let mut sm = StateMachine::new("sess1".into(), t0());
        let s = sm.observe(Entry::User, t0());
        assert!(matches!(s, AgentState::Busy { tool: None }));
    }

    #[test]
    fn tool_use_carries_name() {
        let mut sm = StateMachine::new("sess1".into(), t0());
        let s = sm.observe(
            Entry::ToolUse {
                name: "Edit".into(),
            },
            t0(),
        );
        assert!(matches!(s, AgentState::Busy { tool: Some(n) } if n == "Edit"));
    }

    #[test]
    fn assistant_complete_transitions_to_waiting() {
        let mut sm = StateMachine::new("sess1".into(), t0());
        sm.observe(Entry::User, t0());
        let s = sm.observe(Entry::AssistantComplete, t0());
        assert!(matches!(s, AgentState::Waiting { session_id } if session_id == "sess1"));
    }

    #[test]
    fn streaming_assistant_partial_stays_busy_within_timeout() {
        let start = t0();
        let mut sm = StateMachine::new("sess1".into(), start);
        sm.observe(Entry::AssistantPartial, start);
        let s = sm.tick(start + Duration::from_secs(2));
        assert!(matches!(s, AgentState::Busy { .. }));
    }

    #[test]
    fn streaming_assistant_partial_falls_to_waiting_after_5s() {
        let start = t0();
        let mut sm = StateMachine::new("sess1".into(), start);
        sm.observe(Entry::AssistantPartial, start);
        let s = sm.tick(start + Duration::from_secs(6));
        assert!(matches!(s, AgentState::Waiting { .. }));
    }

    #[test]
    fn waiting_falls_to_idle_after_60s() {
        let start = t0();
        let mut sm = StateMachine::new("sess1".into(), start);
        sm.observe(Entry::AssistantComplete, start);
        let s = sm.tick(start + Duration::from_secs(61));
        assert!(matches!(s, AgentState::Idle { .. }));
    }

    #[test]
    fn tool_use_falls_to_waiting_after_30s() {
        let start = t0();
        let mut sm = StateMachine::new("sess1".into(), start);
        sm.observe(
            Entry::ToolUse {
                name: "Bash".into(),
            },
            start,
        );
        let s = sm.tick(start + Duration::from_secs(31));
        assert!(matches!(s, AgentState::Waiting { .. }));
    }

    #[test]
    fn tool_result_does_not_alter_state() {
        let mut sm = StateMachine::new("sess1".into(), t0());
        sm.observe(Entry::User, t0());
        let s = sm.observe(Entry::ToolResult, t0());
        assert!(matches!(s, AgentState::Busy { .. }));
    }
}
