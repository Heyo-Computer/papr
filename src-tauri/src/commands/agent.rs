use tauri::{State, AppHandle, Emitter, Manager};
use crate::models::agent::AgentMessage;
use crate::services::agent as svc;
use crate::services::heyvm;
use crate::state::AppState;
use crate::logging;

const AGENT_PORT: u16 = 8080;
const AGENT_IMAGE_NAME: &str = "todo-agent-base.qcow2";

fn agent_image_path() -> String {
    let home = dirs::home_dir().expect("Could not determine home directory");
    home.join(".heyo/images").join(AGENT_IMAGE_NAME).to_string_lossy().to_string()
}

fn agent_url() -> String {
    format!("http://localhost:{}", AGENT_PORT)
}

fn read_config(state: &AppState) -> crate::commands::config::AgentConfig {
    crate::commands::config::AgentConfig::default_from_disk(&state.config_dir)
}

/// Full setup workflow: ensure dirs -> create sandbox -> start -> deploy agent -> start agent -> wait
#[tauri::command]
pub async fn setup_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<String, String> {
    logging::info("=== setup_agent: starting ===");

    let config = read_config(&state);
    let vm_name = if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() };
    let backend = if config.vm_backend.is_empty() {
        if cfg!(target_os = "macos") { "apple_vf" } else { "libvirt" }.to_string()
    } else {
        config.vm_backend.clone()
    };
    let data_dir = if config.data_dir.is_empty() {
        state.data_dir.to_string_lossy().to_string()
    } else {
        config.data_dir.clone()
    };

    logging::info(&format!("setup_agent: vm_name={}, backend={}, data_dir={}", vm_name, backend, data_dir));
    logging::info(&format!("setup_agent: model={}, api_key_set={}", config.model, !config.api_key.is_empty()));

    // Step 1: Ensure data directory
    progress(&app, "Creating data directory...");
    for sub in &["storage", "artifacts", "config", "logs"] {
        let p = format!("{}/{}", data_dir, sub);
        if let Err(e) = std::fs::create_dir_all(&p) {
            let msg = format!("setup_agent: failed to create {}: {}", p, e);
            logging::error(&msg);
            return Err(msg);
        }
    }
    logging::info("setup_agent: data directories created");

    // Step 2: Create sandbox with agent port forwarded to host
    progress(&app, "Checking sandbox...");
    if heyvm::sandbox_exists(&vm_name) {
        logging::info(&format!("setup_agent: sandbox '{}' already exists", vm_name));
    } else {
        progress(&app, &format!("Creating sandbox '{}'...", vm_name));
        let image = agent_image_path();
        match heyvm::create_sandbox_with_backend(&vm_name, &backend, &data_dir, Some(&image), &[(AGENT_PORT, AGENT_PORT)]) {
            Ok(result) => {
                if let Some(mapping) = result.port_mappings.first() {
                    logging::info(&format!("setup_agent: sandbox created, port mapping: host:{} -> guest:{}",
                        mapping.host_port, mapping.guest_port));
                } else {
                    logging::info("setup_agent: sandbox created (no port mappings returned)");
                }
            }
            Err(e) => {
                let msg = format!("setup_agent: create sandbox failed: {}", e);
                logging::error(&msg);
                return Err(msg);
            }
        }
    }
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    // Step 3: Start sandbox
    progress(&app, "Starting sandbox...");
    match heyvm::start_sandbox(&vm_name) {
        Ok(out) => logging::info(&format!("setup_agent: start sandbox: {}", out.trim())),
        Err(e) => logging::warn(&format!("setup_agent: start sandbox returned error (may already be running): {}", e)),
    }

    // Step 4: Deploy agent code
    progress(&app, "Deploying agent code...");
    if let Err(e) = deploy_agent_code(&data_dir) {
        let msg = format!("setup_agent: deploy failed: {}", e);
        logging::error(&msg);
        return Err(msg);
    }
    logging::info("setup_agent: agent code deployed");

    // Step 5: Install dependencies (structured output + timeout)
    progress(&app, "Installing agent dependencies...");
    match heyvm::exec_in_sandbox_json(&vm_name, &["sh", "-c", "cd /data/agent && npm install --omit=dev 2>&1"], Some("300s")) {
        Ok(out) => {
            logging::info(&format!("setup_agent: npm install exit_code={}", out.exit_code));
            if !out.stderr.is_empty() {
                logging::warn(&format!("setup_agent: npm stderr: {}", tail(&out.stderr, 300)));
            }
            if out.exit_code != 0 {
                let msg = format!("setup_agent: npm install failed (exit {}): {}", out.exit_code, tail(&out.stdout, 300));
                logging::error(&msg);
                return Err(msg);
            }
        }
        Err(e) => {
            let msg = format!("setup_agent: npm install failed: {}", e);
            logging::error(&msg);
            return Err(msg);
        }
    }

    // Step 6: Start the agent service
    progress(&app, "Starting agent service...");
    let mut env_parts = format!("PORT={}", AGENT_PORT);
    if !config.api_key.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_API_KEY={}", config.api_key));
    }
    if !config.model.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_MODEL={}", config.model));
    }
    let start_cmd = format!("cd /data/agent && {} node dist/index.js > /data/logs/agent.log 2>&1 &", env_parts);
    logging::info(&format!("setup_agent: start_cmd (redacted key): cd /data/agent && PORT={} ANTHROPIC_API_KEY=<set={}> ANTHROPIC_MODEL={} node dist/index.js &",
        AGENT_PORT, !config.api_key.is_empty(), config.model));

    match heyvm::exec_in_sandbox(&vm_name, &["sh", "-c", &start_cmd]) {
        Ok(out) => logging::info(&format!("setup_agent: agent start output: {}", out.trim())),
        Err(e) => logging::warn(&format!("setup_agent: agent start returned error (may be fine for background): {}", e)),
    }

    // Step 7: Wait for agent health (heyvm wait-for checks inside the sandbox)
    progress(&app, "Waiting for agent to be ready...");
    logging::info(&format!("setup_agent: waiting for agent health on port {}", AGENT_PORT));
    if let Err(e) = heyvm::wait_for(&vm_name, AGENT_PORT, Some("30s"), Some("/health")) {
        let agent_log = match heyvm::exec_in_sandbox_json(&vm_name, &["sh", "-c", "tail -30 /data/logs/agent.log 2>&1"], Some("5s")) {
            Ok(out) => out.stdout,
            Err(e) => format!("(could not read agent log: {})", e),
        };
        logging::error(&format!("setup_agent: wait-for failed: {}. Agent log:\n{}", e, agent_log));
        let _ = app.emit("agent-status", "error");
        logging::info("=== setup_agent: failed ===");
        return Err(format!("Agent failed to respond within 30 seconds. Check ~/.todo/logs/todo.log and ~/.todo/logs/agent.log for details."));
    }

    // Step 8: Establish host connection (direct if --open-port, port-forward fallback for old sandboxes)
    progress(&app, "Connecting to agent...");
    match establish_host_connection(&vm_name, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url.clone());
            let _ = app.emit("agent-status", "running");
            logging::info(&format!("setup_agent: agent ready at {}", url));
            logging::info("=== setup_agent: complete ===");
            Ok(format!("Agent ready in sandbox '{}'", vm_name))
        }
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            logging::error(&format!("setup_agent: connection failed: {}", e));
            logging::info("=== setup_agent: failed ===");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn start_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("start_agent: starting");
    let _ = app.emit("agent-status", "starting");

    let config = read_config(&state);
    let vm_name = {
        let lock = state.vm_name.lock().unwrap();
        lock.clone()
    }.unwrap_or_else(|| {
        if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() }
    });

    let mut env_parts = format!("PORT={}", AGENT_PORT);
    if !config.api_key.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_API_KEY={}", config.api_key));
    }
    if !config.model.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_MODEL={}", config.model));
    }
    let start_cmd = format!("cd /data/agent && {} node dist/index.js > /data/logs/agent.log 2>&1 &", env_parts);
    logging::info(&format!("start_agent: vm={}, model={}", vm_name, config.model));

    match heyvm::exec_in_sandbox(&vm_name, &["sh", "-c", &start_cmd]) {
        Ok(_) => logging::info("start_agent: exec returned"),
        Err(e) => logging::warn(&format!("start_agent: exec error (may be fine for background): {}", e)),
    }

    // Wait for agent health
    if let Err(_) = heyvm::wait_for(&vm_name, AGENT_PORT, Some("30s"), Some("/health")) {
        let _ = app.emit("agent-status", "error");
        logging::error("start_agent: timed out waiting for agent health");
        return Err("Agent failed to start within 30 seconds. Check ~/.todo/logs/ for details.".to_string());
    }

    match establish_host_connection(&vm_name, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url);
            let _ = app.emit("agent-status", "running");
            logging::info("start_agent: agent ready");
            Ok(())
        }
        Err(e) => {
            let _ = app.emit("agent-status", "error");
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn stop_agent(
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    logging::info("stop_agent: stopping");

    let mode = state.agent_mode.lock().unwrap().clone();

    match mode {
        crate::state::AgentMode::Local => {
            // Local mode: send stop RPC and kill port-forward
            let url = state.agent_url.lock().unwrap().clone();
            if let Some(url) = url {
                let _ = svc::send_rpc(&url, "agent/stop", serde_json::Value::Null).await;
            }
            state.kill_port_forward();
            *state.agent_url.lock().unwrap() = None;
        }
        crate::state::AgentMode::Deployed | crate::state::AgentMode::Remote => {
            // Deployed/Remote: just clear the URL, sandbox keeps running
            *state.agent_url.lock().unwrap() = None;
        }
    }

    let _ = app.emit("agent-status", "disconnected");
    logging::info("stop_agent: done");
    Ok(())
}

#[tauri::command]
pub async fn send_message(
    message: String,
    state: State<'_, AppState>,
) -> Result<AgentMessage, String> {
    let url = {
        let lock = state.agent_url.lock().unwrap();
        lock.clone()
    };

    let url = url.ok_or("Agent is not running. Use the status popover to set up the agent.")?;
    logging::info(&format!("send_message: sending {} chars to {}", message.len(), url));
    let result = svc::send_chat_message(&url, &message).await;
    match &result {
        Ok(msg) => logging::info(&format!("send_message: got response, {} chars", msg.content.len())),
        Err(e) => logging::error(&format!("send_message: error: {}", e)),
    }
    result
}

#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> Result<String, String> {
    let url = {
        let lock = state.agent_url.lock().unwrap();
        lock.clone()
    };

    match url {
        Some(url) => {
            if svc::check_health(&url).await {
                Ok("running".to_string())
            } else {
                Ok("error".to_string())
            }
        }
        None => Ok("disconnected".to_string()),
    }
}

#[tauri::command]
pub fn get_chat_history(
    date: String,
    state: State<AppState>,
) -> Vec<AgentMessage> {
    let dir = crate::services::storage::day_dir(&state.storage_root, &date);
    let path = dir.join("chat.json");

    if let Ok(content) = std::fs::read_to_string(&path) {
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    }
}

/// After wait-for confirms the agent is running inside the sandbox,
/// verify the host can reach it. If not (old sandbox without --open-port),
/// fall back to heyvm port-forward.
async fn establish_host_connection(
    vm_name: &str,
    state: &AppState,
) -> Result<String, String> {
    let url = agent_url();

    // Try direct HTTP (works when sandbox was created with --open-port)
    if svc::check_health(&url).await {
        logging::info(&format!("establish_connection: direct HTTP works at {}", url));
        return Ok(url);
    }

    // Fallback: start port-forward for old sandboxes
    logging::info("establish_connection: direct HTTP failed, falling back to port-forward");
    state.kill_port_forward();
    let child = heyvm::port_forward(vm_name, AGENT_PORT, Some(AGENT_PORT))?;
    *state.port_forward_child.lock().unwrap() = Some(child);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    if svc::check_health(&url).await {
        logging::info(&format!("establish_connection: port-forward working at {}", url));
        Ok(url)
    } else {
        Err("Agent is running inside sandbox but host cannot reach it. Try deleting and recreating the sandbox.".to_string())
    }
}

/// Try to auto-start the agent on app boot. Called from the Tauri setup hook.
/// Checks for persisted deployment info first; falls back to local sandbox auto-start.
/// Failures are logged but not propagated — the user can always start manually.
pub async fn auto_start_agent(app: AppHandle) {
    let state = app.state::<AppState>();

    // Check for persisted deployment (deployed or remote mode)
    let deploy_info = state.load_deployment_info();
    if deploy_info.mode != crate::state::AgentMode::Local {
        if let Some(ref url) = deploy_info.public_url {
            logging::info(&format!("auto_start: found persisted {:?} deployment at {}", deploy_info.mode, url));
            let _ = app.emit("agent-status", "starting");

            if svc::check_health(url).await {
                *state.agent_url.lock().unwrap() = Some(url.clone());
                state.apply_deployment(&deploy_info);
                let _ = app.emit("agent-status", "running");
                logging::info(&format!("auto_start: reconnected to {} deployment at {}",
                    if deploy_info.mode == crate::state::AgentMode::Deployed { "deployed" } else { "remote" }, url));
                return;
            } else {
                logging::warn(&format!("auto_start: persisted deployment at {} not healthy", url));
                // Keep deployment info so user can retry, but report error
                state.apply_deployment(&deploy_info);
                let _ = app.emit("agent-status", "error");
                return;
            }
        }
    }

    // Local mode: existing auto-start logic
    let config = read_config(&state);

    if config.api_key.is_empty() {
        logging::info("auto_start: no API key configured, skipping");
        return;
    }

    let vm_name = if config.vm_name.is_empty() { "todo-agent".to_string() } else { config.vm_name.clone() };

    if !heyvm::sandbox_exists(&vm_name) {
        logging::info(&format!("auto_start: sandbox '{}' does not exist, skipping", vm_name));
        return;
    }

    logging::info(&format!("auto_start: attempting to start agent in '{}'", vm_name));
    let _ = app.emit("agent-status", "starting");

    // Start sandbox
    match heyvm::start_sandbox(&vm_name) {
        Ok(out) => logging::info(&format!("auto_start: start sandbox: {}", out.trim())),
        Err(e) => logging::warn(&format!("auto_start: start sandbox error (may already be running): {}", e)),
    }
    *state.vm_name.lock().unwrap() = Some(vm_name.clone());

    // Start agent process
    let mut env_parts = format!("PORT={}", AGENT_PORT);
    if !config.api_key.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_API_KEY={}", config.api_key));
    }
    if !config.model.is_empty() {
        env_parts.push_str(&format!(" ANTHROPIC_MODEL={}", config.model));
    }
    let start_cmd = format!("cd /data/agent && {} node dist/index.js > /data/logs/agent.log 2>&1 &", env_parts);

    match heyvm::exec_in_sandbox(&vm_name, &["sh", "-c", &start_cmd]) {
        Ok(_) => logging::info("auto_start: agent process launched"),
        Err(e) => {
            logging::warn(&format!("auto_start: exec error: {}", e));
            let _ = app.emit("agent-status", "error");
            return;
        }
    }

    // Wait for health
    if let Err(e) = heyvm::wait_for(&vm_name, AGENT_PORT, Some("30s"), Some("/health")) {
        logging::warn(&format!("auto_start: agent not healthy: {}", e));
        let _ = app.emit("agent-status", "error");
        return;
    }

    // Establish host connection
    match establish_host_connection(&vm_name, &state).await {
        Ok(url) => {
            *state.agent_url.lock().unwrap() = Some(url.clone());
            let _ = app.emit("agent-status", "running");
            logging::info(&format!("auto_start: agent ready at {}", url));
        }
        Err(e) => {
            logging::warn(&format!("auto_start: connection failed: {}", e));
            let _ = app.emit("agent-status", "error");
        }
    }
}

// ── Helpers ──

fn progress(app: &AppHandle, msg: &str) {
    logging::info(&format!("setup_agent: {}", msg));
    let _ = app.emit("setup-progress", msg.to_string());
}

fn tail(s: &str, max_chars: usize) -> &str {
    if s.len() <= max_chars {
        s.trim()
    } else {
        s[s.len() - max_chars..].trim()
    }
}

/// Copy the agent/ directory into the data dir so it's accessible inside the VM at /data/agent
fn deploy_agent_code(data_dir: &str) -> Result<(), String> {
    let agent_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../agent");
    let agent_dst = std::path::Path::new(data_dir).join("agent");

    logging::info(&format!("deploy_agent_code: src={}, dst={}", agent_src.display(), agent_dst.display()));

    if !agent_src.exists() {
        return Err(format!("Agent source not found at {}", agent_src.display()));
    }

    let entries: Vec<_> = std::fs::read_dir(&agent_src)
        .map_err(|e| format!("Cannot read agent src: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    logging::info(&format!("deploy_agent_code: src contents: {:?}", entries));

    copy_dir_recursive(&agent_src, &agent_dst).map_err(|e| format!("Failed to deploy agent: {}", e))?;

    let index_js = agent_dst.join("dist/index.js");
    let pkg_json = agent_dst.join("package.json");
    logging::info(&format!("deploy_agent_code: dist/index.js exists={}, package.json exists={}",
        index_js.exists(), pkg_json.exists()));

    if !index_js.exists() {
        return Err("Agent dist/index.js not found after deploy. Run 'tsc' in agent/ to build.".to_string());
    }

    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // Skip node_modules and dotfiles (dist is kept -- pre-built)
        if name_str == "node_modules" || name_str.starts_with('.') {
            continue;
        }

        let src_path = entry.path();
        let dst_path = dst.join(&name);

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}
