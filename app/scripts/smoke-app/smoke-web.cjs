// End-to-end smoke for the web build: serves dist-web/ via Electron's Chromium,
// then exercises the real five-page shell.
//
// Two things are asserted that no unit test can reach:
//   1. With NO save loaded, Lookup / Chests / Trading render real content — the
//      "works without a save" invariant.
//   2. A real save dropped on the Home page decrypts and renders the Inventory
//      table with decoded item icons.
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

  // 1. Shell mounts with five nav sections and lands on Home.
  const shell = await win.webContents.executeJavaScript(`(() => {
    const root = document.getElementById("root");
    const navBtns = Array.from(document.querySelectorAll("header nav button"));
    return {
      rootKids: root ? root.children.length : -1,
      title: document.title,
      navCount: navBtns.length,
      tabs: navBtns.map(b => b.innerText.trim()),
      hasFileInput: !!document.querySelector('input[type="file"]'),
      activeIsHome: navBtns.length > 0 && navBtns[0].getAttribute("aria-current") === "page",
      errorBoundary: document.body.innerText.includes("failed to start")
        || document.body.innerText.includes("crashed"),
    };
  })()`);
  log("--- shell ---");
  log(JSON.stringify(shell, null, 2));

  // 2. No save yet: Lookup / Chests / Trading must each render real content.
  //    Nav is matched by INDEX (0 home, 1 inventory, 2 chests, 3 lookup,
  //    4 trading) so the check is language-independent.
  const noSave = await win.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById("root");
    const nav = () => Array.from(document.querySelectorAll("header nav button"));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const goto = async (i) => { nav()[i].click(); await sleep(1200); };
    const out = {};

    await goto(3); // Lookup
    out.lookupItems = root.querySelectorAll("main ul li").length;
    out.lookupWaiting = /waiting for save/i.test(root.innerText);

    await goto(2); // Chests
    const chestSection = root.querySelector('section[aria-labelledby="chest-catalog-heading"]');
    out.chestCards = chestSection ? chestSection.querySelectorAll("img").length : 0;
    out.chestWaiting = /waiting for save/i.test(root.innerText);

    await goto(4); // Trading
    out.tradingRows = root.querySelectorAll("tbody tr").length;
    out.tradingWaiting = /waiting for save/i.test(root.innerText);

    await goto(0); // Home — desktop-only capabilities must be present.
    out.homeMentionsDesktop = /desktop app/i.test(root.innerText);
    return out;
  })()`);
  log("--- no save (catalog pages) ---");
  log(JSON.stringify(noSave, null, 2));

  // 3. Load a real save through the Home drop zone, then open Inventory.
  let loaded = null;
  if (b64) {
    loaded = await win.webContents.executeJavaScript(`(async () => {
      const root = document.getElementById("root");
      const nav = () => Array.from(document.querySelectorAll("header nav button"));
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // The drop zone lives on Home.
      nav()[0].click();
      await sleep(600);

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

      // Wait for the decode to land (the Home summary shows the file name).
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (root.innerText.includes("SaveFile_Live.es3")) break;
      }

      // Now open Inventory (index 1) and wait for the table.
      nav()[1].click();
      for (let i = 0; i < 20; i++) {
        await sleep(1000);
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
      };
    })()`);
  }
  log("--- inventory (after load) ---");
  log(JSON.stringify(loaded, null, 2));

  const ok = !!(
    shell.rootKids > 0 &&
    !shell.errorBoundary &&
    shell.hasFileInput &&
    shell.navCount === 5 &&
    shell.activeIsHome &&
    noSave.lookupItems > 50 &&
    noSave.chestCards > 0 &&
    noSave.tradingRows > 0 &&
    !noSave.lookupWaiting &&
    !noSave.chestWaiting &&
    !noSave.tradingWaiting &&
    noSave.homeMentionsDesktop &&
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
