/**
 * Plugin / package manager. Wraps Pi's DefaultPackageManager so the desktop app
 * can list, install, and remove Pi packages (extensions, skills, prompt
 * templates) from any npm:/git:/local source. Installed packages live under
 * PI_CODING_AGENT_DIR (/data/pi) so they survive `heyvm sync`, and are
 * discovered by the chat session's DefaultResourceLoader on the next turn.
 */
import { DefaultPackageManager, type ResolvedResource } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, DATA_DIR, type PiRuntime } from "./session.js";

/** Mirrors Pi's (non-re-exported) ConfiguredPackage shape. */
export interface ConfiguredPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

export interface PluginResource {
  /** Display name derived from the resource path (skill/extension/prompt name). */
  name: string;
  path: string;
  enabled: boolean;
  source: string;
  scope: string;
  origin: string;
}

export interface PluginInfo {
  packages: ConfiguredPackage[];
  skills: PluginResource[];
  extensions: PluginResource[];
  prompts: PluginResource[];
  themes: PluginResource[];
}

/** Derive a readable name from a resource path: a SKILL.md folder uses the
 *  folder name; a bare file uses its basename without extension. */
function resourceName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? p;
  if (/^skill\.md$/i.test(last)) return parts[parts.length - 2] ?? last;
  return last.replace(/\.(md|ts|js|json)$/i, "");
}

export class PluginManager {
  private pm: DefaultPackageManager;

  constructor(runtime: PiRuntime) {
    this.pm = new DefaultPackageManager({
      cwd: DATA_DIR,
      agentDir: AGENT_DIR,
      settingsManager: runtime.settingsManager,
    });
  }

  async list(): Promise<PluginInfo> {
    // Resolve without auto-installing missing sources (skip on miss).
    const resolved = await this.pm.resolve(async () => "skip");
    const map = (r: ResolvedResource): PluginResource => ({
      name: resourceName(r.path),
      path: r.path,
      enabled: r.enabled,
      source: r.metadata.source,
      scope: r.metadata.scope,
      origin: r.metadata.origin,
    });
    return {
      packages: this.pm.listConfiguredPackages(),
      skills: resolved.skills.map(map),
      extensions: resolved.extensions.map(map),
      prompts: resolved.prompts.map(map),
      themes: resolved.themes.map(map),
    };
  }

  async install(source: string, local: boolean): Promise<void> {
    await this.pm.installAndPersist(source, { local });
  }

  async remove(source: string, local: boolean): Promise<void> {
    await this.pm.removeAndPersist(source, { local });
  }
}
