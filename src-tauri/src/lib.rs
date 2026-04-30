mod agent_registry;
mod claude_watcher;
mod fonts;
mod session;
mod terminal;
mod terminal_state;

use fonts::get_font_data;
use terminal::{
    close_terminal, resize_terminal, scroll_terminal, search_terminal, send_input,
    send_mouse_event, spawn_terminal, SessionMap,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionMap::default())
        .invoke_handler(tauri::generate_handler![
            spawn_terminal,
            send_input,
            resize_terminal,
            close_terminal,
            scroll_terminal,
            search_terminal,
            send_mouse_event,
            get_font_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
