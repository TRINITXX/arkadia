use serde::Deserialize;

#[derive(Debug, Clone, PartialEq)]
pub enum Entry {
    User,
    AssistantPartial,
    AssistantContinuing,
    AssistantComplete,
    ToolUse { name: String },
    ToolResult,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLine {
    pub entry: Entry,
    pub cwd: Option<String>,
}

#[derive(Deserialize)]
struct RawEntry {
    #[serde(rename = "type")]
    kind: Option<String>,
    cwd: Option<String>,
    message: Option<RawMessage>,
    name: Option<String>,
}

#[derive(Deserialize)]
struct RawMessage {
    stop_reason: Option<serde_json::Value>,
}

pub fn parse_line(line: &str) -> Option<ParsedLine> {
    let raw: RawEntry = serde_json::from_str(line).ok()?;
    let entry = match raw.kind.as_deref() {
        Some("user") => Entry::User,
        Some("assistant") => {
            let stop_reason = raw.message.as_ref().and_then(|m| m.stop_reason.as_ref());
            match stop_reason {
                Some(serde_json::Value::Null) | None => Entry::AssistantPartial,
                Some(serde_json::Value::String(s)) if s == "tool_use" => {
                    Entry::AssistantContinuing
                }
                Some(_) => Entry::AssistantComplete,
            }
        }
        Some("tool_use") => Entry::ToolUse {
            name: raw.name.unwrap_or_default(),
        },
        Some("tool_result") => Entry::ToolResult,
        _ => Entry::Other,
    };
    Some(ParsedLine { entry, cwd: raw.cwd })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_entry() {
        let line = r#"{"type":"user","message":{"role":"user","content":"hi"},"cwd":"/tmp"}"#;
        let parsed = parse_line(line).unwrap();
        assert_eq!(parsed.entry, Entry::User);
        assert_eq!(parsed.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn parses_assistant_complete() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":""}}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::AssistantComplete);
    }

    #[test]
    fn parses_assistant_tool_use_stop_as_continuing() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":""}}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::AssistantContinuing);
    }

    #[test]
    fn parses_assistant_partial_via_null_stop_reason() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":null,"content":""}}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::AssistantPartial);
    }

    #[test]
    fn parses_assistant_partial_via_missing_message() {
        let line = r#"{"type":"assistant"}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::AssistantPartial);
    }

    #[test]
    fn parses_tool_use_with_name() {
        let line = r#"{"type":"tool_use","name":"Edit","id":"abc"}"#;
        match parse_line(line).unwrap().entry {
            Entry::ToolUse { name } => assert_eq!(name, "Edit"),
            other => panic!("expected ToolUse, got {:?}", other),
        }
    }

    #[test]
    fn parses_tool_result() {
        let line = r#"{"type":"tool_result","tool_use_id":"abc"}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::ToolResult);
    }

    #[test]
    fn malformed_json_returns_none() {
        assert!(parse_line("not json at all").is_none());
        assert!(parse_line(r#"{"type":"user"#).is_none());
    }

    #[test]
    fn unknown_type_becomes_other() {
        let line = r#"{"type":"summary","content":"..."}"#;
        assert_eq!(parse_line(line).unwrap().entry, Entry::Other);
    }
}
