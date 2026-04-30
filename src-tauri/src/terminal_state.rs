//! Terminal cell grid + scrollback wrapper around `termwiz` escape parser.
//!
//! `termwiz` provides only the parser + primitive types (Action, Cell attrs).
//! We implement a small TerminalState on top: visible screen as `Vec<Vec<TerminalCell>>`,
//! scrollback as `VecDeque<Vec<TerminalCell>>` capped at 10k lines, cursor + SGR state
//! tracking, and minimal alt-screen support (so claude code's TUI works).
//!
//! Goals : strikethrough attribute (vt100 0.15 lacks it) + scroll into history.
//! Reference: WezTerm/wezterm-term (parser→state architecture).

use std::collections::VecDeque;

use serde::Serialize;
use termwiz::cell::{Intensity, Underline};
use termwiz::color::{ColorAttribute, ColorSpec};
use termwiz::escape::csi::{
    Cursor, DecPrivateMode, DecPrivateModeCode, Edit, EraseInDisplay, EraseInLine, Sgr, CSI,
};
use termwiz::escape::parser::Parser;
use termwiz::escape::{Action, ControlCode, Esc, EscCode, OperatingSystemCommand};
use unicode_width::UnicodeWidthChar;

pub const SCROLLBACK_CAP: usize = 100_000;

/// Underline rendering style. Wire format: 0 = none, 1 = single, 2 = double,
/// 3 = curly, 4 = dotted, 5 = dashed. Maps to termwiz's `Underline` enum.
pub type UnderlineStyle = u8;
pub const UNDERLINE_NONE: u8 = 0;
pub const UNDERLINE_SINGLE: u8 = 1;
pub const UNDERLINE_DOUBLE: u8 = 2;
pub const UNDERLINE_CURLY: u8 = 3;
pub const UNDERLINE_DOTTED: u8 = 4;
pub const UNDERLINE_DASHED: u8 = 5;

#[derive(Clone, Debug)]
pub struct TerminalCellAttrs {
    pub fg: ColorAttribute,
    pub bg: ColorAttribute,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: UnderlineStyle,
    pub strikethrough: bool,
    pub reverse: bool,
    /// OSC 8 hyperlink URL associated with this cell, if any.
    pub hyperlink: Option<String>,
}

impl Default for TerminalCellAttrs {
    fn default() -> Self {
        Self {
            fg: ColorAttribute::Default,
            bg: ColorAttribute::Default,
            bold: false,
            dim: false,
            italic: false,
            underline: UNDERLINE_NONE,
            strikethrough: false,
            reverse: false,
            hyperlink: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TerminalCell {
    pub text: String,
    pub attrs: TerminalCellAttrs,
    /// Cell display width:
    /// - `1` : normal cell (one column).
    /// - `2` : main cell of a wide grapheme (CJK, emoji). The next cell to the
    ///         right is its continuation.
    /// - `0` : continuation cell — the right half of a width-2 grapheme. Its
    ///         `text` is empty; the renderer skips it.
    pub width: u8,
}

impl Default for TerminalCell {
    fn default() -> Self {
        Self {
            text: " ".to_string(),
            attrs: TerminalCellAttrs::default(),
            width: 1,
        }
    }
}

impl TerminalCell {
    fn continuation() -> Self {
        Self {
            text: String::new(),
            attrs: TerminalCellAttrs::default(),
            width: 0,
        }
    }
}

/// Mouse tracking protocol requested by the running app via DEC private modes.
/// Apps typically enable one of these alongside `MouseEncoding::Sgr`.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseProtocol {
    #[default]
    None,
    /// 1000 — press only.
    X10,
    /// 1002 — press + release + motion-while-button-held.
    ButtonEvent,
    /// 1003 — press + release + all motion (even without button).
    AnyEvent,
}

/// Wire format for mouse event reporting back to the PTY.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseEncoding {
    /// Legacy X10 — `ESC[M` + 3 bytes (Cb+32, Cx+33, Cy+33). Cap col/row at 223.
    #[default]
    Default,
    /// 1006 — `ESC[<Cb;Cx;Cy(M|m)`, no cell limit. Modern apps default to this.
    Sgr,
}

pub struct TerminalState {
    rows: u16,
    cols: u16,
    cursor_row: u16,
    cursor_col: u16,
    cursor_visible: bool,
    title: String,
    saved_cursor: Option<(u16, u16, TerminalCellAttrs)>,
    current_attrs: TerminalCellAttrs,
    main_screen: Vec<Vec<TerminalCell>>,
    alt_screen: Option<Vec<Vec<TerminalCell>>>,
    on_alt: bool,
    scrollback: VecDeque<Vec<TerminalCell>>,
    parser: Parser,
    mouse_protocol: MouseProtocol,
    mouse_encoding: MouseEncoding,
}

impl TerminalState {
    pub fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1);
        let cols = cols.max(1);
        Self {
            rows,
            cols,
            cursor_row: 0,
            cursor_col: 0,
            cursor_visible: true,
            title: String::new(),
            saved_cursor: None,
            current_attrs: TerminalCellAttrs::default(),
            main_screen: blank_screen(rows, cols),
            alt_screen: None,
            on_alt: false,
            scrollback: VecDeque::new(),
            parser: Parser::new(),
            mouse_protocol: MouseProtocol::None,
            mouse_encoding: MouseEncoding::Default,
        }
    }

    pub fn screen_size(&self) -> (u16, u16) {
        (self.rows, self.cols)
    }

    pub fn cursor_position(&self) -> (u16, u16) {
        let row = self.cursor_row.min(self.rows.saturating_sub(1));
        let mut col = self.cursor_col.min(self.cols.saturating_sub(1));
        // Programs sometimes leave the cursor on the continuation cell of a
        // wide grapheme. Snap left so the renderer paints the cursor on the
        // visible main cell.
        if let Some(line) = self.active_screen().get(row as usize) {
            if let Some(cell) = line.get(col as usize) {
                if cell.width == 0 && col > 0 {
                    col -= 1;
                }
            }
        }
        (row, col)
    }

    pub fn cursor_visible(&self) -> bool {
        self.cursor_visible
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn scrollback_len(&self) -> usize {
        if self.on_alt {
            0
        } else {
            self.scrollback.len()
        }
    }

    pub fn is_on_alt_screen(&self) -> bool {
        self.on_alt
    }

    pub fn mouse_protocol(&self) -> MouseProtocol {
        self.mouse_protocol
    }

    pub fn mouse_encoding(&self) -> MouseEncoding {
        self.mouse_encoding
    }

    /// Case-insensitive substring search across scrollback (oldest first)
    /// then the active screen. `total_row` 0 = oldest scrollback line;
    /// `total_row = scrollback.len()` is row 0 of the visible screen.
    pub fn search(&self, query: &str) -> Vec<SearchHit> {
        if query.is_empty() {
            return Vec::new();
        }
        let needle: Vec<char> = query.chars().flat_map(|c| c.to_lowercase()).collect();
        if needle.is_empty() {
            return Vec::new();
        }
        let mut hits = Vec::new();
        let mut total_row: u32 = 0;
        if !self.on_alt {
            for line in &self.scrollback {
                push_search_hits(line, &needle, total_row, &mut hits);
                total_row += 1;
            }
        }
        let screen = self.active_screen();
        for line in screen {
            push_search_hits(line, &needle, total_row, &mut hits);
            total_row += 1;
        }
        hits
    }

    /// Returns the cell at (row, col) of the visible screen, considering scroll offset.
    /// `scroll_offset` = 0 means live (bottom). N means N lines into history.
    pub fn cell_at(&self, scroll_offset: u32, row: u16, col: u16) -> Option<&TerminalCell> {
        let rows = self.rows as usize;
        let r = row as usize;
        let c = col as usize;
        if r >= rows || c >= self.cols as usize {
            return None;
        }
        let n = if self.on_alt { 0 } else { scroll_offset as usize };
        let n = n.min(self.scrollback.len());

        if r < n {
            // From scrollback. scrollback[len - n + r] is the row r when scrolled by n.
            let sb_len = self.scrollback.len();
            let idx = sb_len.checked_sub(n - r)?;
            self.scrollback.get(idx).and_then(|line| line.get(c))
        } else {
            let screen = self.active_screen();
            screen.get(r - n).and_then(|line| line.get(c))
        }
    }

    pub fn clamp_scroll(&self, offset: u32) -> u32 {
        offset.min(self.scrollback.len() as u32)
    }

    pub fn set_size(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(1);
        let cols = cols.max(1);
        if rows == self.rows && cols == self.cols {
            return;
        }
        resize_screen(&mut self.main_screen, rows, cols);
        if let Some(alt) = self.alt_screen.as_mut() {
            resize_screen(alt, rows, cols);
        }
        self.rows = rows;
        self.cols = cols;
        self.cursor_row = self.cursor_row.min(rows - 1);
        self.cursor_col = self.cursor_col.min(cols - 1);
    }

    pub fn advance_bytes(&mut self, bytes: &[u8]) {
        let actions = self.parser.parse_as_vec(bytes);
        for action in actions {
            self.handle_action(action);
        }
    }

    fn active_screen(&self) -> &Vec<Vec<TerminalCell>> {
        if self.on_alt {
            self.alt_screen.as_ref().unwrap_or(&self.main_screen)
        } else {
            &self.main_screen
        }
    }

    fn active_screen_mut(&mut self) -> &mut Vec<Vec<TerminalCell>> {
        if self.on_alt {
            self.alt_screen.as_mut().expect("alt screen not initialized")
        } else {
            &mut self.main_screen
        }
    }

    fn handle_action(&mut self, action: Action) {
        match action {
            Action::Print(c) => self.print_char(c),
            Action::PrintString(s) => {
                for c in s.chars() {
                    self.print_char(c);
                }
            }
            Action::Control(code) => self.handle_control(code),
            Action::CSI(csi) => self.handle_csi(csi),
            Action::OperatingSystemCommand(osc) => self.handle_osc(*osc),
            Action::Esc(esc) => self.handle_esc(esc),
            // DCS, sixel, etc. — ignored.
            _ => {}
        }
    }

    fn print_char(&mut self, c: char) {
        if c == '\0' {
            return;
        }
        let width = char_cell_width(c);
        if width == 0 {
            // Combining marks / nonprint. V1.8 skips them; full grapheme
            // clustering would attach them to the previous cell's text.
            return;
        }

        // Wrap if there's no room for the (potentially wide) glyph.
        if self.cursor_col + width as u16 > self.cols {
            self.cursor_col = 0;
            self.line_feed();
        }

        let row = self.cursor_row as usize;
        let col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();

        let Some(line) = screen.get_mut(row) else {
            self.cursor_col += width as u16;
            return;
        };

        // If we're stomping on a wide pair, blank its orphan half so we don't
        // leave a dangling continuation or main behind.
        cleanup_overwrite(line, col, &blank);
        if width == 2 && col + 1 < cols {
            cleanup_overwrite(line, col + 1, &blank);
        }

        if let Some(cell) = line.get_mut(col) {
            cell.text = c.to_string();
            cell.attrs = attrs.clone();
            cell.width = width;
        }
        if width == 2 {
            if let Some(cell) = line.get_mut(col + 1) {
                *cell = TerminalCell::continuation();
                cell.attrs = attrs;
            }
        }
        self.cursor_col += width as u16;
    }

    fn handle_control(&mut self, code: ControlCode) {
        match code {
            ControlCode::LineFeed | ControlCode::VerticalTab | ControlCode::FormFeed => {
                self.line_feed();
            }
            ControlCode::CarriageReturn => {
                self.cursor_col = 0;
            }
            ControlCode::Backspace => {
                if self.cursor_col > 0 {
                    self.cursor_col -= 1;
                }
            }
            ControlCode::HorizontalTab => {
                let next = ((self.cursor_col / 8) + 1) * 8;
                self.cursor_col = next.min(self.cols.saturating_sub(1));
            }
            // Bell is captured by the OSC pre-parser upstream.
            _ => {}
        }
    }

    fn line_feed(&mut self) {
        if self.cursor_row + 1 >= self.rows {
            self.scroll_up_one();
        } else {
            self.cursor_row += 1;
        }
    }

    fn scroll_up_one(&mut self) {
        let cols = self.cols;
        if self.on_alt {
            // Alt screen does not feed scrollback.
            let alt = self.alt_screen.as_mut().expect("alt screen");
            alt.remove(0);
            alt.push(blank_line(cols));
        } else {
            let top = self.main_screen.remove(0);
            self.scrollback.push_back(top);
            while self.scrollback.len() > SCROLLBACK_CAP {
                self.scrollback.pop_front();
            }
            self.main_screen.push(blank_line(cols));
        }
    }

    fn handle_csi(&mut self, csi: CSI) {
        match csi {
            CSI::Sgr(sgr) => self.handle_sgr(sgr),
            CSI::Cursor(c) => self.handle_cursor(c),
            CSI::Edit(edit) => self.handle_edit(edit),
            CSI::Mode(mode) => self.handle_mode(mode),
            _ => {}
        }
    }

    fn handle_sgr(&mut self, sgr: Sgr) {
        match sgr {
            Sgr::Reset => {
                self.current_attrs = TerminalCellAttrs::default();
            }
            Sgr::Intensity(intensity) => match intensity {
                Intensity::Normal => {
                    self.current_attrs.bold = false;
                    self.current_attrs.dim = false;
                }
                Intensity::Bold => {
                    self.current_attrs.bold = true;
                    self.current_attrs.dim = false;
                }
                Intensity::Half => {
                    self.current_attrs.dim = true;
                    self.current_attrs.bold = false;
                }
            },
            Sgr::Italic(b) => self.current_attrs.italic = b,
            Sgr::Underline(u) => {
                self.current_attrs.underline = match u {
                    Underline::None => UNDERLINE_NONE,
                    Underline::Single => UNDERLINE_SINGLE,
                    Underline::Double => UNDERLINE_DOUBLE,
                    Underline::Curly => UNDERLINE_CURLY,
                    Underline::Dotted => UNDERLINE_DOTTED,
                    Underline::Dashed => UNDERLINE_DASHED,
                };
            }
            Sgr::StrikeThrough(b) => self.current_attrs.strikethrough = b,
            Sgr::Inverse(b) => self.current_attrs.reverse = b,
            Sgr::Foreground(spec) => {
                self.current_attrs.fg = colorspec_to_attribute(spec);
            }
            Sgr::Background(spec) => {
                self.current_attrs.bg = colorspec_to_attribute(spec);
            }
            // Underline color, Overline, Font, Blink, Invisible — ignored V1.
            _ => {}
        }
    }

    fn handle_cursor(&mut self, c: Cursor) {
        match c {
            Cursor::Position { line, col } => {
                let r = line.as_zero_based() as i64;
                let cc = col.as_zero_based() as i64;
                self.cursor_row = r.clamp(0, self.rows as i64 - 1) as u16;
                self.cursor_col = cc.clamp(0, self.cols as i64 - 1) as u16;
            }
            Cursor::Up(n) => {
                let n = n as u16;
                self.cursor_row = self.cursor_row.saturating_sub(n);
            }
            Cursor::Down(n) => {
                let n = n as u16;
                self.cursor_row = (self.cursor_row + n).min(self.rows.saturating_sub(1));
            }
            Cursor::Right(n) | Cursor::CharacterPositionForward(n) => {
                let n = n as u16;
                self.cursor_col = (self.cursor_col + n).min(self.cols.saturating_sub(1));
            }
            Cursor::Left(n) | Cursor::CharacterPositionBackward(n) => {
                let n = n as u16;
                self.cursor_col = self.cursor_col.saturating_sub(n);
            }
            Cursor::CharacterAbsolute(col) | Cursor::CharacterPositionAbsolute(col) => {
                let cc = col.as_zero_based() as i64;
                self.cursor_col = cc.clamp(0, self.cols as i64 - 1) as u16;
            }
            Cursor::LinePositionAbsolute(line) => {
                let line = line as i64 - 1;
                self.cursor_row = line.clamp(0, self.rows as i64 - 1) as u16;
            }
            Cursor::NextLine(n) => {
                let n = n as u16;
                self.cursor_row = (self.cursor_row + n).min(self.rows.saturating_sub(1));
                self.cursor_col = 0;
            }
            Cursor::PrecedingLine(n) => {
                let n = n as u16;
                self.cursor_row = self.cursor_row.saturating_sub(n);
                self.cursor_col = 0;
            }
            Cursor::SaveCursor => {
                self.saved_cursor = Some((
                    self.cursor_row,
                    self.cursor_col,
                    self.current_attrs.clone(),
                ));
            }
            Cursor::RestoreCursor => {
                if let Some((r, c, a)) = self.saved_cursor.clone() {
                    self.cursor_row = r.min(self.rows.saturating_sub(1));
                    self.cursor_col = c.min(self.cols.saturating_sub(1));
                    self.current_attrs = a;
                }
            }
            _ => {}
        }
    }

    fn handle_edit(&mut self, edit: Edit) {
        match edit {
            Edit::EraseInDisplay(mode) => self.erase_in_display(mode),
            Edit::EraseInLine(mode) => self.erase_in_line(mode),
            Edit::EraseCharacter(n) => self.erase_characters(n),
            Edit::DeleteCharacter(n) => self.delete_characters(n),
            Edit::InsertCharacter(n) => self.insert_characters(n),
            Edit::InsertLine(n) => self.insert_lines(n),
            Edit::DeleteLine(n) => self.delete_lines(n),
            _ => {}
        }
    }

    fn erase_in_display(&mut self, mode: EraseInDisplay) {
        let cols = self.cols as usize;
        let rows = self.rows as usize;
        let cur_row = self.cursor_row as usize;
        let cur_col = self.cursor_col as usize;
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();
        match mode {
            EraseInDisplay::EraseToEndOfDisplay => {
                if let Some(line) = screen.get_mut(cur_row) {
                    for c in cur_col..cols {
                        if let Some(cell) = line.get_mut(c) {
                            *cell = blank.clone();
                        }
                    }
                    fixup_wide_invariant(line, &blank);
                }
                for r in (cur_row + 1)..rows {
                    if let Some(line) = screen.get_mut(r) {
                        for cell in line.iter_mut() {
                            *cell = blank.clone();
                        }
                    }
                }
            }
            EraseInDisplay::EraseToStartOfDisplay => {
                for r in 0..cur_row {
                    if let Some(line) = screen.get_mut(r) {
                        for cell in line.iter_mut() {
                            *cell = blank.clone();
                        }
                    }
                }
                if let Some(line) = screen.get_mut(cur_row) {
                    for c in 0..=cur_col.min(cols.saturating_sub(1)) {
                        if let Some(cell) = line.get_mut(c) {
                            *cell = blank.clone();
                        }
                    }
                    fixup_wide_invariant(line, &blank);
                }
            }
            EraseInDisplay::EraseDisplay | EraseInDisplay::EraseScrollback => {
                for line in screen.iter_mut() {
                    for cell in line.iter_mut() {
                        *cell = blank.clone();
                    }
                }
                if matches!(mode, EraseInDisplay::EraseScrollback) && !self.on_alt {
                    self.scrollback.clear();
                }
            }
        }
    }

    fn erase_in_line(&mut self, mode: EraseInLine) {
        let cols = self.cols as usize;
        let cur_row = self.cursor_row as usize;
        let cur_col = self.cursor_col as usize;
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();
        if let Some(line) = screen.get_mut(cur_row) {
            match mode {
                EraseInLine::EraseToEndOfLine => {
                    for c in cur_col..cols {
                        if let Some(cell) = line.get_mut(c) {
                            *cell = blank.clone();
                        }
                    }
                }
                EraseInLine::EraseToStartOfLine => {
                    for c in 0..=cur_col.min(cols.saturating_sub(1)) {
                        if let Some(cell) = line.get_mut(c) {
                            *cell = blank.clone();
                        }
                    }
                }
                EraseInLine::EraseLine => {
                    for cell in line.iter_mut() {
                        *cell = blank.clone();
                    }
                }
            }
            fixup_wide_invariant(line, &blank);
        }
    }

    fn erase_characters(&mut self, n: u32) {
        let cur_row = self.cursor_row as usize;
        let cur_col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();
        if let Some(line) = screen.get_mut(cur_row) {
            let end = (cur_col + n as usize).min(cols);
            for c in cur_col..end {
                if let Some(cell) = line.get_mut(c) {
                    *cell = blank.clone();
                }
            }
            fixup_wide_invariant(line, &blank);
        }
    }

    fn delete_characters(&mut self, n: u32) {
        let cur_row = self.cursor_row as usize;
        let cur_col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let n = (n as usize).min(cols.saturating_sub(cur_col));
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();
        if let Some(line) = screen.get_mut(cur_row) {
            for _ in 0..n {
                if cur_col < line.len() {
                    line.remove(cur_col);
                    line.push(blank.clone());
                }
            }
            fixup_wide_invariant(line, &blank);
        }
    }

    fn insert_characters(&mut self, n: u32) {
        let cur_row = self.cursor_row as usize;
        let cur_col = self.cursor_col as usize;
        let cols = self.cols as usize;
        let n = (n as usize).min(cols.saturating_sub(cur_col));
        let attrs = self.current_attrs.clone();
        let blank = blank_cell_with_bg(&attrs);
        let screen = self.active_screen_mut();
        if let Some(line) = screen.get_mut(cur_row) {
            for _ in 0..n {
                line.insert(cur_col, blank.clone());
                if line.len() > cols {
                    line.pop();
                }
            }
            fixup_wide_invariant(line, &blank);
        }
    }

    fn insert_lines(&mut self, n: u32) {
        let cur_row = self.cursor_row as usize;
        let rows = self.rows as usize;
        let cols = self.cols;
        let n = (n as usize).min(rows.saturating_sub(cur_row));
        let screen = self.active_screen_mut();
        for _ in 0..n {
            screen.insert(cur_row, blank_line(cols));
            if screen.len() > rows {
                screen.pop();
            }
        }
    }

    fn delete_lines(&mut self, n: u32) {
        let cur_row = self.cursor_row as usize;
        let rows = self.rows as usize;
        let cols = self.cols;
        let n = (n as usize).min(rows.saturating_sub(cur_row));
        let screen = self.active_screen_mut();
        for _ in 0..n {
            if cur_row < screen.len() {
                screen.remove(cur_row);
                screen.push(blank_line(cols));
            }
        }
    }

    fn handle_mode(&mut self, mode: termwiz::escape::csi::Mode) {
        use termwiz::escape::csi::Mode;
        match mode {
            Mode::SetDecPrivateMode(p) => self.set_dec_mode(p, true),
            Mode::ResetDecPrivateMode(p) => self.set_dec_mode(p, false),
            Mode::SaveDecPrivateMode(_) | Mode::RestoreDecPrivateMode(_) => {}
            _ => {}
        }
    }

    fn set_dec_mode(&mut self, mode: DecPrivateMode, on: bool) {
        let code = match mode {
            DecPrivateMode::Code(c) => c,
            DecPrivateMode::Unspecified(_) => return,
        };
        match code {
            DecPrivateModeCode::ShowCursor => self.cursor_visible = on,
            DecPrivateModeCode::ClearAndEnableAlternateScreen
            | DecPrivateModeCode::EnableAlternateScreen
            | DecPrivateModeCode::OptEnableAlternateScreen => {
                if on {
                    self.enter_alt_screen();
                } else {
                    self.exit_alt_screen();
                }
            }
            DecPrivateModeCode::MouseTracking => {
                self.set_mouse_protocol(MouseProtocol::X10, on);
            }
            DecPrivateModeCode::ButtonEventMouse => {
                self.set_mouse_protocol(MouseProtocol::ButtonEvent, on);
            }
            DecPrivateModeCode::AnyEventMouse => {
                self.set_mouse_protocol(MouseProtocol::AnyEvent, on);
            }
            DecPrivateModeCode::SGRMouse => {
                self.mouse_encoding = if on {
                    MouseEncoding::Sgr
                } else {
                    MouseEncoding::Default
                };
            }
            _ => {}
        }
    }

    /// Apps frequently activate 1000+1002+1003 in cascade and only disable a
    /// subset on teardown. So `?Nl` only clears the protocol if it currently
    /// matches that exact mode — otherwise it's a no-op.
    fn set_mouse_protocol(&mut self, target: MouseProtocol, on: bool) {
        if on {
            self.mouse_protocol = target;
        } else if self.mouse_protocol == target {
            self.mouse_protocol = MouseProtocol::None;
        }
    }

    fn enter_alt_screen(&mut self) {
        if !self.on_alt {
            self.saved_cursor = Some((
                self.cursor_row,
                self.cursor_col,
                self.current_attrs.clone(),
            ));
            self.alt_screen = Some(blank_screen(self.rows, self.cols));
            self.on_alt = true;
            self.cursor_row = 0;
            self.cursor_col = 0;
        }
    }

    fn exit_alt_screen(&mut self) {
        if self.on_alt {
            self.alt_screen = None;
            self.on_alt = false;
            if let Some((r, c, a)) = self.saved_cursor.clone() {
                self.cursor_row = r.min(self.rows.saturating_sub(1));
                self.cursor_col = c.min(self.cols.saturating_sub(1));
                self.current_attrs = a;
            }
        }
    }

    fn handle_osc(&mut self, osc: OperatingSystemCommand) {
        match osc {
            OperatingSystemCommand::SetIconNameAndWindowTitle(s)
            | OperatingSystemCommand::SetWindowTitle(s)
            | OperatingSystemCommand::SetWindowTitleSun(s) => {
                self.title = s;
            }
            OperatingSystemCommand::SetHyperlink(link) => {
                // OSC 8: track the active hyperlink. Cells printed while it's
                // set carry the URL through their attrs and become clickable
                // on the frontend.
                self.current_attrs.hyperlink = link.map(|h| h.uri().to_string());
            }
            _ => {}
        }
    }

    fn handle_esc(&mut self, esc: Esc) {
        match esc {
            Esc::Code(EscCode::Index) => self.line_feed(),
            Esc::Code(EscCode::NextLine) => {
                self.line_feed();
                self.cursor_col = 0;
            }
            Esc::Code(EscCode::ReverseIndex) => {
                if self.cursor_row == 0 {
                    let cols = self.cols;
                    let screen = self.active_screen_mut();
                    if !screen.is_empty() {
                        screen.pop();
                        screen.insert(0, blank_line(cols));
                    }
                } else {
                    self.cursor_row -= 1;
                }
            }
            Esc::Code(EscCode::DecSaveCursorPosition) => {
                self.saved_cursor = Some((
                    self.cursor_row,
                    self.cursor_col,
                    self.current_attrs.clone(),
                ));
            }
            Esc::Code(EscCode::DecRestoreCursorPosition) => {
                if let Some((r, c, a)) = self.saved_cursor.clone() {
                    self.cursor_row = r.min(self.rows.saturating_sub(1));
                    self.cursor_col = c.min(self.cols.saturating_sub(1));
                    self.current_attrs = a;
                }
            }
            _ => {}
        }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct SearchHit {
    /// 0 = oldest scrollback line, `scrollback_len` = visible row 0.
    pub total_row: u32,
    pub start_col: u32,
    pub end_col: u32,
}

/// Scans `line` for `needle` and pushes each match (in cell-column terms).
/// Continuation cells (right half of a wide grapheme) are skipped, and the
/// match's `end_col` extends to the right edge of the last matched cell so
/// the highlight covers wide chars fully.
fn push_search_hits(
    line: &[TerminalCell],
    needle: &[char],
    total_row: u32,
    hits: &mut Vec<SearchHit>,
) {
    let mut chars: Vec<char> = Vec::with_capacity(line.len());
    let mut char_to_col: Vec<u32> = Vec::with_capacity(line.len());
    let mut char_width: Vec<u32> = Vec::with_capacity(line.len());
    for (idx, cell) in line.iter().enumerate() {
        if cell.width == 0 {
            continue;
        }
        let cw = cell.width.max(1) as u32;
        for c in cell.text.chars().flat_map(|c| c.to_lowercase()) {
            chars.push(c);
            char_to_col.push(idx as u32);
            char_width.push(cw);
        }
    }
    if chars.len() < needle.len() {
        return;
    }
    let max_start = chars.len() - needle.len();
    let mut i = 0;
    while i <= max_start {
        let mut matched = true;
        for j in 0..needle.len() {
            if chars[i + j] != needle[j] {
                matched = false;
                break;
            }
        }
        if matched {
            let start_col = char_to_col[i];
            let last = i + needle.len() - 1;
            let end_col = char_to_col[last] + char_width[last];
            hits.push(SearchHit {
                total_row,
                start_col,
                end_col,
            });
            i += needle.len();
        } else {
            i += 1;
        }
    }
}

fn blank_line(cols: u16) -> Vec<TerminalCell> {
    vec![TerminalCell::default(); cols as usize]
}

fn blank_screen(rows: u16, cols: u16) -> Vec<Vec<TerminalCell>> {
    (0..rows).map(|_| blank_line(cols)).collect()
}

fn blank_cell_with_bg(attrs: &TerminalCellAttrs) -> TerminalCell {
    TerminalCell {
        text: " ".to_string(),
        attrs: TerminalCellAttrs {
            bg: attrs.bg.clone(),
            ..TerminalCellAttrs::default()
        },
        width: 1,
    }
}

fn resize_screen(screen: &mut Vec<Vec<TerminalCell>>, rows: u16, cols: u16) {
    while screen.len() > rows as usize {
        screen.pop();
    }
    while screen.len() < rows as usize {
        screen.push(blank_line(cols));
    }
    let blank = TerminalCell::default();
    for line in screen.iter_mut() {
        if line.len() > cols as usize {
            line.truncate(cols as usize);
        }
        while line.len() < cols as usize {
            line.push(TerminalCell::default());
        }
        // A wide main may have lost its continuation to truncation; clean it.
        fixup_wide_invariant(line, &blank);
    }
}

/// Returns 0/1/2 for the visible column count of `c`. Combining marks and
/// nonprintable code points return 0; East Asian wide and emoji return 2;
/// everything else returns 1. East Asian Ambiguous is treated as 1 (default
/// `unicode-width`); WezTerm has a setting for forcing it to 2.
fn char_cell_width(c: char) -> u8 {
    match c.width().unwrap_or(0) {
        0 => 0,
        1 => 1,
        _ => 2,
    }
}

/// When we're about to overwrite a cell that participates in a wide pair,
/// blank its partner so we don't leave a dangling continuation (right half
/// of a wide whose main was overwritten) or orphan main (wide whose
/// continuation was overwritten).
fn cleanup_overwrite(line: &mut [TerminalCell], col: usize, blank: &TerminalCell) {
    if col >= line.len() {
        return;
    }
    match line[col].width {
        2 => {
            if let Some(cont) = line.get_mut(col + 1) {
                *cont = blank.clone();
            }
        }
        0 => {
            if col > 0 {
                if let Some(main) = line.get_mut(col - 1) {
                    *main = blank.clone();
                }
            }
        }
        _ => {}
    }
}

/// Walks the line and blanks any orphan main (width=2 with no continuation
/// after) or orphan continuation (width=0 with no main before). Called after
/// erase / insert / delete operations that may have split a wide pair.
fn fixup_wide_invariant(line: &mut [TerminalCell], blank: &TerminalCell) {
    let len = line.len();
    let mut i = 0;
    while i < len {
        match line[i].width {
            2 => {
                let next_ok = i + 1 < len && line[i + 1].width == 0;
                if next_ok {
                    i += 2;
                } else {
                    line[i] = blank.clone();
                    i += 1;
                }
            }
            0 => {
                line[i] = blank.clone();
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }
}

fn colorspec_to_attribute(spec: ColorSpec) -> ColorAttribute {
    match spec {
        ColorSpec::Default => ColorAttribute::Default,
        ColorSpec::PaletteIndex(i) => ColorAttribute::PaletteIndex(i),
        ColorSpec::TrueColor(srgba) => ColorAttribute::TrueColorWithDefaultFallback(srgba),
    }
}

/// Encodes a mouse event for transmission back to the running TUI.
///
/// `button`: 0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down. For
/// `MouseEncoding::Default`, release-events ignore `button` and always send 3
/// (the "any-button release" code from the X10 protocol). SGR distinguishes
/// press vs release through the trailing `M` / `m` instead.
///
/// `modifiers` packs the keyboard state: bit 0 = shift, bit 1 = alt, bit 2 = ctrl.
///
/// Cells are 0-indexed throughout the codebase; the wire format is 1-indexed for
/// SGR and offset-by-33 for legacy X10. Default encoding clamps col/row at 222
/// to stay within the byte range — apps that need wider terminals should enable
/// SGR (1006).
pub fn encode_mouse(
    button: u8,
    col: u16,
    row: u16,
    modifiers: u8,
    motion: bool,
    pressed: bool,
    encoding: MouseEncoding,
) -> Vec<u8> {
    let cb_mods = (modifiers & 0b111) << 2;
    let cb_motion = if motion { 32 } else { 0 };
    match encoding {
        MouseEncoding::Sgr => {
            let cb = button | cb_mods | cb_motion;
            let trail = if pressed { 'M' } else { 'm' };
            format!("\x1b[<{};{};{}{}", cb, col + 1, row + 1, trail).into_bytes()
        }
        MouseEncoding::Default => {
            let raw = if pressed { button } else { 3 };
            let cb = (raw | cb_mods | cb_motion).saturating_add(32);
            let cx = col.saturating_add(33).min(255) as u8;
            let cy = row.saturating_add(33).min(255) as u8;
            vec![0x1b, b'[', b'M', cb, cx, cy]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_mouse_sgr_press_left() {
        assert_eq!(
            encode_mouse(0, 10, 5, 0, false, true, MouseEncoding::Sgr),
            b"\x1b[<0;11;6M".to_vec()
        );
    }

    #[test]
    fn encode_mouse_sgr_release_left() {
        assert_eq!(
            encode_mouse(0, 10, 5, 0, false, false, MouseEncoding::Sgr),
            b"\x1b[<0;11;6m".to_vec()
        );
    }

    #[test]
    fn encode_mouse_sgr_motion_left_drag() {
        assert_eq!(
            encode_mouse(0, 10, 5, 0, true, true, MouseEncoding::Sgr),
            b"\x1b[<32;11;6M".to_vec()
        );
    }

    #[test]
    fn encode_mouse_sgr_shift_ctrl_right() {
        // mods = shift|ctrl = 0b101 → (5 << 2) = 20 → button 2 + 20 = 22
        assert_eq!(
            encode_mouse(2, 10, 5, 0b101, false, true, MouseEncoding::Sgr),
            b"\x1b[<22;11;6M".to_vec()
        );
    }

    #[test]
    fn encode_mouse_sgr_wheel_up() {
        assert_eq!(
            encode_mouse(64, 10, 5, 0, false, true, MouseEncoding::Sgr),
            b"\x1b[<64;11;6M".to_vec()
        );
    }

    #[test]
    fn encode_mouse_default_press_left() {
        let want: Vec<u8> = vec![0x1b, b'[', b'M', 32, 10 + 33, 5 + 33];
        assert_eq!(
            encode_mouse(0, 10, 5, 0, false, true, MouseEncoding::Default),
            want
        );
    }

    #[test]
    fn encode_mouse_default_release_uses_button_3() {
        let want: Vec<u8> = vec![0x1b, b'[', b'M', 3 + 32, 10 + 33, 5 + 33];
        assert_eq!(
            encode_mouse(0, 10, 5, 0, false, false, MouseEncoding::Default),
            want
        );
    }

    #[test]
    fn set_dec_mode_x10_and_sgr_encoding() {
        let mut t = TerminalState::new(24, 80);
        assert_eq!(t.mouse_protocol(), MouseProtocol::None);
        assert_eq!(t.mouse_encoding(), MouseEncoding::Default);
        t.advance_bytes(b"\x1b[?1000h\x1b[?1006h");
        assert_eq!(t.mouse_protocol(), MouseProtocol::X10);
        assert_eq!(t.mouse_encoding(), MouseEncoding::Sgr);
    }

    #[test]
    fn set_dec_mode_any_event_toggle() {
        let mut t = TerminalState::new(24, 80);
        t.advance_bytes(b"\x1b[?1003h");
        assert_eq!(t.mouse_protocol(), MouseProtocol::AnyEvent);
        t.advance_bytes(b"\x1b[?1003l");
        assert_eq!(t.mouse_protocol(), MouseProtocol::None);
    }

    #[test]
    fn set_dec_mode_cascade_disable_only_matching() {
        let mut t = TerminalState::new(24, 80);
        // Apps activate 1000+1002+1003 in sequence — last write wins.
        t.advance_bytes(b"\x1b[?1000h\x1b[?1002h\x1b[?1003h");
        assert_eq!(t.mouse_protocol(), MouseProtocol::AnyEvent);
        // Disabling a non-active mode is a no-op.
        t.advance_bytes(b"\x1b[?1000l");
        assert_eq!(t.mouse_protocol(), MouseProtocol::AnyEvent);
        // Disabling the active mode clears it.
        t.advance_bytes(b"\x1b[?1003l");
        assert_eq!(t.mouse_protocol(), MouseProtocol::None);
    }

    fn widths(t: &TerminalState, row: usize) -> Vec<u8> {
        t.active_screen()[row].iter().map(|c| c.width).collect()
    }
    fn texts(t: &TerminalState, row: usize) -> Vec<String> {
        t.active_screen()[row]
            .iter()
            .map(|c| c.text.clone())
            .collect()
    }

    #[test]
    fn print_wide_chinese() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("你好".as_bytes());
        assert_eq!(&widths(&t, 0)[..4], &[2, 0, 2, 0]);
        assert_eq!(texts(&t, 0)[0], "你");
        assert_eq!(texts(&t, 0)[1], "");
        assert_eq!(texts(&t, 0)[2], "好");
        assert_eq!(texts(&t, 0)[3], "");
        let (_, col) = t.cursor_position();
        assert_eq!(col, 4);
    }

    #[test]
    fn print_emoji() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("🚀".as_bytes());
        assert_eq!(&widths(&t, 0)[..2], &[2, 0]);
        assert_eq!(texts(&t, 0)[0], "🚀");
        let (_, col) = t.cursor_position();
        assert_eq!(col, 2);
    }

    #[test]
    fn print_mixed_width() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("a你b".as_bytes());
        assert_eq!(&widths(&t, 0)[..4], &[1, 2, 0, 1]);
        assert_eq!(texts(&t, 0)[0], "a");
        assert_eq!(texts(&t, 0)[1], "你");
        assert_eq!(texts(&t, 0)[2], "");
        assert_eq!(texts(&t, 0)[3], "b");
    }

    #[test]
    fn wide_wraps_at_right_edge() {
        let mut t = TerminalState::new(3, 5);
        t.advance_bytes("abcd你".as_bytes());
        assert_eq!(&widths(&t, 0)[..], &[1, 1, 1, 1, 1]);
        assert_eq!(&widths(&t, 1)[..3], &[2, 0, 1]);
        assert_eq!(texts(&t, 1)[0], "你");
        assert_eq!(t.cursor_position(), (1, 2));
    }

    #[test]
    fn combining_marks_skipped_v18() {
        let mut t = TerminalState::new(2, 10);
        // 'e' followed by combining acute (U+0301).
        t.advance_bytes("e\u{0301}".as_bytes());
        assert_eq!(texts(&t, 0)[0], "e");
        let (_, col) = t.cursor_position();
        assert_eq!(col, 1);
    }

    #[test]
    fn search_finds_wide_char_with_full_end() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("你好世界".as_bytes());
        let hits = t.search("好");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start_col, 2);
        assert_eq!(hits[0].end_col, 4); // covers both cells of 好
    }

    #[test]
    fn overwrite_wide_with_normal_clears_continuation() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("你".as_bytes());
        t.advance_bytes(b"\x1b[H"); // cursor home (0,0)
        t.advance_bytes(b"x");
        assert_eq!(&widths(&t, 0)[..2], &[1, 1]);
        assert_eq!(texts(&t, 0)[0], "x");
        assert_eq!(texts(&t, 0)[1], " "); // cont was blanked
    }

    #[test]
    fn cursor_snaps_off_continuation() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("你".as_bytes());
        // Force cursor onto the continuation cell (col 1).
        t.cursor_col = 1;
        let (_, col) = t.cursor_position();
        assert_eq!(col, 0); // snapped to the wide main
    }

    #[test]
    fn erase_to_end_of_line_cleans_orphan_main() {
        let mut t = TerminalState::new(2, 10);
        t.advance_bytes("a你b".as_bytes());
        // Cursor home + erase from (0,2) to EOL — that's the cont of 你.
        t.advance_bytes(b"\x1b[1;3H"); // CUP (1,3) = row 0, col 2 (1-based)
        t.advance_bytes(b"\x1b[K"); // EraseToEndOfLine
        // The orphan main 你 at col 1 should now be a blank.
        assert_eq!(&widths(&t, 0)[..4], &[1, 1, 1, 1]);
        assert_eq!(texts(&t, 0)[0], "a");
        assert_eq!(texts(&t, 0)[1], " ");
    }
}
