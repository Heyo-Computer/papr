/**
 * Pi runtime + session construction. Owns the auth/model/settings managers and
 * builds AgentSessions configured with paperagent's domain tools and system
 * prompt. The same runtime is shared by the chat sessions and the plugin
 * package manager so installed packages and skills resolve against one config
 * directory (PI_CODING_AGENT_DIR, defaulting to /data/pi).
 */
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  SessionManager,
  DefaultResourceLoader,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Model } from "@earendil-works/pi-ai";

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? "/data/pi";
// The mounted data volume. Overridable for local testing; production is /data.
export const DATA_DIR = process.env.AGENT_DATA_DIR ?? "/data";

/** Pi's built-in tools we keep enabled — they replace the old read_file /
 *  write_file / list_directory / exec_command custom tools. `bash` covers
 *  directory listing and arbitrary shell. */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

function resolveProvider(): { provider: string; keyVar: string } {
  const which = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase();
  const provider = which === "openrouter" ? "openrouter" : "anthropic";
  return { provider, keyVar: provider === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY" };
}

export class PiRuntime {
  readonly authStorage = AuthStorage.create(`${AGENT_DIR}/auth.json`);
  readonly modelRegistry = ModelRegistry.create(this.authStorage, `${AGENT_DIR}/models.json`);
  readonly settingsManager = SettingsManager.create(DATA_DIR, AGENT_DIR);
  private _model?: Model<any>;

  /**
   * Resolve the configured model, applying the API key in-memory. The key is
   * NOT persisted to disk (setRuntimeApiKey), preserving the host's secret-scrub
   * guarantee for the /data volume. Throws a clear error when no key is set,
   * matching the previous lazy-provider behavior.
   */
  model(): Model<any> {
    if (this._model) return this._model;
    const { provider, keyVar } = resolveProvider();
    const key = process.env[keyVar];
    if (!key) {
      throw new Error("No API key configured — set your API key in Settings to use chat.");
    }
    this.authStorage.setRuntimeApiKey(provider, key);
    const modelId =
      provider === "openrouter"
        ? process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4-6"
        : process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Model '${modelId}' not found for provider '${provider}'. Check Settings.`);
    }
    this._model = model as Model<any>;
    console.log(`Agent using provider=${provider} model=${modelId}`);
    return this._model;
  }

  /** Build a persistent chat session with the domain tools + system prompt.
   *  The resource loader discovers any installed Pi packages/skills/extensions
   *  from settings.json so the plugin system extends this session. */
  async buildChatSession(opts: {
    systemPrompt: string;
    customTools: ToolDefinition[];
    sessionId: string;
  }): Promise<AgentSession> {
    const model = this.model();
    const loader = new DefaultResourceLoader({
      cwd: DATA_DIR,
      agentDir: AGENT_DIR,
      settingsManager: this.settingsManager,
      systemPromptOverride: () => opts.systemPrompt,
    });
    await loader.reload();

    const sessionManager = SessionManager.create(DATA_DIR, `${AGENT_DIR}/sessions`, {
      id: opts.sessionId,
    });

    const { session } = await createAgentSession({
      cwd: DATA_DIR,
      agentDir: AGENT_DIR,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager,
      resourceLoader: loader,
      model,
      thinkingLevel: "medium",
      tools: [...BUILTIN_TOOLS, ...opts.customTools.map((t) => t.name)],
      customTools: opts.customTools,
    });
    return session;
  }

  /** Run a single tool-less prompt and collect the assistant text. Used for the
   *  deterministic /search summary and stateless voice-note structuring; never
   *  touches a persistent session. */
  async oneShot(systemPrompt: string, userText: string): Promise<string> {
    const model = this.model();
    const loader = new DefaultResourceLoader({
      cwd: DATA_DIR,
      agentDir: AGENT_DIR,
      settingsManager: this.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      systemPromptOverride: () => systemPrompt,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: DATA_DIR,
      agentDir: AGENT_DIR,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager: SessionManager.inMemory(DATA_DIR),
      resourceLoader: loader,
      model,
      thinkingLevel: "off",
      noTools: "all",
    });

    let text = "";
    const unsub = session.subscribe((ev) => {
      if (ev.type === "message_update" && ev.assistantMessageEvent.type === "text_delta") {
        text += ev.assistantMessageEvent.delta;
      }
    });
    try {
      await session.prompt(userText);
    } finally {
      unsub();
      session.dispose();
    }
    return text.trim();
  }
}
