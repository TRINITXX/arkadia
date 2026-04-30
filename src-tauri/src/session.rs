use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SESSION_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionFile {
    pub version: u32,
    pub saved_at: String,
    pub active_project_id: Option<Uuid>,
    pub projects: Vec<ProjectSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectSession {
    pub project_id: Uuid,
    pub active_tab_id: Option<Uuid>,
    pub tabs: Vec<TabSession>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TabSession {
    pub tab_id: Uuid,
    pub title: String,
    pub active_pane_id: Uuid,
    pub pane_tree: PaneTreeSerialized,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PaneTreeSerialized {
    Leaf {
        pane_id: Uuid,
        cwd: String,
        profile_id: String,
        agent_resume: Option<AgentResume>,
    },
    Split {
        orientation: Orientation,
        ratio: f32,
        left: Box<PaneTreeSerialized>,
        right: Box<PaneTreeSerialized>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentResume {
    pub kind: String,
    pub session_id: String,
    pub command: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_complex_session() {
        let s = SessionFile {
            version: SESSION_VERSION,
            saved_at: "2026-04-30T12:00:00Z".into(),
            active_project_id: Some(Uuid::new_v4()),
            projects: vec![ProjectSession {
                project_id: Uuid::new_v4(),
                active_tab_id: Some(Uuid::new_v4()),
                tabs: vec![TabSession {
                    tab_id: Uuid::new_v4(),
                    title: "main".into(),
                    active_pane_id: Uuid::new_v4(),
                    pane_tree: PaneTreeSerialized::Split {
                        orientation: Orientation::Horizontal,
                        ratio: 0.5,
                        left: Box::new(PaneTreeSerialized::Leaf {
                            pane_id: Uuid::new_v4(),
                            cwd: "C:\\Users\\test".into(),
                            profile_id: "pwsh".into(),
                            agent_resume: Some(AgentResume {
                                kind: "claude-code".into(),
                                session_id: "abc-123".into(),
                                command: "ccd --resume".into(),
                            }),
                        }),
                        right: Box::new(PaneTreeSerialized::Leaf {
                            pane_id: Uuid::new_v4(),
                            cwd: "C:\\Users\\test".into(),
                            profile_id: "pwsh".into(),
                            agent_resume: None,
                        }),
                    },
                }],
            }],
        };
        let j = serde_json::to_string(&s).unwrap();
        let back: SessionFile = serde_json::from_str(&j).unwrap();
        assert_eq!(s, back);
    }
}
