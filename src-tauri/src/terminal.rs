use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use termwiz::color::ColorAttribute;

use crate::agent_registry::AgentRegistry;
use crate::terminal_state::{
    encode_mouse, MouseEncoding, MouseProtocol, SearchHit, TerminalCell, TerminalState,
};

const FRAME_INTERVAL: Duration = Duration::from_millis(16);

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;
type SharedTerm = Arc<Mutex<TerminalState>>;

pub struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: SharedWriter,
    term: SharedTerm,
    scroll_offset: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[derive(Default)]
pub struct SessionMap {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CellColor {
    /// Default fg/bg — frontend resolves via the active palette.
    Default,
    /// ANSI 16 index (0..15) — frontend remaps via the active palette.
    Ansi { idx: u8 },
    /// xterm-256 cube/grayscale (already resolved to a hex) or true RGB. Palette-independent.
    Rgb { value: String },
}

#[derive(Serialize, Clone)]
pub struct CellRun {
    pub text: String,
    pub fg: CellColor,
    pub bg: CellColor,
    pub bold: bool,
    pub italic: bool,
    /// 0 = none, 1 = single, 2 = double, 3 = curly, 4 = dotted, 5 = dashed.
    pub underline_style: u8,
    pub strikethrough: bool,
    pub inverse: bool,
    /// OSC 8 hyperlink target. `None` for non-hyperlink cells.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hyperlink: Option<String>,
    /// Visual cell width per char in the run: 1 for normal, 2 for CJK / emoji.
    /// All chars in a run share the same width — runs split at width transitions.
    pub cell_width: u8,
}

#[derive(Serialize, Clone)]
pub struct RenderPayload {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    pub title: String,
    pub lines: Vec<Vec<CellRun>>,
    /// 0 = at the bottom (live). N = scrolled N lines into history.
    pub scroll_offset: u32,
    /// Maximum scroll offset = scrollback line count. 0 on alt screen.
    pub scroll_max: u32,
    /// Active mouse tracking protocol: 0=off, 1=X10 (1000), 2=button-event (1002),
    /// 3=any-event (1003). The frontend uses this to decide whether to forward
    /// mouse events to the PTY or run the local drag-select / click-to-open path.
    pub mouse_protocol: u8,
    /// True iff the running app enabled SGR encoding (mode 1006). Else legacy X10.
    pub mouse_sgr: bool,
}

#[derive(Serialize, Clone)]
pub struct ClosedPayload {
    pub session_id: String,
}

#[derive(Serialize, Clone)]
pub struct CwdPayload {
    pub session_id: String,
    pub cwd: String,
}

#[derive(Serialize, Clone)]
pub struct BellPayload {
    pub session_id: String,
}

pub struct ParseOutput {
    pub cwds: Vec<String>,
    pub bell_count: u32,
}

/// Streaming parser that detects OSC 7 (cwd reporting) sequences.
struct OscParser {
    state: OscState,
    buffer: Vec<u8>,
}

enum OscState {
    Normal,
    GotEsc,
    InOsc,
    GotEscInOsc,
}

impl OscParser {
    fn new() -> Self {
        Self {
            state: OscState::Normal,
            buffer: Vec::new(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> ParseOutput {
        let mut output = ParseOutput {
            cwds: Vec::new(),
            bell_count: 0,
        };
        for &b in bytes {
            match self.state {
                OscState::Normal => {
                    if b == 0x1B {
                        self.state = OscState::GotEsc;
                    } else if b == 0x07 {
                        output.bell_count += 1;
                    }
                }
                OscState::GotEsc => {
                    if b == b']' {
                        self.state = OscState::InOsc;
                        self.buffer.clear();
                    } else {
                        self.state = OscState::Normal;
                    }
                }
                OscState::InOsc => {
                    if b == 0x07 {
                        if let Some(cwd) = parse_osc7(&self.buffer) {
                            output.cwds.push(cwd);
                        }
                        self.state = OscState::Normal;
                    } else if b == 0x1B {
                        self.state = OscState::GotEscInOsc;
                    } else if self.buffer.len() < 4096 {
                        self.buffer.push(b);
                    }
                }
                OscState::GotEscInOsc => {
                    if b == b'\\' {
                        if let Some(cwd) = parse_osc7(&self.buffer) {
                            output.cwds.push(cwd);
                        }
                        self.state = OscState::Normal;
                    } else {
                        if self.buffer.len() < 4094 {
                            self.buffer.push(0x1B);
                            self.buffer.push(b);
                        }
                        self.state = OscState::InOsc;
                    }
                }
            }
        }
        output
    }
}

fn parse_osc7(buffer: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(buffer).ok()?;
    let rest = s.strip_prefix("7;")?;
    let after_scheme = rest.strip_prefix("file://")?;
    let path = match after_scheme.find('/') {
        Some(idx) => &after_scheme[idx..],
        None => return None,
    };
    let mut p = path.to_string();
    if p.starts_with('/') && p.len() >= 3 {
        let bytes_p = p.as_bytes();
        if bytes_p[2] == b':' && bytes_p[1].is_ascii_alphabetic() {
            p = p[1..].to_string();
        }
    }
    Some(p.replace('/', "\\"))
}

const PWSH_INIT_SCRIPT: &str = "\
$global:__arkadia_orig_prompt = $function:prompt
function global:prompt {
  $c = (Get-Location).Path
  $e = [char]27
  $b = [char]7
  [Console]::Out.Write(\"$e]7;file://localhost/$c$b\")
  [Console]::Out.Flush()
  & $global:__arkadia_orig_prompt
}
$initCwd = (Get-Location).Path
$initEsc = [char]27
$initBel = [char]7
[Console]::Out.Write(\"$initEsc]7;file://localhost/$initCwd$initBel\")
[Console]::Out.Flush()
";

#[tauri::command]
pub fn spawn_terminal(
    cwd: String,
    cols: u16,
    rows: u16,
    state: State<'_, SessionMap>,
    registry: State<'_, Arc<AgentRegistry>>,
    app: AppHandle,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new("pwsh.exe");
    cmd.arg("-NoLogo");
    cmd.arg("-WorkingDirectory");
    cmd.arg(&cwd);
    cmd.arg("-NoExit");
    cmd.arg("-Command");
    cmd.arg(PWSH_INIT_SCRIPT);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn pwsh: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer: SharedWriter = Arc::new(Mutex::new(
        pair.master
            .take_writer()
            .map_err(|e| format!("take writer: {e}"))?,
    ));

    let term: SharedTerm = Arc::new(Mutex::new(TerminalState::new(rows, cols)));
    let scroll_offset = Arc::new(AtomicU32::new(0));

    let dirty = Arc::new(AtomicBool::new(false));
    let stop = Arc::new(AtomicBool::new(false));

    let reader_term = term.clone();
    let reader_writer = writer.clone();
    let reader_dirty = dirty.clone();
    let reader_stop = stop.clone();
    let reader_scroll = scroll_offset.clone();
    let reader_session_id = session_id.clone();
    let reader_app = app.clone();
    let reader_registry: Arc<AgentRegistry> = (*registry).clone();
    let reader_pane_uuid = Uuid::parse_str(&session_id).unwrap_or_else(|_| Uuid::nil());
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut osc_parser = OscParser::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    handle_terminal_queries(chunk, &reader_term, &reader_writer);
                    reader_term.lock().advance_bytes(chunk);
                    let parsed = osc_parser.feed(chunk);
                    for cwd in parsed.cwds {
                        reader_registry.observe_pane_cwd(reader_pane_uuid, cwd.clone());
                        let _ = reader_app.emit(
                            "terminal-cwd",
                            CwdPayload {
                                session_id: reader_session_id.clone(),
                                cwd,
                            },
                        );
                    }
                    if parsed.bell_count > 0 {
                        let _ = reader_app.emit(
                            "terminal-bell",
                            BellPayload {
                                session_id: reader_session_id.clone(),
                            },
                        );
                    }
                    reader_dirty.store(true, Ordering::Release);
                }
                Err(_) => break,
            }
        }
        reader_stop.store(true, Ordering::Release);
        emit_render(&reader_app, &reader_session_id, &reader_term, &reader_scroll);
        let _ = reader_app.emit(
            "terminal-closed",
            ClosedPayload {
                session_id: reader_session_id,
            },
        );
    });

    let flush_term = term.clone();
    let flush_dirty = dirty.clone();
    let flush_stop = stop.clone();
    let flush_scroll = scroll_offset.clone();
    let flush_session_id = session_id.clone();
    let flush_app = app.clone();
    thread::spawn(move || {
        while !flush_stop.load(Ordering::Acquire) {
            thread::sleep(FRAME_INTERVAL);
            if flush_dirty.swap(false, Ordering::AcqRel) {
                emit_render(&flush_app, &flush_session_id, &flush_term, &flush_scroll);
            }
        }
    });

    state.sessions.lock().insert(
        session_id.clone(),
        Session {
            master: pair.master,
            writer,
            term,
            scroll_offset,
            stop,
            _child: child,
        },
    );

    Ok(session_id)
}

fn handle_terminal_queries(bytes: &[u8], term: &Mutex<TerminalState>, writer: &SharedWriter) {
    let mut response = Vec::<u8>::new();

    if contains_subseq(bytes, b"\x1b[6n") {
        let (row, col) = term.lock().cursor_position();
        let s = format!("\x1b[{};{}R", row + 1, col + 1);
        response.extend_from_slice(s.as_bytes());
    }
    if contains_subseq(bytes, b"\x1b[5n") {
        response.extend_from_slice(b"\x1b[0n");
    }
    if contains_subseq(bytes, b"\x1b[c") || contains_subseq(bytes, b"\x1b[0c") {
        response.extend_from_slice(b"\x1b[?1;2c");
    }
    if contains_subseq(bytes, b"\x1b[>c") || contains_subseq(bytes, b"\x1b[>0c") {
        response.extend_from_slice(b"\x1b[>0;0;0c");
    }

    if !response.is_empty() {
        let mut w = writer.lock();
        let _ = w.write_all(&response);
        let _ = w.flush();
    }
}

fn contains_subseq(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.len() > haystack.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Wez-inspired ANSI 16 palette for index 0..15.
const ANSI_16: [(u8, u8, u8); 16] = [
    (0x0a, 0x0a, 0x0a),
    (0xe5, 0x53, 0x4b),
    (0x84, 0xc4, 0x52),
    (0xee, 0xae, 0x4c),
    (0x4f, 0x9d, 0xff),
    (0xc6, 0x71, 0xff),
    (0x4e, 0xd1, 0xc7),
    (0xd0, 0xd0, 0xd0),
    (0x55, 0x55, 0x55),
    (0xff, 0x6b, 0x68),
    (0xa6, 0xe2, 0x6f),
    (0xff, 0xc7, 0x66),
    (0x71, 0xb1, 0xff),
    (0xd6, 0x96, 0xff),
    (0x6c, 0xe5, 0xdb),
    (0xfa, 0xfa, 0xfa),
];

fn xterm_256_to_rgb(idx: u8) -> (u8, u8, u8) {
    if idx < 16 {
        return ANSI_16[idx as usize];
    }
    if idx >= 232 {
        let v = 8 + (idx - 232) as u16 * 10;
        let v = v.min(255) as u8;
        return (v, v, v);
    }
    let i = idx - 16;
    let r = i / 36;
    let g = (i / 6) % 6;
    let b = i % 6;
    let levels = [0u8, 95, 135, 175, 215, 255];
    (levels[r as usize], levels[g as usize], levels[b as usize])
}

fn color_to_cell(color: &ColorAttribute) -> CellColor {
    match color {
        ColorAttribute::Default => CellColor::Default,
        ColorAttribute::PaletteIndex(i) if *i < 16 => CellColor::Ansi { idx: *i },
        ColorAttribute::PaletteIndex(i) => {
            let (r, g, b) = xterm_256_to_rgb(*i);
            CellColor::Rgb {
                value: format!("#{r:02x}{g:02x}{b:02x}"),
            }
        }
        ColorAttribute::TrueColorWithDefaultFallback(srgba)
        | ColorAttribute::TrueColorWithPaletteFallback(srgba, _) => {
            let r = (srgba.0.clamp(0.0, 1.0) * 255.0).round() as u8;
            let g = (srgba.1.clamp(0.0, 1.0) * 255.0).round() as u8;
            let b = (srgba.2.clamp(0.0, 1.0) * 255.0).round() as u8;
            CellColor::Rgb {
                value: format!("#{r:02x}{g:02x}{b:02x}"),
            }
        }
    }
}

struct RunParts<'a> {
    text: String,
    fg: CellColor,
    bg: CellColor,
    bold: bool,
    italic: bool,
    underline_style: u8,
    strikethrough: bool,
    inverse: bool,
    hyperlink: Option<&'a String>,
    cell_width: u8,
}

fn cell_to_run_parts(cell: &TerminalCell) -> RunParts<'_> {
    let attrs = &cell.attrs;
    let text = if cell.text.is_empty() {
        " ".to_string()
    } else {
        cell.text.clone()
    };
    RunParts {
        text,
        fg: color_to_cell(&attrs.fg),
        bg: color_to_cell(&attrs.bg),
        bold: attrs.bold,
        italic: attrs.italic,
        underline_style: attrs.underline,
        strikethrough: attrs.strikethrough,
        inverse: attrs.reverse,
        hyperlink: attrs.hyperlink.as_ref(),
        cell_width: cell.width.max(1),
    }
}

fn emit_render(
    app: &AppHandle,
    session_id: &str,
    term: &Mutex<TerminalState>,
    scroll_offset: &AtomicU32,
) {
    let term = term.lock();
    let (rows, cols) = term.screen_size();
    let (cursor_row, cursor_col) = term.cursor_position();
    let cursor_visible = term.cursor_visible();
    let title = term.title().to_string();

    let raw_offset = scroll_offset.load(Ordering::Acquire);
    let offset = term.clamp_scroll(raw_offset);
    if offset != raw_offset {
        scroll_offset.store(offset, Ordering::Release);
    }

    let blank = TerminalCell::default();
    let mut lines: Vec<Vec<CellRun>> = Vec::with_capacity(rows as usize);

    for row in 0..rows {
        let mut runs: Vec<CellRun> = Vec::new();
        let mut current: Option<CellRun> = None;

        for col in 0..cols {
            let cell = term.cell_at(offset, row, col).unwrap_or(&blank);
            // Skip continuation cells: their main on the left has already
            // contributed the grapheme; emitting an extra run for them would
            // double-render the wide char.
            if cell.width == 0 {
                continue;
            }
            let parts = cell_to_run_parts(cell);

            match current.as_mut() {
                Some(run)
                    if run.fg == parts.fg
                        && run.bg == parts.bg
                        && run.bold == parts.bold
                        && run.italic == parts.italic
                        && run.underline_style == parts.underline_style
                        && run.strikethrough == parts.strikethrough
                        && run.inverse == parts.inverse
                        && run.hyperlink.as_deref() == parts.hyperlink.map(|s| s.as_str())
                        && run.cell_width == parts.cell_width =>
                {
                    run.text.push_str(&parts.text);
                }
                _ => {
                    if let Some(run) = current.take() {
                        runs.push(run);
                    }
                    current = Some(CellRun {
                        text: parts.text,
                        fg: parts.fg,
                        bg: parts.bg,
                        bold: parts.bold,
                        italic: parts.italic,
                        underline_style: parts.underline_style,
                        strikethrough: parts.strikethrough,
                        inverse: parts.inverse,
                        hyperlink: parts.hyperlink.cloned(),
                        cell_width: parts.cell_width,
                    });
                }
            }
        }

        if let Some(run) = current.take() {
            runs.push(run);
        }
        lines.push(runs);
    }

    let scroll_max = term.scrollback_len() as u32;
    let mouse_protocol = match term.mouse_protocol() {
        MouseProtocol::None => 0,
        MouseProtocol::X10 => 1,
        MouseProtocol::ButtonEvent => 2,
        MouseProtocol::AnyEvent => 3,
    };
    let mouse_sgr = matches!(term.mouse_encoding(), MouseEncoding::Sgr);
    let payload = RenderPayload {
        session_id: session_id.to_string(),
        cols,
        rows,
        cursor_row,
        cursor_col,
        cursor_visible,
        title,
        lines,
        scroll_offset: offset,
        scroll_max,
        mouse_protocol,
        mouse_sgr,
    };
    let _ = app.emit("terminal-render", payload);
}

#[tauri::command]
pub fn send_input(
    session_id: String,
    bytes: Vec<u8>,
    state: State<'_, SessionMap>,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    // Auto-scroll back to live (bottom) on input.
    session.scroll_offset.store(0, Ordering::Release);
    let mut w = session.writer.lock();
    w.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, SessionMap>,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    session.term.lock().set_size(rows, cols);
    Ok(())
}

#[tauri::command]
pub fn close_terminal(
    session_id: String,
    state: State<'_, SessionMap>,
    registry: State<'_, Arc<AgentRegistry>>,
) -> Result<(), String> {
    state.sessions.lock().remove(&session_id);
    if let Ok(uuid) = Uuid::parse_str(&session_id) {
        registry.forget_pane(uuid);
    }
    Ok(())
}

#[tauri::command]
pub fn search_terminal(
    session_id: String,
    query: String,
    state: State<'_, SessionMap>,
) -> Result<Vec<SearchHit>, String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    let hits = session.term.lock().search(&query);
    Ok(hits)
}

/// Decides whether a mouse event from the frontend should be forwarded to the
/// PTY given the active protocol. Wheel events (button >= 64) bypass protocol
/// filtering — apps expect them as soon as any mouse mode is on.
fn should_forward_mouse(
    protocol: MouseProtocol,
    button: u8,
    motion: bool,
    pressed: bool,
) -> bool {
    if protocol == MouseProtocol::None {
        return false;
    }
    if button >= 64 {
        return true;
    }
    match protocol {
        MouseProtocol::X10 => pressed && !motion,
        // Forward motion only if a button is held. Frontend signals "no button"
        // with `button >= 3`, matching the X11 convention.
        MouseProtocol::ButtonEvent => !motion || button < 3,
        MouseProtocol::AnyEvent => true,
        MouseProtocol::None => false,
    }
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn send_mouse_event(
    session_id: String,
    col: u16,
    row: u16,
    button: u8,
    modifiers: u8,
    motion: bool,
    pressed: bool,
    state: State<'_, SessionMap>,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;

    let (protocol, encoding) = {
        let term = session.term.lock();
        (term.mouse_protocol(), term.mouse_encoding())
    };

    if !should_forward_mouse(protocol, button, motion, pressed) {
        return Ok(());
    }

    let bytes = encode_mouse(button, col, row, modifiers, motion, pressed, encoding);
    let mut w = session.writer.lock();
    w.write_all(&bytes).map_err(|e| format!("write: {e}"))?;
    w.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn scroll_terminal(
    session_id: String,
    delta: i32,
    state: State<'_, SessionMap>,
    app: AppHandle,
) -> Result<(), String> {
    let sessions = state.sessions.lock();
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("unknown session {session_id}"))?;

    // On alt screen (TUI apps like claude code, less, vim), our scrollback is
    // frozen by design. Translate wheel into PgUp/PgDn so the running app can
    // page through its own buffer. One page per wheel crank — sending N pages
    // per crank (where N = delta lines) would be way too much.
    if session.term.lock().is_on_alt_screen() {
        if delta == 0 {
            return Ok(());
        }
        let seq: &[u8] = if delta > 0 { b"\x1b[5~" } else { b"\x1b[6~" };
        let mut w = session.writer.lock();
        w.write_all(seq).map_err(|e| format!("write: {e}"))?;
        w.flush().map_err(|e| format!("flush: {e}"))?;
        return Ok(());
    }

    let max = session.term.lock().scrollback_len() as i64;
    let cur = session.scroll_offset.load(Ordering::Acquire) as i64;
    let next = (cur + delta as i64).clamp(0, max) as u32;
    session.scroll_offset.store(next, Ordering::Release);
    emit_render(&app, &session_id, &session.term, &session.scroll_offset);
    Ok(())
}
