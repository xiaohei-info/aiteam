#[cfg(target_os = "macos")]
mod agent;
mod agent_solutions;
mod diagnostics;
mod external_links;
mod file_access;
mod files;
#[cfg(target_os = "macos")]
mod local_directory_host;
#[cfg(target_os = "macos")]
mod local_directory_reader;
mod office_editor;
mod secure_session;

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder
        .manage(agent::AgentState::default())
        .setup(agent::setup);

    builder
        .manage(file_access::FileAccessState::default())
        .manage(office_editor::OfficeEditorState::default())
        .manage(agent_solutions::AgentSolutionsState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            select_local_knowledge_directory,
            get_agent_base_url,
            file_access::local_file_access_status,
            file_access::dismiss_file_access_startup,
            file_access::select_file_access_directories,
            file_access::revoke_file_access,
            file_access::open_file_privacy_settings,
            external_links::open_portal_in_browser,
            diagnostics::append_application_logs,
            diagnostics::application_log_snapshot,
            diagnostics::export_application_logs,
            secure_session::secure_session_read,
            secure_session::secure_session_write,
            secure_session::secure_session_delete,
            secure_session::secure_login_credentials_read,
            secure_session::secure_login_credentials_write,
            secure_session::secure_login_credentials_delete,
            secure_session::secure_login_credentials_list,
            files::save_conversation_file,
            files::cache_file,
            files::cache_conversation_file,
            files::resolve_cached_file,
            files::show_in_folder,
            files::open_local_file,
            files::reveal_local_file,
            files::open_cached_file,
            files::scan_local_knowledge_files,
            files::read_file_as_base64,
            files::preview_local_knowledge_file,
            files::preview_knowledge_file_content,
            office_editor::list_office_maps,
            office_editor::read_office_map,
            office_editor::set_active_office_map_cmd,
            office_editor::open_office_map_editor,
            agent_solutions::list_agent_solutions,
            agent_solutions::read_agent_solution_file,
            agent_solutions::open_agent_solution_file,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if matches!(
                _event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                agent::stop(_app);
            }
        });
}

#[tauri::command]
async fn select_local_knowledge_directory(
    app: tauri::AppHandle,
    challenge: String,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "macos")]
    {
        serde_json::to_value(
            local_directory_host::select_local_knowledge_directory(app, challenge).await?,
        )
        .map_err(|_| "invalid_response".into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, challenge);
        Err("本地目录检索尚不支持此平台".into())
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn get_agent_base_url(state: tauri::State<'_, agent::AgentState>) -> Result<String, String> {
    agent::get_agent_base_url(state).await
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn get_agent_base_url() -> Result<String, String> {
    Err("当前内嵌 Agent 包仅支持 Apple Silicon macOS".into())
}
