// End-to-end smoke for the web build: serves dist-web/ via Electron's Chromium,
// feeds it the real save through the app's own drop handler, and asserts the
// inventory table actually renders with decoded item icons.
//
// Why Electron and not agent-browser: `ELECTRON_RUN_AS_NODE=1` is set globally
// on this machine, which makes both the agent-browser Chromium and any Electron
// binary run as plain Node — every navigation silently ends at about:blank.
// Clearing the variable for the child process is what makes this work.
//
// Run: pnpm smoke:web
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const { readFileSync, writeFileSync, existsSync, readdirSync } = require("node:fs");
const { resolve, extname, join } = require("node:path");

const DIST = resolve(__dirname, "..", "..", "..", "dist-web");
const OUT = resolve(__dirname, "..", "..", "..", ".tmp-smoke-out.txt");

const lines = [];
const log = (s) => {
  lines.push(s);
  try {
    writeFileSync(OUT, lines.join("\n"), "utf8");
  } catch {
    // Best-effort progress file; the process exit code is the real signal.
  }
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".png": "image/png",
};

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = resolve(DIST, "." + p);
  if (!file.startsWith(DIST) || !existsSync(file)) return void res.writeHead(404).end("not found");
  const body = readFileSync(file);
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
    "Content-Length": body.length,
  });
  res.end(body);
});

/** Newest save in the game's save folder; prefers the live file. */
function findSave() {
  const root = join(
    process.env.USERPROFILE || "",
    "AppData",
    "LocalLow",
    "TesseractStudio",
    "TaskBarHero",
  );
  if (!existsSync(root)) return null;
  const files = readdirSync(root)
    .filter((n) => n.toLowerCase().endsWith(".es3"))
    .map((n) => join(root, n));
  files.sort(
    (a, b) =>
      (a.toLowerCase().includes("live") ? 0 : 1) - (b.toLowerCase().includes("live") ? 0 : 1),
  );
  return files[0] || null;
}

app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(5279, "127.0.0.1", r));
  log("server: http://127.0.0.1:5279/");
  log("dist:   " + DIST);

  const savePath = findSave();
  if (!savePath) {
    log("NO SAVE FOUND — skipping the load assertions.");
  } else {
    log("save:   " + savePath);
  }
  const b64 = savePath ? readFileSync(savePath).toString("base64") : null;

  const win = new BrowserWindow({ show: false, width: 1440, height: 900 });
  const consoleErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    // level 3 = error
    if (level >= 2) consoleErrors.push(message);
  });
  win.webContents.on("render-process-gone", (_e, d) => log("[render-gone] " + JSON.stringify(d)));

  await win.loadURL("http://127.0.0.1:5279/index.html");
  await new Promise((r) => setTimeout(r, 4000));

  // 1. Shell mounts.
  const shell = await win.webContents.executeJavaScript(`(() => {
    const root = document.getElementById("root");
    return {
      rootKids: root ? root.children.length : -1,
      title: document.title,
      tabs: Array.from(document.querySelectorAll("header button")).map(b => b.innerText.trim()),
      hasFileInput: !!document.querySelector('input[type="file"]'),
      errorBoundary: document.body.innerText.includes("failed to start")
        || document.body.innerText.includes("crashed"),
    };
  })()`);
  log("--- shell ---");
  log(JSON.stringify(shell, null, 2));

  // 2. Load a real save through the app's own drop handler.
  let loaded = null;
  if (b64) {
    loaded = await win.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById("root");
      const dz = Array.from(root.querySelectorAll("div")).find(d => String(d.className).includes("border-dashed"));
      if (!dz) return { err: "drop zone missing" };
      const props = dz[Object.keys(dz).find(k => k.startsWith("__reactProps"))];

      const bin = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], "SaveFile_Live.es3", { type: "application/octet-stream" });
      const dt = new DataTransfer();
      dt.items.add(file);

      // DragEvent -> React onDrop (the same path a real user drop takes).
      dz.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      dz.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));

      // Poll until the table appears or we give up.
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (document.querySelector("table")) break;
      }

      const tables = document.querySelectorAll("table");
      let rows = 0, sample = [];
      for (const t of tables) {
        const trs = Array.from(t.querySelectorAll("tbody tr"));
        if (trs.length > rows) {
          rows = trs.length;
          sample = trs.slice(0, 3).map(tr =>
            Array.from(tr.querySelectorAll("td")).map(td => td.innerText.trim()).join(" | "));
        }
      }

      // Item icons must actually decode. The desktop build serves them over
      // tbh-asset://, which a browser cannot resolve — if the swap in
      // vite.web.config.ts ever regresses, every row keeps its <img> but
      // naturalWidth stays 0 (broken image) and no other assertion notices.
      const imgs = Array.from(document.querySelectorAll("tbody img"));
      const okImgs = imgs.filter(i => i.complete && i.naturalWidth > 0);
      const brokenImgs = imgs.filter(i => i.complete && i.naturalWidth === 0);

      return {
        hasTable: tables.length > 0,
        rows,
        sample,
        imgTotal: imgs.length,
        imgLoaded: okImgs.length,
        imgBroken: brokenImgs.length,
        imgSampleSrc: imgs.slice(0, 3).map(i => i.getAttribute("src")),
        imgSampleSize: okImgs.slice(0, 3).map(i => i.naturalWidth + "x" + i.naturalHeight),
        headerLine: root.innerText.split("\\n").slice(0, 8).join(" / "),
        cjk: /[\\u4e00-\\u9fff]/.test(root.innerText),
        text: root.innerText,
      };
    })()`);
  }
  log("--- inventory ---");
  log(
    JSON.stringify(
      { ...loaded, text: loaded && loaded.text ? loaded.text.slice(0, 400) + "…" : "" },
      null,
      2,
    ),
  );

  // 3. Desktop-guidance tab renders its notice cards.
  const desktopTab = await win.webContents.executeJavaScript(`(async () => {
    const btn = Array.from(document.querySelectorAll("header button")).find(b => /live/i.test(b.innerText));
    if (!btn) return { err: "no Live tracking tab" };
    btn.click();
    await new Promise(r => setTimeout(r, 600));
    const t = document.getElementById("root").innerText;
    return { text: t.slice(0, 700), mentionsDesktop: /desktop app/i.test(t) };
  })()`);
  log("--- desktop tab ---");
  log(JSON.stringify(desktopTab, null, 2));

  const ok = !!(
    shell.rootKids > 0 &&
    !shell.errorBoundary &&
    shell.hasFileInput &&
    loaded &&
    loaded.hasTable &&
    loaded.rows > 10 &&
    loaded.imgBroken === 0
  );
  log(`RESULT: ${ok ? "PASS" : "FAIL"}`);
  if (consoleErrors.length) {
    log("--- console errors ---");
    log(consoleErrors.join("\n"));
  }

  server.close();
  app.exit(ok ? 0 : 1);
});
