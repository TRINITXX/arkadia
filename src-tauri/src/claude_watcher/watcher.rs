use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::parse::{parse_line, ParsedLine};
use super::state::{AgentState, StateMachine};

#[derive(Debug, Clone)]
pub struct StateUpdate {
    pub session_id: String,
    pub cwd: String,
    pub state: AgentState,
}

pub fn run_watcher(
    root: PathBuf,
    updates: Sender<StateUpdate>,
    shutdown: std::sync::mpsc::Receiver<()>,
) -> notify::Result<()> {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx, Config::default())?;

    if !root.exists() {
        std::fs::create_dir_all(&root).ok();
    }
    watcher.watch(&root, RecursiveMode::Recursive)?;

    let mut offsets: HashMap<PathBuf, u64> = HashMap::new();
    let mut machines: HashMap<String, (StateMachine, String)> = HashMap::new();
    let tick_interval = Duration::from_millis(250);
    let mut last_tick = Instant::now();

    loop {
        if shutdown.try_recv().is_ok() {
            break;
        }
        match rx.recv_timeout(tick_interval) {
            Ok(Ok(event)) => handle_event(event, &mut offsets, &mut machines, &updates),
            Ok(Err(e)) => eprintln!("[claude_watcher] notify error: {e}"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_tick.elapsed() >= tick_interval {
            tick_all(&mut machines, &updates);
            last_tick = Instant::now();
        }
    }
    Ok(())
}

fn handle_event(
    event: Event,
    offsets: &mut HashMap<PathBuf, u64>,
    machines: &mut HashMap<String, (StateMachine, String)>,
    updates: &Sender<StateUpdate>,
) {
    let interesting = matches!(
        event.kind,
        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
    );
    if !interesting {
        return;
    }
    for path in event.paths {
        if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
            continue;
        }
        if matches!(event.kind, EventKind::Remove(_)) {
            handle_removal(&path, offsets, machines, updates);
            continue;
        }
        process_file(&path, offsets, machines, updates);
    }
}

fn process_file(
    path: &Path,
    offsets: &mut HashMap<PathBuf, u64>,
    machines: &mut HashMap<String, (StateMachine, String)>,
    updates: &Sender<StateUpdate>,
) {
    let session_id = match path.file_stem().and_then(|s| s.to_str()) {
        Some(s) => s.to_string(),
        None => return,
    };
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let last = *offsets.get(path).unwrap_or(&0);
    if file.seek(SeekFrom::Start(last)).is_err() {
        return;
    }
    let mut reader = BufReader::new(file);
    let mut new_offset = last;
    let mut last_parsed: Option<ParsedLine> = None;
    loop {
        let mut line = String::new();
        let read = match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        new_offset += read as u64;
        if let Some(parsed) = parse_line(line.trim()) {
            last_parsed = Some(parsed);
        }
    }
    offsets.insert(path.to_path_buf(), new_offset);

    let parsed = match last_parsed {
        Some(p) => p,
        None => return,
    };
    let cwd = match parsed.cwd.clone() {
        Some(c) => c,
        None => match machines.get(&session_id) {
            Some((_, c)) => c.clone(),
            None => return,
        },
    };
    let now = Instant::now();
    let entry = machines
        .entry(session_id.clone())
        .or_insert_with(|| (StateMachine::new(session_id.clone(), now), cwd.clone()));
    entry.1 = cwd.clone();
    let state = entry.0.observe(parsed.entry, now);
    let _ = updates.send(StateUpdate {
        session_id,
        cwd,
        state,
    });
}

fn handle_removal(
    path: &Path,
    offsets: &mut HashMap<PathBuf, u64>,
    machines: &mut HashMap<String, (StateMachine, String)>,
    updates: &Sender<StateUpdate>,
) {
    offsets.remove(path);
    if let Some(session_id) = path.file_stem().and_then(|s| s.to_str()) {
        if let Some((_, cwd)) = machines.remove(session_id) {
            let _ = updates.send(StateUpdate {
                session_id: session_id.to_string(),
                cwd,
                state: AgentState::None,
            });
        }
    }
}

fn tick_all(
    machines: &mut HashMap<String, (StateMachine, String)>,
    updates: &Sender<StateUpdate>,
) {
    let now = Instant::now();
    for (session_id, (sm, cwd)) in machines.iter_mut() {
        let prev = sm.current().clone();
        let next = sm.tick(now);
        if prev != next {
            let _ = updates.send(StateUpdate {
                session_id: session_id.clone(),
                cwd: cwd.clone(),
                state: next,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc::channel;
    use std::thread;
    use std::time::Duration;

    fn write_jsonl(dir: &Path, session: &str, lines: &[&str]) -> PathBuf {
        let cwd_dir = dir.join("C--tmp-test");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let path = cwd_dir.join(format!("{session}.jsonl"));
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .unwrap();
        for line in lines {
            writeln!(f, "{line}").unwrap();
        }
        path
    }

    #[test]
    fn detects_new_session_and_emits_busy_then_waiting() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let (utx, urx) = channel();
        let (_stx, srx) = channel();
        let root_clone = root.clone();
        let handle = thread::spawn(move || run_watcher(root_clone, utx, srx).ok());

        thread::sleep(Duration::from_millis(200));
        write_jsonl(
            &root,
            "abc",
            &[r#"{"type":"user","cwd":"/tmp/test","message":{"role":"user","content":"hi"}}"#],
        );
        let update = urx.recv_timeout(Duration::from_secs(4)).expect("update");
        assert_eq!(update.session_id, "abc");
        assert!(matches!(update.state, AgentState::Busy { .. }));

        write_jsonl(
            &root,
            "abc",
            &[r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn"}}"#],
        );
        let update = urx.recv_timeout(Duration::from_secs(4)).expect("update");
        assert!(matches!(update.state, AgentState::Waiting { .. }));

        drop(handle);
    }
}
