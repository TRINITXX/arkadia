mod agent_registry;
mod claude_watcher;
mod fonts;
mod session;
mod terminal;
mod terminal_state;

use std::path::PathBuf;
use std::sync::Arc;

use agent_registry::AgentRegistry;
use claude_watcher::watcher::run_watcher;
use fonts::get_font_data;
use session::{clear as session_clear_fn, load_with_recovery, save_atomic, SessionFile};
use tauri::{AppHandle, Emitter, Manager};
use terminal::{
    close_terminal, resize_terminal, scroll_terminal, search_terminal, send_input,
    send_mouse_event, spawn_terminal, SessionMap,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry: Arc<AgentRegistry> = Arc::new(AgentRegistry::default());

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(SessionMap::default())
        .manage(registry.clone())
        .setup({
            let registry = registry.clone();
            move |app| {
                let app_handle = app.handle().clone();
                let claude_root = dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(".claude")
                    .join("projects");
                let (utx, urx) = std::sync::mpsc::channel::<claude_watcher::watcher::StateUpdate>();
                let (_stx, srx) = std::sync::mpsc::channel::<()>();
                std::thread::spawn(move || {
                    let _ = run_watcher(claude_root, utx, srx);
                });
                std::thread::spawn(move || {
                    while let Ok(update) = urx.recv() {
                        registry.observe_session(
                            &update.cwd,
                            &update.session_id,
                            update.state.clone(),
                        );
                        let payload = agent_registry::AgentStatePayload::from(&update.state);
                        let _ = app_handle.emit(
                            "agent-state-changed",
                            AgentEvent {
                                session_id: update.session_id,
                                cwd: update.cwd,
                                state: payload,
                            },
                        );
                    }
                });
                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            spawn_terminal,
            send_input,
            resize_terminal,
            close_terminal,
            scroll_terminal,
            search_terminal,
            send_mouse_event,
            get_font_data,
            agent_state_for_pane,
            agent_state_for_project,
            session_load,
            session_save,
            session_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[derive(serde::Serialize, Clone)]
struct AgentEvent {
    session_id: String,
    cwd: String,
    state: agent_registry::AgentStatePayload,
}

#[tauri::command]
fn agent_state_for_pane(
    pane_id: String,
    registry: tauri::State<'_, Arc<AgentRegistry>>,
) -> agent_registry::AgentStatePayload {
    let uuid = uuid::Uuid::parse_str(&pane_id).unwrap_or_else(|_| uuid::Uuid::nil());
    registry.pane_state(uuid)
}

#[tauri::command]
fn agent_state_for_project(
    pane_ids: Vec<String>,
    registry: tauri::State<'_, Arc<AgentRegistry>>,
) -> agent_registry::AgentStatePayload {
    let uuids: Vec<uuid::Uuid> = pane_ids
        .into_iter()
        .filter_map(|s| uuid::Uuid::parse_str(&s).ok())
        .collect();
    registry.project_state(&uuids)
}

fn session_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("session.json")
}

#[tauri::command]
fn session_load(app: AppHandle) -> Option<SessionFile> {
    load_with_recovery(&session_path(&app))
}

#[tauri::command]
fn session_save(app: AppHandle, session: SessionFile) -> Result<(), String> {
    save_atomic(&session_path(&app), &session).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_clear(app: AppHandle) {
    session_clear_fn(&session_path(&app));
}
