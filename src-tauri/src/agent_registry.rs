use std::collections::HashMap;

use parking_lot::Mutex;
use serde::Serialize;
use uuid::Uuid;

use crate::claude_watcher::state::AgentState;

#[derive(Debug, Default)]
pub struct AgentRegistry {
    inner: Mutex<RegistryInner>,
}

#[derive(Debug, Default)]
struct RegistryInner {
    pane_cwd: HashMap<Uuid, String>,
    cwd_session: HashMap<String, String>,
    session_state: HashMap<String, AgentState>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentStatePayload {
    None,
    Idle {
        session_id: String,
    },
    Busy {
        tool: Option<String>,
    },
    Waiting {
        session_id: String,
    },
}

impl From<&AgentState> for AgentStatePayload {
    fn from(s: &AgentState) -> Self {
        match s {
            AgentState::None => AgentStatePayload::None,
            AgentState::Idle { session_id } => AgentStatePayload::Idle {
                session_id: session_id.clone(),
            },
            AgentState::Busy { tool } => AgentStatePayload::Busy { tool: tool.clone() },
            AgentState::Waiting { session_id } => AgentStatePayload::Waiting {
                session_id: session_id.clone(),
            },
        }
    }
}

impl AgentRegistry {
    pub fn observe_session(&self, cwd: &str, session_id: &str, state: AgentState) {
        let mut g = self.inner.lock();
        g.cwd_session.insert(cwd.to_string(), session_id.to_string());
        g.session_state.insert(session_id.to_string(), state);
    }

    pub fn observe_pane_cwd(&self, pane_id: Uuid, cwd: String) {
        let mut g = self.inner.lock();
        g.pane_cwd.insert(pane_id, cwd);
    }

    pub fn forget_pane(&self, pane_id: Uuid) {
        let mut g = self.inner.lock();
        g.pane_cwd.remove(&pane_id);
    }

    pub fn pane_state(&self, pane_id: Uuid) -> AgentStatePayload {
        let g = self.inner.lock();
        let cwd = match g.pane_cwd.get(&pane_id) {
            Some(c) => c,
            None => return AgentStatePayload::None,
        };
        let session_id = match g.cwd_session.get(cwd) {
            Some(s) => s,
            None => return AgentStatePayload::None,
        };
        match g.session_state.get(session_id) {
            Some(state) => AgentStatePayload::from(state),
            None => AgentStatePayload::None,
        }
    }

    pub fn pane_session_id(&self, pane_id: Uuid) -> Option<String> {
        let g = self.inner.lock();
        let cwd = g.pane_cwd.get(&pane_id)?;
        g.cwd_session.get(cwd).cloned()
    }

    pub fn project_state(&self, panes: &[Uuid]) -> AgentStatePayload {
        let mut best = AgentStatePayload::None;
        let mut rank = 0u8;
        for p in panes {
            let s = self.pane_state(*p);
            let r = match &s {
                AgentStatePayload::Busy { .. } => 4,
                AgentStatePayload::Waiting { .. } => 3,
                AgentStatePayload::Idle { .. } => 2,
                AgentStatePayload::None => 1,
            };
            if r > rank {
                rank = r;
                best = s;
            }
        }
        best
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid() -> Uuid {
        Uuid::new_v4()
    }

    #[test]
    fn maps_pane_to_session_via_cwd() {
        let r = AgentRegistry::default();
        let p = pid();
        r.observe_pane_cwd(p, "/tmp/proj".into());
        r.observe_session(
            "/tmp/proj",
            "sess-abc",
            AgentState::Busy {
                tool: Some("Edit".into()),
            },
        );
        match r.pane_state(p) {
            AgentStatePayload::Busy { tool } => assert_eq!(tool.as_deref(), Some("Edit")),
            other => panic!("expected Busy, got {:?}", other),
        }
    }

    #[test]
    fn returns_none_when_no_cwd_match() {
        let r = AgentRegistry::default();
        let p = pid();
        r.observe_pane_cwd(p, "/other".into());
        r.observe_session(
            "/tmp/proj",
            "sess-abc",
            AgentState::Waiting {
                session_id: "sess-abc".into(),
            },
        );
        assert_eq!(r.pane_state(p), AgentStatePayload::None);
    }

    #[test]
    fn project_aggregation_busy_wins() {
        let r = AgentRegistry::default();
        let p1 = pid();
        let p2 = pid();
        r.observe_pane_cwd(p1, "/a".into());
        r.observe_pane_cwd(p2, "/b".into());
        r.observe_session(
            "/a",
            "s1",
            AgentState::Waiting {
                session_id: "s1".into(),
            },
        );
        r.observe_session("/b", "s2", AgentState::Busy { tool: None });
        assert!(matches!(r.project_state(&[p1, p2]), AgentStatePayload::Busy { .. }));
    }

    #[test]
    fn project_aggregation_waiting_over_idle() {
        let r = AgentRegistry::default();
        let p1 = pid();
        let p2 = pid();
        r.observe_pane_cwd(p1, "/a".into());
        r.observe_pane_cwd(p2, "/b".into());
        r.observe_session(
            "/a",
            "s1",
            AgentState::Idle {
                session_id: "s1".into(),
            },
        );
        r.observe_session(
            "/b",
            "s2",
            AgentState::Waiting {
                session_id: "s2".into(),
            },
        );
        assert!(matches!(
            r.project_state(&[p1, p2]),
            AgentStatePayload::Waiting { .. }
        ));
    }

    #[test]
    fn pane_session_id_returns_mapped_session() {
        let r = AgentRegistry::default();
        let p = pid();
        r.observe_pane_cwd(p, "/x".into());
        r.observe_session(
            "/x",
            "sess-x",
            AgentState::Idle {
                session_id: "sess-x".into(),
            },
        );
        assert_eq!(r.pane_session_id(p).as_deref(), Some("sess-x"));
    }
}
