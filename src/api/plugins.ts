import { invoke } from "./transport";
import { setPiSkills } from "../skills";

export interface PluginResource {
  name: string;
  path: string;
  enabled: boolean;
  source: string;
  scope: string;
  origin: string;
}

export interface ConfiguredPackage {
  source: string;
  scope: string;
  filtered: boolean;
  installedPath?: string;
}

export interface PluginInfo {
  packages: ConfiguredPackage[];
  skills: PluginResource[];
  extensions: PluginResource[];
  prompts: PluginResource[];
  themes: PluginResource[];
}

// Keep the chat slash-skill menu in sync with the Pi-discovered skills.
function syncSkills(info: PluginInfo): PluginInfo {
  setPiSkills(info.skills.map((s) => ({ name: s.name, hint: `Skill from ${s.source}` })));
  return info;
}

export async function listPlugins(): Promise<PluginInfo> {
  return syncSkills(await invoke<PluginInfo>("list_plugins"));
}

export async function installPlugin(source: string, local: boolean): Promise<PluginInfo> {
  return syncSkills(await invoke<PluginInfo>("install_plugin", { source, local }));
}

export async function removePlugin(source: string, local: boolean): Promise<PluginInfo> {
  return syncSkills(await invoke<PluginInfo>("remove_plugin", { source, local }));
}
