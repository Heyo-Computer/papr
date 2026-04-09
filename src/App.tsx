import { ThemeProvider } from "./theme/ThemeProvider";
import { useTheme } from "./theme/ThemeProvider";
import { useRef, useCallback, useEffect } from "preact/hooks";
import { activeTab, agentStatus, agentMode, settingsOpen, agentName, statusPopoverOpen, days } from "./state/store";
import { WeekAccordion } from "./components/days/DayAccordion";
import { MonthAccordion } from "./components/days/MonthAccordion";
import { ArtifactsPanel } from "./components/artifacts/ArtifactsPanel";
import { ChatWindow } from "./components/chat/ChatWindow";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { StatusPopover } from "./components/status/StatusPopover";
import { setupEventListeners } from "./api/events";
import { getAgentStatus, getDaysRange } from "./api/commands";
import type { ViewTab, AgentStatus } from "./types";
import { signal } from "@preact/signals";

const tabs: { id: ViewTab; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "artifacts", label: "Artifacts" },
];

// Content area height in pixels (null = use flex default)
const contentHeight = signal<number | null>(null);

function AppShell() {
  const { theme, setTheme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    setupEventListeners();
    // Sync initial agent status (auto-start may have finished before listener was ready)
    getAgentStatus().then((s) => {
      agentStatus.value = s as AgentStatus;
    }).catch(() => {});

    // Re-fetch data on window focus when in deployed/remote mode (multi-device sync)
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && agentMode.value !== "local") {
        getDaysRange().then((d) => { days.value = d; }).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Offset from top of container to the mouse position
      // Subtract header (~38) + tabs (~34) = ~72px
      const headerOffset = 72;
      const minContent = 80;
      const minChat = 150;
      const available = rect.height - headerOffset;
      let newHeight = e.clientY - rect.top - headerOffset;
      newHeight = Math.max(minContent, Math.min(newHeight, available - minChat));
      contentHeight.value = newHeight;
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const contentStyle = contentHeight.value !== null
    ? { height: `${contentHeight.value}px`, flex: "none" }
    : undefined;

  return (
    <div class="app-column" ref={containerRef}>
      {/* Header */}
      <div class="app-header">
        <h1 class="app-title">{agentName.value}</h1>
        <div class="app-header-right">
          <button
            class="header-icon-btn"
            onClick={() => (statusPopoverOpen.value = true)}
            title="Status"
          >
            <span class={`status-indicator ${agentStatus.value}`} />
          </button>
          <button
            class="header-icon-btn"
            onClick={() => (settingsOpen.value = true)}
            title="Agent settings"
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
              <path d="M16.2 12.5a1.4 1.4 0 0 0 .3 1.5l.05.05a1.7 1.7 0 1 1-2.4 2.4l-.05-.05a1.4 1.4 0 0 0-1.5-.3 1.4 1.4 0 0 0-.85 1.28v.15a1.7 1.7 0 1 1-3.4 0v-.08A1.4 1.4 0 0 0 7.5 16.2a1.4 1.4 0 0 0-1.5.3l-.05.05a1.7 1.7 0 1 1-2.4-2.4l.05-.05a1.4 1.4 0 0 0 .3-1.5A1.4 1.4 0 0 0 2.62 11.75h-.15a1.7 1.7 0 1 1 0-3.4h.08A1.4 1.4 0 0 0 3.8 7.5a1.4 1.4 0 0 0-.3-1.5l-.05-.05a1.7 1.7 0 1 1 2.4-2.4l.05.05a1.4 1.4 0 0 0 1.5.3h.07a1.4 1.4 0 0 0 .85-1.28v-.15a1.7 1.7 0 1 1 3.4 0v.08a1.4 1.4 0 0 0 .85 1.28 1.4 1.4 0 0 0 1.5-.3l.05-.05a1.7 1.7 0 1 1 2.4 2.4l-.05.05a1.4 1.4 0 0 0-.3 1.5v.07a1.4 1.4 0 0 0 1.28.85h.15a1.7 1.7 0 0 1 0 3.4h-.08a1.4 1.4 0 0 0-1.28.85Z" />
            </svg>
          </button>
          <button
            class="header-icon-btn"
            onClick={() => setTheme(theme.name === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {theme.name === "dark" ? "\u2600" : "\u263E"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div class="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={`tab-btn ${activeTab.value === tab.id ? "active" : ""}`}
            onClick={() => (activeTab.value = tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable content area */}
      <div class="content-area" style={contentStyle}>
        {activeTab.value === "week" && <WeekAccordion />}
        {activeTab.value === "month" && <MonthAccordion />}
        {activeTab.value === "artifacts" && <ArtifactsPanel />}
      </div>

      {/* Resize handle */}
      <div class="resize-handle" onMouseDown={onMouseDown}>
        <div class="resize-handle-bar" />
      </div>

      {/* Chat — always visible, anchored to bottom */}
      <ChatWindow />

      {/* Overlays */}
      <SettingsPanel />
      <StatusPopover />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
