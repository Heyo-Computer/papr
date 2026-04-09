use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentMode {
    Local,
    Deployed,
    Remote,
}

impl Default for AgentMode {
    fn default() -> Self {
        AgentMode::Local
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct DeploymentInfo {
    pub mode: AgentMode,
    pub sandbox_id: Option<String>,
    pub public_url: Option<String>,
}

impl Default for DeploymentInfo {
    fn default() -> Self {
        Self {
            mode: AgentMode::Local,
            sandbox_id: None,
            public_url: None,
        }
    }
}

pub struct AppState {
    pub storage_root: PathBuf,
    pub config_dir: PathBuf,
    pub artifacts_dir: PathBuf,
    pub data_dir: PathBuf,
    pub vm_name: Mutex<Option<String>>,
    /// Actual agent URL (e.g. "http://localhost:8080") when connected.
    pub agent_url: Mutex<Option<String>>,
    /// Running `heyvm port-forward` child process (fallback for old sandboxes without --open-port).
    pub port_forward_child: Mutex<Option<std::process::Child>>,
    /// Current agent connection mode.
    pub agent_mode: Mutex<AgentMode>,
    /// Cloud sandbox ID/slug after deploy.
    pub deploy_sandbox_id: Mutex<Option<String>>,
    /// Public URL after bind (e.g. "https://slug.heyo.computer").
    pub deploy_url: Mutex<Option<String>>,
}

impl AppState {
    pub fn new() -> Self {
        let home = dirs::home_dir().expect("Could not determine home directory");
        let base = home.join(".todo");

        Self {
            storage_root: base.join("storage"),
            config_dir: base.join("config"),
            artifacts_dir: base.join("artifacts"),
            data_dir: base.clone(),
            vm_name: Mutex::new(None),
            agent_url: Mutex::new(None),
            port_forward_child: Mutex::new(None),
            agent_mode: Mutex::new(AgentMode::Local),
            deploy_sandbox_id: Mutex::new(None),
            deploy_url: Mutex::new(None),
        }
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.storage_root)?;
        std::fs::create_dir_all(&self.config_dir)?;
        std::fs::create_dir_all(&self.artifacts_dir)?;
        Ok(())
    }

    pub fn kill_port_forward(&self) {
        if let Some(mut child) = self.port_forward_child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Load persisted deployment info from disk.
    pub fn load_deployment_info(&self) -> DeploymentInfo {
        let path = self.config_dir.join("deployment.json");
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(info) = serde_json::from_str::<DeploymentInfo>(&content) {
                return info;
            }
        }
        DeploymentInfo::default()
    }

    /// Save deployment info to disk.
    pub fn save_deployment_info(&self, info: &DeploymentInfo) -> Result<(), String> {
        let path = self.config_dir.join("deployment.json");
        let content = serde_json::to_string_pretty(info).map_err(|e| e.to_string())?;
        std::fs::write(&path, content).map_err(|e| e.to_string())
    }

    /// Apply deployment info to in-memory state.
    pub fn apply_deployment(&self, info: &DeploymentInfo) {
        *self.agent_mode.lock().unwrap() = info.mode.clone();
        *self.deploy_sandbox_id.lock().unwrap() = info.sandbox_id.clone();
        *self.deploy_url.lock().unwrap() = info.public_url.clone();
    }

    /// Clear all deployment state and persist.
    pub fn clear_deployment(&self) {
        let info = DeploymentInfo::default();
        self.apply_deployment(&info);
        let _ = self.save_deployment_info(&info);
    }
}
