import { useEffect, useState } from "preact/hooks";
import { listPlugins, installPlugin, removePlugin, type PluginInfo } from "../../api/plugins";

// Manage Pi packages (extensions, skills, prompt templates) from any
// npm:/git:/local source. Installed packages live under /data/pi and extend the
// agent on the next turn. Rendered inside the Settings panel.
export function PluginsPanel() {
  const [info, setInfo] = useState<PluginInfo | null>(null);
  const [source, setSource] = useState("");
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setInfo(await listPlugins());
    } catch (e) {
      setError(`${e}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleInstall() {
    const src = source.trim();
    if (!src || busy) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await installPlugin(src, local));
      setSource("");
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(src: string, scope: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setInfo(await removePlugin(src, scope === "project"));
    } catch (e) {
      setError(`${e}`);
    } finally {
      setBusy(false);
    }
  }

  const skills = info?.skills ?? [];
  const extensions = info?.extensions ?? [];
  const prompts = info?.prompts ?? [];
  const packages = info?.packages ?? [];

  return (
    <div class="plugins-panel">
      <div class="settings-field">
        <span class="settings-label">Install a package</span>
        <div class="plugins-install-row">
          <input
            class="settings-input"
            type="text"
            placeholder="npm:pi-web-access · git:github.com/user/repo · /abs/path"
            value={source}
            disabled={busy}
            onInput={(e) => setSource((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleInstall(); }}
          />
          <button class="btn btn-sm btn-primary" disabled={busy || !source.trim()} onClick={() => void handleInstall()}>
            {busy ? "Working…" : "Install"}
          </button>
        </div>
        <label class="plugins-local-toggle">
          <input type="checkbox" checked={local} disabled={busy} onChange={(e) => setLocal((e.target as HTMLInputElement).checked)} />
          <span class="settings-hint">Project-local (install under ./.pi instead of global)</span>
        </label>
      </div>

      {error && <div class="plugins-error">{error}</div>}

      <div class="settings-divider" />
      <div class="settings-section-label">Installed packages</div>
      {packages.length === 0 && <div class="settings-hint">No packages installed yet.</div>}
      {packages.map((pkg) => (
        <div class="plugins-row" key={`${pkg.scope}:${pkg.source}`}>
          <div class="plugins-row-main">
            <span class="plugins-source">{pkg.source}</span>
            <span class="plugins-meta">{pkg.scope}{pkg.filtered ? " · filtered" : ""}</span>
          </div>
          <button class="btn btn-sm btn-ghost" disabled={busy} onClick={() => void handleRemove(pkg.source, pkg.scope)}>
            Remove
          </button>
        </div>
      ))}

      <div class="settings-divider" />
      <div class="settings-section-label">Skills ({skills.length})</div>
      {skills.length === 0 && <div class="settings-hint">Installed packages can add /skill:&lt;name&gt; commands.</div>}
      {skills.map((s) => (
        <div class="plugins-row" key={s.path}>
          <div class="plugins-row-main">
            <span class="plugins-source">/skill:{s.name}</span>
            <span class="plugins-meta">{s.source}</span>
          </div>
        </div>
      ))}

      {extensions.length > 0 && (
        <>
          <div class="settings-divider" />
          <div class="settings-section-label">Extensions ({extensions.length})</div>
          {extensions.map((x) => (
            <div class="plugins-row" key={x.path}>
              <div class="plugins-row-main">
                <span class="plugins-source">{x.name}</span>
                <span class="plugins-meta">{x.source}</span>
              </div>
            </div>
          ))}
        </>
      )}

      {prompts.length > 0 && (
        <>
          <div class="settings-divider" />
          <div class="settings-section-label">Prompt templates ({prompts.length})</div>
          {prompts.map((pr) => (
            <div class="plugins-row" key={pr.path}>
              <div class="plugins-row-main">
                <span class="plugins-source">/{pr.name}</span>
                <span class="plugins-meta">{pr.source}</span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
