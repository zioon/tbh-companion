// Web shell: the browser-side app frame.
//
// Renders the real `Inventory` tab (fed by the web `window.tbh` shim) inside a
// dedicated web chrome, and shows a "get the desktop app" card for everything
// the browser cannot do. Keeping the shell separate from `App.tsx` means the
// desktop tab bar, overlays, and window controls stay untouched.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Inventory } from "../renderer/tabs/Inventory";
import { TbhProvider } from "../renderer/context/TbhProvider";
import { EntityPanelProvider } from "../renderer/context/EntityPanelProvider";
import { GlobalEntityPanel } from "../renderer/components/GlobalEntityPanel";
import { ErrorBoundary } from "../renderer/lib/ErrorBoundary";
import { Button, ButtonLink } from "../renderer/design-system/primitives/Button/Button";
import { Card } from "../renderer/design-system/primitives/Card/Card";
import { TabPage } from "../renderer/design-system/primitives/TabPage/TabPage";
import { cn } from "../renderer/lib/cn";
import { clearWebSave, loadWebSaveFile, onWebRuntimeChange, webRuntime } from "./webTbhApi";

const REPO_URL = "https://github.com/zioon/tbh-companion";
const RELEASES_URL = `${REPO_URL}/releases/latest`;

const TABS = [
  { id: "inventory", label: "Inventory" },
  { id: "chests", label: "Chests" },
  { id: "desktop", label: "Live tracking" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function useRuntime() {
  return useSyncExternalStore(
    (cb) => onWebRuntimeChange(cb),
    () => webRuntime(),
    () => webRuntime(),
  );
}

/** Drag-and-drop / click target that loads a `.es3` save locally. */
function SavePicker({ compact = false }: { compact?: boolean }) {
  const runtime = useRuntime();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const onFiles = useCallback((files: FileList | null) => {
    const file = files?.[0];
    if (file) void loadWebSaveFile(file);
  }, []);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors",
        dragging ? "border-accent bg-accent/5" : "border-border bg-card/40",
        compact && "p-4",
      )}
    >
      <p className="m-0 text-sm font-semibold text-fg">
        {runtime.loading ? "Reading save…" : "Drop your SaveFile_Live.es3 here"}
      </p>
      {!compact && (
        <p className="m-0 max-w-prose text-xs leading-relaxed text-muted">
          The file is decrypted and analyzed entirely in your browser. It is never uploaded, and
          nothing is sent anywhere.
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".es3,.json,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          onFiles(e.target.files);
          // Reset so picking the same file again re-triggers change.
          e.target.value = "";
        }}
      />
      <Button
        variant="primary"
        onClick={() => inputRef.current?.click()}
        disabled={runtime.loading}
      >
        Choose save file
      </Button>
    </div>
  );
}

/** Where the save file lives, so users can find it without the desktop app. */
function SaveLocationHelp() {
  return (
    <Card className="text-xs leading-relaxed text-muted">
      <p className="m-0 mb-1.5 font-semibold text-fg">Where is my save file?</p>
      <p className="m-0">
        On Windows it is under{" "}
        <code className="rounded bg-panel px-1 py-0.5 text-[11px]">
          %USERPROFILE%\AppData\LocalLow\TesseractStudio\TaskBarHero\
        </code>{" "}
        — look for{" "}
        <code className="rounded bg-panel px-1 py-0.5 text-[11px]">SaveFile_Live.es3</code>.
      </p>
    </Card>
  );
}

function DesktopOnlyPanel() {
  const items = [
    {
      title: "Live XP & gold rates",
      body: "Watches your save while you play and shows XP/hour, gold/hour, and per-hero rates.",
    },
    {
      title: "Read-only live memory",
      body: "Reads stage clears, chest drops, and DPS straight from the running game for second-accurate data.",
    },
    {
      title: "Chest tracker & always-on-top overlay",
      body: "Cooldown timers for every tracked route, plus a mini overlay that floats over the game.",
    },
    {
      title: "Automatic Steam Market pricing",
      body: "Prices your whole inventory in one pass and totals it after market fees.",
    },
    {
      title: "Pet progress, loot history, notifications",
      body: "Tracks what dropped, when, and alerts you when a chest is ready.",
    },
  ];

  return (
    <TabPage>
      <Card className="border-accent/30 bg-accent/5">
        <p className="m-0 mb-1 text-sm font-semibold text-fg">
          These features need the desktop app
        </p>
        <p className="m-0 text-xs leading-relaxed text-muted">
          A browser can't watch your save file, read the game's memory, or float a window over the
          game. The desktop app does all of it, stays read-only, and keeps your data on your PC.
        </p>
      </Card>

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {items.map((item) => (
          <Card as="li" key={item.title}>
            <p className="m-0 mb-0.5 text-[13px] font-semibold text-accent">{item.title}</p>
            <p className="m-0 text-xs leading-relaxed text-muted">{item.body}</p>
          </Card>
        ))}
      </ul>

      <div className="flex flex-wrap justify-center gap-2 pt-1">
        <ButtonLink variant="primary" href={RELEASES_URL}>
          Download for Windows
        </ButtonLink>
        <ButtonLink variant="ghost" href={REPO_URL}>
          View on GitHub
        </ButtonLink>
      </div>
    </TabPage>
  );
}

function InventoryPanel() {
  const runtime = useRuntime();

  if (runtime.error) {
    return (
      <TabPage>
        <Card className="border-danger/40 bg-danger/5">
          <p className="m-0 mb-1 text-sm font-semibold text-danger">Couldn't read that save</p>
          <p className="m-0 whitespace-pre-line text-xs leading-relaxed text-muted">
            {runtime.error}
          </p>
        </Card>
        <SavePicker />
        <SaveLocationHelp />
      </TabPage>
    );
  }

  if (!runtime.inventory) {
    return (
      <TabPage>
        <SavePicker />
        <SaveLocationHelp />
      </TabPage>
    );
  }

  return (
    <TabPage>
      <Card padding="compact" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-semibold text-fg">{runtime.fileName}</span>
        {runtime.analyze && (
          <span className="text-muted">
            {runtime.analyze.stats.itemCount.toLocaleString()} items ·{" "}
            {runtime.analyze.stats.chestCount.toLocaleString()} chests
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => clearWebSave()}>
            Load another file
          </Button>
        </span>
      </Card>

      <Card className="border-gold/30 bg-gold/5">
        <p className="m-0 text-xs leading-relaxed text-muted">
          <span className="font-semibold text-fg">Prices are not shown here.</span> Steam's market
          API can't be called from a web page. The desktop app prices your full inventory
          automatically.
        </p>
      </Card>

      <Inventory />
    </TabPage>
  );
}

function ChestsPanel() {
  const runtime = useRuntime();

  return (
    <TabPage>
      {runtime.inventory && runtime.inventory.chests.length > 0 ? (
        <Card>
          <p className="m-0 mb-2 text-sm font-semibold text-fg">
            Chests in this save ({runtime.inventory.chests.length})
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
            {runtime.inventory.chests.map((chest) => (
              <li key={chest.uniqueId ?? chest.type} className="flex justify-between gap-3">
                <span className="text-fg">{chest.label ?? `Box #${chest.type}`}</span>
                <span className="text-muted">×{chest.quantity.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <SavePicker />
      )}

      <Card className="border-accent/30 bg-accent/5">
        <p className="m-0 mb-1 text-sm font-semibold text-fg">Ready-cooldown tracking</p>
        <p className="m-0 text-xs leading-relaxed text-muted">
          Chest cooldowns only exist while the game is running, so they need the desktop app's
          overlay and tracker.
        </p>
      </Card>
    </TabPage>
  );
}

export function WebApp() {
  const [tab, setTab] = useState<TabId>("inventory");

  return (
    <EntityPanelProvider>
      <div className="flex min-h-dvh flex-col bg-bg">
        <header className="border-b border-border bg-bg">
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
            <span className="text-sm font-semibold text-fg">TBH Companion</span>
            <span className="rounded bg-panel px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              Web
            </span>
            <nav className="ml-auto flex items-center gap-1" aria-label="Sections">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setTab(entry.id)}
                  className={cn(
                    "rounded px-2.5 py-1 text-xs font-semibold transition-colors",
                    tab === entry.id ? "bg-accent/15 text-accent" : "text-muted hover:text-fg",
                  )}
                  aria-current={tab === entry.id ? "page" : undefined}
                >
                  {entry.label}
                </button>
              ))}
            </nav>
          </div>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-4">
          <ErrorBoundary title="TBH Companion web failed to render">
            {tab === "inventory" && <InventoryPanel />}
            {tab === "chests" && <ChestsPanel />}
            {tab === "desktop" && <DesktopOnlyPanel />}
          </ErrorBoundary>
        </main>

        <footer className="border-t border-border px-5 py-3">
          <p className="mx-auto m-0 max-w-5xl text-[11px] leading-relaxed text-muted">
            Unofficial, open-source tool for Task Bar Hero. Your save is processed locally in this
            tab and never uploaded.{" "}
            <a className="underline hover:text-fg" href={REPO_URL} rel="noopener noreferrer">
              Source on GitHub
            </a>
          </p>
        </footer>

        <GlobalEntityPanel />
      </div>
    </EntityPanelProvider>
  );
}

/** Root of the web bundle: installs translations, then renders the shell. */
export function WebRoot() {
  useEffect(() => {
    // The renderer's i18next init is driven by TbhProvider, which calls
    // `getConfig()` on mount; the web shim answers with the persisted/web
    // default config, so no extra bootstrap is needed here.
  }, []);

  return (
    <ErrorBoundary title="TBH Companion web failed to start">
      <TbhProvider>
        <WebApp />
      </TbhProvider>
    </ErrorBoundary>
  );
}
