mod commands;
mod logging;
mod models;
mod services;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState::new();
    app_state.ensure_dirs().expect("Failed to create app directories");
    logging::init(&app_state.data_dir);
    logging::info("Application starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_mic_recorder::init())
        .manage(app_state)
        .setup(|app| {
            // Grant microphone permission on Linux (WebKitGTK)
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt, PermissionRequest};
                if let Some(window) = app.get_webview_window("main") {
                    match window.with_webview(|webview| {
                        let wv = webview.inner();
                        if let Some(settings) = wv.settings() {
                            settings.set_enable_media(true);
                            settings.set_enable_media_stream(true);
                            settings.set_enable_media_capabilities(true);
                            logging::info("WebKitGTK: media stream settings enabled");
                        } else {
                            logging::error("WebKitGTK: failed to get settings");
                        }
                        wv.connect_permission_request(|_, request: &PermissionRequest| {
                            logging::info("WebKitGTK: auto-granting permission request");
                            request.allow();
                            true
                        });
                    }) {
                        Ok(_) => logging::info("WebKitGTK: webview media setup complete"),
                        Err(e) => logging::error(&format!("WebKitGTK: with_webview failed: {}", e)),
                    }
                } else {
                    logging::error("WebKitGTK: could not find main window for media setup");
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::agent::auto_start_agent(handle.clone()).await;
                commands::calendar::auto_sync_calendar(handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Storage
            commands::storage::load_day,
            commands::storage::get_days_range,
            commands::storage::get_month_range,
            commands::storage::save_todo,
            commands::storage::update_todo,
            commands::storage::delete_todo,
            commands::storage::load_spec,
            commands::storage::save_spec,
            // Theme
            commands::theme::get_theme,
            commands::theme::set_theme,
            // heyvm
            commands::heyvm::create_vm,
            commands::heyvm::start_vm,
            commands::heyvm::stop_vm,
            commands::heyvm::vm_status,
            commands::heyvm::snapshot_vm,
            // Agent
            commands::agent::setup_agent,
            commands::agent::start_agent,
            commands::agent::stop_agent,
            commands::agent::send_message,
            commands::agent::agent_status,
            commands::agent::get_chat_history,
            // Artifacts
            commands::artifacts::list_artifacts,
            commands::artifacts::read_artifact,
            commands::artifacts::save_artifact,
            commands::artifacts::delete_artifact,
            // Config
            commands::config::get_agent_config,
            commands::config::set_agent_config,
            commands::config::get_status_info,
            commands::config::get_recent_logs,
            // Calendar
            commands::calendar::get_calendar_config,
            commands::calendar::set_calendar_config,
            commands::calendar::get_calendar_status,
            commands::calendar::connect_google_calendar,
            commands::calendar::disconnect_google_calendar,
            commands::calendar::fetch_calendar_events,
            commands::calendar::sync_calendar_to_todos,
            // Speech
            commands::speech::transcribe_audio,
            commands::speech::transcribe_file,
            commands::speech::speak_text,
            // Deploy
            commands::deploy::deploy_agent,
            commands::deploy::connect_remote,
            commands::deploy::disconnect_remote,
            commands::deploy::teardown_deploy,
            commands::deploy::get_deployment_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
