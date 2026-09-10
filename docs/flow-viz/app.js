/**
 * TBH 业务流程可视化 — 交互页逻辑（vanilla JS，零依赖）。
 * 数据来自 flow-viz-data.js（由 docs/agent/scripts/build-flow-viz.mjs 从
 * docs/BUSINESS-FLOWS.md 抽取生成，勿手改）。
 */
(function () {
  "use strict";

  const DATA = window.TBH_FLOW_VIZ || { sourceFile: "", flows: [], services: [], globalMermaid: "" };
  const SVC_SORTED = (DATA.services || []).map((s) => s.id).sort((a, b) => b.length - a.length);

  let currentFlow = null;
  let currentDiagIdx = 0;
  let isGlobal = false;
  let renderSeq = 0;

  const $ = (sel) => document.querySelector(sel);

  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const normalizeLabel = (t) => (t || "").replace(/\s+/g, " ").trim();

  /** Longest-prefix match against the service registry (mirrors build-flow-viz.mjs). */
  function matchService(label) {
    if (!label) return null;
    for (const n of SVC_SORTED) {
      if (label === n || label.startsWith(n + ".") || label.startsWith(n + " ")) return n;
    }
    return null;
  }

  /* ------------------------------ zoom / pan ------------------------------ */

  const zoom = {
    svg: null,
    scale: 1,
    tx: 0,
    ty: 0,
    drag: null,
    apply() {
      if (this.svg) this.svg.style.transform = `scale(${this.scale}) translate(${this.tx}px, ${this.ty}px)`;
    },
    reset() {
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.apply();
    },
    attach(svg) {
      this.svg = svg;
      this.reset();
      svg.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const rect = svg.getBoundingClientRect();
          const px = e.clientX - rect.left;
          const py = e.clientY - rect.top;
          const ns = Math.min(5, Math.max(0.2, this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
          this.tx = px - ((px - this.tx) * ns) / this.scale;
          this.ty = py - ((py - this.ty) * ns) / this.scale;
          this.scale = ns;
          this.apply();
        },
        { passive: false },
      );
      svg.addEventListener("mousedown", (e) => {
        this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        svg.classList.add("dragging");
      });
      svg.addEventListener("mouseup", () => {
        this.drag = null;
        svg.classList.remove("dragging");
      });
    },
  };

  window.addEventListener("mousemove", (e) => {
    if (!zoom.drag || !zoom.svg) return;
    zoom.tx = zoom.drag.tx + (e.clientX - zoom.drag.x);
    zoom.ty = zoom.drag.ty + (e.clientY - zoom.drag.y);
    zoom.apply();
  });
  window.addEventListener("mouseup", () => {
    if (zoom.svg) zoom.svg.classList.remove("dragging");
    zoom.drag = null;
  });

  /* ------------------------------ detail panel ----------------------------- */

  function showServiceDetail(name) {
    const svc = (DATA.services || []).find((s) => s.id === name);
    const el = $("#detail");
    el.innerHTML = "";
    if (!svc) {
      el.innerHTML = `<strong>${escapeHtml(name)}</strong>`;
      return;
    }
    const head = document.createElement("div");
    head.innerHTML = `<strong>${escapeHtml(name)}</strong> 参与 ${svc.flows.length} 个流程：`;
    el.appendChild(head);
    const tags = document.createElement("div");
    tags.className = "flow-tags";
    for (const n of svc.flows) {
      const f = DATA.flows.find((f) => f.number === n);
      if (!f) continue;
      const tag = document.createElement("span");
      tag.className = "flow-tag";
      tag.textContent = `${f.number} ${f.title}`;
      tag.title = "跳转到该流程图";
      tag.addEventListener("click", () => showFlow(f));
      tags.appendChild(tag);
    }
    el.appendChild(tags);
  }

  function showNodeDetail(label, id) {
    const svc = matchService(label);
    if (svc) {
      showServiceDetail(svc);
      return;
    }
    const el = $("#detail");
    el.innerHTML = "";
    const div = document.createElement("div");
    div.innerHTML = `<strong>${escapeHtml(label || id || "")}</strong>` + (id ? ` <span style="color:var(--text-muted)">(id: ${escapeHtml(id)})</span>` : "");
    el.appendChild(div);
  }

  /* ------------------------------ rendering ------------------------------- */

  async function renderDiagram() {
    const target = $("#diagram");
    target.innerHTML = "";
    $("#diagram-select").hidden = true;
    const flow = currentFlow;
    if (!flow || !flow.diagrams.length) {
      $("#diagram-title").textContent = flow ? `第 ${flow.number} 章 ${flow.title}` : "";
      target.innerHTML = '<div class="empty">该章节暂无流程图</div>';
      $("#detail").innerHTML = "";
      return;
    }
    const d = flow.diagrams[currentDiagIdx] || flow.diagrams[0];
    currentDiagIdx = flow.diagrams.indexOf(d);
    $("#diagram-title").textContent = `${flow.number}. ${flow.title} — ${d.label}`;

    const sel = $("#diagram-select");
    sel.innerHTML = "";
    flow.diagrams.forEach((dd, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = dd.label;
      opt.selected = i === currentDiagIdx;
      sel.appendChild(opt);
    });
    sel.hidden = flow.diagrams.length < 2;

    try {
      const { svg, bindFunctions } = await mermaid.render("flow-" + renderSeq++, d.mermaid);
      target.innerHTML = svg;
      const el = target.querySelector("svg");
      if (bindFunctions) bindFunctions(el);
      attachFlowInteractions(el, d);
    } catch (err) {
      target.innerHTML = `<div class="empty">渲染失败：${escapeHtml(err.message || err)}</div>`;
    }
  }

  function attachFlowInteractions(svg, diagram) {
    zoom.attach(svg);

    const labelToEl = new Map();
    for (const el of svg.querySelectorAll("g.node")) {
      const label = normalizeLabel(el.textContent);
      if (label) labelToEl.set(label, el);
    }
    const idToLabel = new Map((diagram.nodes || []).map((n) => [n.id, n.label]));
    const labelToId = new Map((diagram.nodes || []).map((n) => [n.label, n.id]));
    const neighbors = new Map();
    for (const e of diagram.edges || []) {
      if (!neighbors.has(e.from)) neighbors.set(e.from, new Set());
      neighbors.get(e.from).add(e.to);
      if (!neighbors.has(e.to)) neighbors.set(e.to, new Set());
      neighbors.get(e.to).add(e.from);
    }

    const clearHighlight = () =>
      svg.querySelectorAll(".selected, .dimmed, .neighbor").forEach((n) => n.classList.remove("selected", "dimmed", "neighbor"));

    svg.addEventListener("click", (ev) => {
      const g = ev.target.closest("g.node");
      if (!g) return;
      const label = normalizeLabel(g.textContent);
      clearHighlight();
      const id = labelToId.get(label);
      const neigh = (id && neighbors.get(id)) || new Set();
      for (const [lbl, el] of labelToEl) {
        const nid = labelToId.get(lbl);
        if (nid !== id && !neigh.has(nid)) el.classList.add("dimmed");
      }
      for (const nid of neigh) {
        const el = labelToEl.get(idToLabel.get(nid));
        if (el) el.classList.add("neighbor");
      }
      // Dim edges to focus the selected cluster (edges are not mapped to ids, so dim them all).
      svg.querySelectorAll("g.edgePaths, g.edgePath, g.edgeLabel").forEach((e) => e.classList.add("dimmed"));
      g.classList.add("selected");
      showNodeDetail(label, id);
    });
  }

  let pendingGlobalFocus = null;

  async function renderGlobal() {
    const target = $("#diagram");
    target.innerHTML = "";
    $("#diagram-title").textContent = "全流程关联图 — 服务间数据流 / 事件流（跨流程聚合）";
    $("#diagram-select").hidden = true;
    $("#detail").innerHTML = "";
    if (!DATA.globalMermaid) {
      target.innerHTML = '<div class="empty">暂无关联数据</div>';
      return;
    }
    try {
      const { svg, bindFunctions } = await mermaid.render("global-" + renderSeq++, DATA.globalMermaid);
      target.innerHTML = svg;
      const el = target.querySelector("svg");
      if (bindFunctions) bindFunctions(el);
      zoom.attach(el);
      if (pendingGlobalFocus) {
        const focus = pendingGlobalFocus;
        pendingGlobalFocus = null;
        for (const g of el.querySelectorAll("g.node")) {
          if (normalizeLabel(g.textContent) === focus) {
            g.classList.add("selected");
            showServiceDetail(focus);
            break;
          }
        }
      }
      el.addEventListener("click", (ev) => {
        const g = ev.target.closest("g.node");
        if (!g) return;
        const label = normalizeLabel(g.textContent);
        el.querySelectorAll(".selected").forEach((n) => n.classList.remove("selected"));
        g.classList.add("selected");
        showServiceDetail(label);
      });
    } catch (err) {
      target.innerHTML = `<div class="empty">全流程关联图渲染失败：${escapeHtml(err.message || err)}</div>`;
    }
  }

  /* ------------------------------ nav / tabs ------------------------------ */

  function setTab(t) {
    isGlobal = t === "global";
    $("#tab-flow").classList.toggle("active", !isGlobal);
    $("#tab-global").classList.toggle("active", isGlobal);
    $("#diagram-toolbar").hidden = false;
    if (isGlobal) renderGlobal();
    else if (currentFlow) renderDiagram();
  }

  function showFlow(f) {
    currentFlow = f;
    currentDiagIdx = 0;
    document.querySelectorAll("#flow-list li").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.number) === f.number);
    });
    setTab("flow");
    const el = $("#detail");
    el.innerHTML = "";
    const div = document.createElement("div");
    div.innerHTML = `<strong>第 ${f.number} 章 ${escapeHtml(f.title)}</strong>` +
      (f.diagrams.length
        ? ` <a href="../BUSINESS-FLOWS.md#${encodeURIComponent(f.anchor)}" target="_blank" title="打开文档对应章节">在文档中查看 ↗</a>`
        : " <span class=\"empty\">（暂无流程图）</span>");
    el.appendChild(div);
  }

  function showGlobal(focusServiceId) {
    pendingGlobalFocus = focusServiceId || null;
    setTab("global");
  }

  /* ------------------------------ sidebar lists --------------------------- */

  function buildFlowList() {
    const ul = $("#flow-list");
    ul.innerHTML = "";
    for (const f of DATA.flows) {
      const li = document.createElement("li");
      li.dataset.number = f.number;
      const name = document.createElement("span");
      name.textContent = f.title;
      li.appendChild(Object.assign(document.createElement("span"), { className: "num", textContent: f.number }));
      li.appendChild(name);
      if (!f.diagrams.length) li.appendChild(Object.assign(document.createElement("span"), { className: "badge", textContent: "无图" }));
      li.addEventListener("click", () => showFlow(f));
      ul.appendChild(li);
    }
  }

  function buildServiceList() {
    const ul = $("#service-list");
    ul.innerHTML = "";
    for (const s of DATA.services || []) {
      const li = document.createElement("li");
      li.dataset.id = s.id;
      const name = document.createElement("span");
      name.textContent = s.id;
      li.appendChild(name);
      li.appendChild(Object.assign(document.createElement("span"), { className: "badge", textContent: s.flows.length }));
      li.title = `${s.id} — 参与 ${s.flows.length} 个流程（点击查看关联图）`;
      li.addEventListener("click", () => showGlobal(s.id));
      ul.appendChild(li);
    }
  }

  /* ------------------------------ validation ------------------------------ */

  async function runParseCheck() {
    const statusEl = $("#status-parse");
    let total = 0;
    let ok = 0;
    const fails = [];
    for (const f of DATA.flows) {
      for (const d of f.diagrams) {
        total++;
        try {
          await mermaid.parse(d.mermaid);
          ok++;
        } catch (err) {
          fails.push(`第 ${f.number} 章「${f.title}」— ${d.label}: ${err.message || err}`);
        }
      }
    }
    if (!total) {
      statusEl.textContent = "无 mermaid 图";
      return;
    }
    if (!fails.length) {
      statusEl.textContent = `✓ 语法校验 ${ok}/${total} 通过`;
      statusEl.className = "ok";
    } else {
      statusEl.textContent = `✗ 语法校验 ${ok}/${total}（${fails.length} 失败）`;
      statusEl.className = "fail";
      statusEl.title = fails.join("\n");
    }
  }

  /* ------------------------------ theme ----------------------------------- */

  const themeToggle = $("#theme-toggle");
  const THEME_KEY = "flow-viz-theme";
  let darkTheme = false;

  function setTheme(dark) {
    darkTheme = dark;
    themeToggle.checked = dark;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose",
      theme: dark ? "dark" : "base",
      flowchart: { useMaxWidth: true, htmlLabels: true },
    });
    if (isGlobal) renderGlobal();
    else if (currentFlow) renderDiagram();
  }

  /* ------------------------------ boot ------------------------------------ */

  function bindEvents() {
    $("#tab-flow").addEventListener("click", () => setTab("flow"));
    $("#tab-global").addEventListener("click", () => setTab("global"));
    $("#diagram-select").addEventListener("change", (e) => {
      currentDiagIdx = Number(e.target.value);
      renderDiagram();
    });
    $("#zoom-in").addEventListener("click", () => {
      zoom.scale = Math.min(5, zoom.scale * 1.25);
      zoom.apply();
    });
    $("#zoom-out").addEventListener("click", () => {
      zoom.scale = Math.max(0.2, zoom.scale / 1.25);
      zoom.apply();
    });
    $("#zoom-reset").addEventListener("click", () => zoom.reset());
    themeToggle.addEventListener("change", () => {
      try {
        localStorage.setItem(THEME_KEY, themeToggle.checked ? "dark" : "light");
      } catch (err) {
        /* localStorage unavailable (e.g. file:// restrictions) — ignore */
      }
      setTheme(themeToggle.checked);
    });
    $("#search").addEventListener("input", () => {
      const q = $("#search").value.trim().toLowerCase();
      document.querySelectorAll("#flow-list li").forEach((li) => {
        const f = DATA.flows.find((f) => f.number === Number(li.dataset.number));
        li.hidden = !(q === "" || String(f.number) === q || f.title.toLowerCase().includes(q));
      });
      document.querySelectorAll("#service-list li").forEach((li) => {
        li.hidden = !(q === "" || li.dataset.id.toLowerCase().includes(q));
      });
    });
  }

  async function init() {
    let savedTheme = null;
    try {
      savedTheme = localStorage.getItem(THEME_KEY);
    } catch (err) {
      /* ignore */
    }
    setTheme(savedTheme ? savedTheme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
    // Defeat browser form-state restore (which can re-check the toggle without
    // firing change) racing init — re-assert the theme on every page show.
    const reassertTheme = () => {
      if (themeToggle.checked !== darkTheme) setTheme(darkTheme);
    };
    window.addEventListener("pageshow", reassertTheme);
    setTimeout(reassertTheme, 0);
    buildFlowList();
    buildServiceList();
    bindEvents();
    await runParseCheck();
    const first = DATA.flows.find((f) => f.number === 0) || DATA.flows[0];
    if (first) showFlow(first);
  }

  if (typeof mermaid === "undefined") {
    $("#diagram").innerHTML = '<div class="empty">mermaid 库加载失败（本地 vendor 缺失且无法访问 CDN）。</div>';
    return;
  }
  init();
})();
