#!/usr/bin/env node
/**
 * Generate interactive business-flow visualization data from docs/BUSINESS-FLOWS.md.
 *
 * The markdown document is the single source of truth: each flow chapter embeds
 * one or more ```mermaid flowchart``` blocks. This script extracts them, builds a
 * structured index (flows + diagrams + service participation + cross-flow edges)
 * and emits docs/flow-viz/flow-viz-data.js for the standalone interactive page.
 *
 * Run from repo root:
 *   node docs/agent/scripts/build-flow-viz.mjs            # write data file
 *   node docs/agent/scripts/build-flow-viz.mjs --check    # CI: fail if out of sync / unparsable
 *   node docs/agent/scripts/build-flow-viz.mjs --vendor   # download mermaid.min.js locally
 *
 * Zero external dependencies (node:fs + global fetch only), matching the rest of
 * the repo's root tooling so CI needs no install step.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const sourceMd = path.join(repoRoot, "docs/BUSINESS-FLOWS.md");
const outFile = path.join(repoRoot, "docs/flow-viz/flow-viz-data.js");
const vendorDir = path.join(repoRoot, "docs/flow-viz/vendor");
const vendorFile = path.join(vendorDir, "mermaid.min.js");

const MERMAID_VERSION = "11.4.1";
const CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;

/**
 * Canonical service names shared across diagrams.
 * CONTRACT: any diagram node that references a shared service MUST use one of
 * these names as its label, either exactly or as a prefix ("SaveWatcher.tick").
 * The script matches labels against this registry (longest-prefix) to derive
 * "service participates in flow X" and "service→service edge appears in flow X".
 * If you change this list, update every diagram and regenerate the data file in
 * the same PR.
 */
const SVC_NAMES = [
  "SaveWatcher",
  "TrackingService",
  "XpTracker",
  "LiveMemoryService",
  "LiveMemoryWorker",
  "InventoryService",
  "InventoryWorker",
  "SessionStateService",
  "BoxTimerService",
  "StageRunService",
  "ChestService",
  "AutoClassifyService",
  "NotificationService",
  "UpdateService",
  "LookupService",
  "LookupPriceService",
  "LookupPricePollingService",
  "SteamMarketProvider",
  "CatalogRefreshService",
  "PetService",
  "DpsTracker",
  "ChestDropTracker",
  "BoxOpenTracker",
];
// Longest-first so "LookupPricePollingService.x" matches the polling service,
// not the shorter "LookupPriceService" prefix.
const SVC_SORTED = [...SVC_NAMES].sort((a, b) => b.length - a.length);

/** GitHub-flavoured anchor slug (lowercase, drop punctuation, spaces → dashes). */
function githubAnchor(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .replace(/\s+/g, "-");
}

function parseChapters(md) {
  const chapters = [];
  let cur = null;
  for (const line of md.split("\n")) {
    const m = line.match(/^##\s+(\d+)\.\s*(.*)$/);
    if (m) {
      cur = { number: Number(m[1]), title: m[2].trim(), anchor: githubAnchor(m[2].trim()), lines: [] };
      chapters.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return chapters;
}

function extractMermaidBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (/^```mermaid\s*$/.test(lines[i])) {
      i++;
      const buf = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      blocks.push({ source: buf.join("\n") });
    }
    i++;
  }
  return blocks;
}

function latestSubsection(lines, blockLineIdx) {
  // Not used directly: block index is relative; we instead scan the chapter
  // line list forward to find the nearest preceding "### " heading.
  for (let i = blockLineIdx; i >= 0; i--) {
    const m = lines[i].match(/^###\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return null;
}

function ensureNode(nodes, id) {
  if (!nodes.has(id)) nodes.set(id, id);
}

/** Shape portion of a mermaid node (all supported shapes); capture groups are positional. */
const SHAPE = String.raw`(?:\[\(([^\]]+?)\)\]|\[\[([^\]]+?)\]\]|\[([^\]]+?)\]|\{([^}]+?)\}|\(\(([^)]+?)\)\)|\(([^)]+?)\))`;
const SHAPE_LABEL = (m, base) => m[base] ?? m[base + 1] ?? m[base + 2] ?? m[base + 3] ?? m[base + 4] ?? m[base + 5];
const NODE_RE = new RegExp(`^([A-Za-z_][\\w-]*)(?:${SHAPE})?\\s*$`);
const EDGE_RE = new RegExp(`^([A-Za-z_][\\w-]*)(?:${SHAPE})?\\s+(\\S+)\\s+([A-Za-z_][\\w-]*)(?:${SHAPE})?\\s*$`);

/** Parse one mermaid flowchart block into structured nodes/edges/subgraphs. */
function parseDiagram(source) {
  const nodes = new Map(); // id -> label
  const edges = [];
  const subgraphs = [];
  const warnings = [];

  for (const raw of source.split("\n")) {
    let line = raw.trim();
    if (!line || line.startsWith("%%")) continue;

    if (/^(flowchart|graph|direction|classDef|class |style |linkStyle |click )/.test(line)) continue;

    if (/^end\s*$/.test(line)) continue;

    if (/^subgraph\b/.test(line)) {
      let sg = null;
      let m = line.match(/^subgraph\s+([A-Za-z_][\w-]*)\s*\["([^"]*)"\]\s*$/);
      if (!m) m = line.match(/^subgraph\s+([A-Za-z_][\w-]*)\s*\[([^\]]*)\]\s*$/);
      if (!m) m = line.match(/^subgraph\s+([A-Za-z_][\w-]*)\s*([^[]+)$/);
      if (!m) m = line.match(/^subgraph\s+(.+)$/);
      if (m) sg = { id: m[1] && /^[A-Za-z_][\w-]*$/.test(m[1]) ? m[1] : null, title: (m[2] ?? m[1] ?? "").trim().replace(/^\["?|"?\]$/g, "") };
      if (sg) subgraphs.push(sg);
      continue;
    }

    // Normalize edge labels ("A -- 是 --> B" → "A --> B"; "A -->|是| B" → "A --> B").
    line = line.replace(/\|.*?\|/g, "").replace(/\s*--\s+(.+?)\s+-->/g, " --> ").trim();

    // Edge — "A[shape] <link> B[shape]".
    const edge = line.match(EDGE_RE);
    if (edge && /[-=~.>o]/.test(edge[8])) {
      const from = edge[1];
      const fromLabel = SHAPE_LABEL(edge, 2);
      const to = edge[9];
      const toLabel = SHAPE_LABEL(edge, 10);
      edges.push({ from, to });
      nodes.set(from, fromLabel?.trim() || nodes.get(from) || from);
      nodes.set(to, toLabel?.trim() || nodes.get(to) || to);
      continue;
    }

    // Node definition (any supported shape) on its own line.
    const node = line.match(NODE_RE);
    if (node) {
      nodes.set(node[1], SHAPE_LABEL(node, 2)?.trim() || node[1]);
      continue;
    }

    warnings.push(`unparsed line: ${line}`);
  }

  return { nodes, edges, subgraphs, warnings };
}

/** Longest-prefix match of a node label against the service registry. */
function matchService(label) {
  for (const name of SVC_SORTED) {
    if (label === name || label.startsWith(name + ".") || label.startsWith(name + " ")) return name;
  }
  return null;
}

function buildData(md, nowIso) {
  const chapters = parseChapters(md);
  const flows = [];
  const serviceFlows = new Map(); // service -> Set<number>
  const serviceEdges = new Map(); // "from|to" -> Set<number>
  const allWarnings = [];

  for (const ch of chapters) {
    const blocks = extractMermaidBlocks(ch.lines);
    // Compute subsection (nearest preceding ### heading) per block.
    const blockIdx = [];
    let idx = 0;
    for (const line of ch.lines) {
      if (/^```mermaid\s*$/.test(line)) blockIdx.push(idx);
      idx++;
    }

    const diagrams = blocks.map((block, i) => {
      const parsed = parseDiagram(block.source);
      allWarnings.push(...parsed.warnings.map((w) => `[ch${ch.number}] ${w}`));
      const subsection = latestSubsection(ch.lines, blockIdx[i]);
      const nodes = [...parsed.nodes.entries()]
        .map(([id, label]) => ({ id, label }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const edges = [...parsed.edges]
        .map((e) => ({ from: e.from, to: e.to }))
        .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

      // Service participation + cross-flow edges.
      for (const [id, label] of parsed.nodes) {
        const svc = matchService(label);
        if (svc) {
          if (!serviceFlows.has(svc)) serviceFlows.set(svc, new Set());
          serviceFlows.get(svc).add(ch.number);
        }
      }
      for (const e of parsed.edges) {
        const a = matchService(parsed.nodes.get(e.from) ?? e.from);
        const b = matchService(parsed.nodes.get(e.to) ?? e.to);
        if (a && b && a !== b) {
          const key = `${a}|${b}`;
          if (!serviceEdges.has(key)) serviceEdges.set(key, new Set());
          serviceEdges.get(key).add(ch.number);
        }
      }

      return {
        label: subsection || ch.title,
        subsection: subsection || null,
        mermaid: block.source,
        nodes,
        edges,
        subgraphs: parsed.subgraphs.map((s) => ({ id: s.id, title: s.title })),
      };
    });

    flows.push({ number: ch.number, title: ch.title, anchor: ch.anchor, diagrams });
  }

  const services = [...serviceFlows.entries()]
    .map(([id, flowsSet]) => ({ id, flows: [...flowsSet].sort((a, b) => a - b) }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const globalMermaid = buildGlobalMermaid(serviceFlows, serviceEdges);

  // Structural self-checks.
  const problems = [];
  for (const f of flows) {
    if (f.number <= 18 && f.diagrams.length === 0) {
      allWarnings.push(`[ch${f.number}] "${f.title}" has no mermaid diagram yet (0-18 should each have one)`);
    }
    for (const d of f.diagrams) {
      if (d.nodes.length < 2) problems.push(`[ch${f.number}] diagram "${d.label}" has < 2 nodes`);
      for (const n of d.nodes) {
        if (/[\u4e00-\u9fff]/.test(n.id)) problems.push(`[ch${f.number}] node id "${n.id}" contains CJK`);
      }
    }
  }

  return { data: { sourceFile: "docs/BUSINESS-FLOWS.md", generatedAt: nowIso, flows, services, globalMermaid }, warnings: allWarnings, problems };
}

function buildGlobalMermaid(serviceFlows, serviceEdges) {
  const nodeIds = [...serviceFlows.keys()].sort();
  const lines = ["%% TBH flow diagram — global service graph (generated)", "flowchart LR"];
  for (const id of nodeIds) lines.push(`  ${id}[${id}]`);
  const keys = [...serviceEdges.keys()].sort();
  for (const key of keys) {
    const [from, to] = key.split("|");
    lines.push(`  ${from} --> ${to}`);
  }
  if (nodeIds.length) lines.push(`  class ${nodeIds.join(",")} svc`);
  return lines.join("\n");
}

function serialize(data) {
  const header = [
    "// Generated by docs/agent/scripts/build-flow-viz.mjs from docs/BUSINESS-FLOWS.md.",
    "// DO NOT EDIT BY HAND. Regenerate from repo root: node docs/agent/scripts/build-flow-viz.mjs",
    "window.TBH_FLOW_VIZ = ",
  ];
  return header.join("\n") + JSON.stringify(data, null, 2) + ";\n";
}

const normalizeForCheck = (text) => text.replace(/"generatedAt"\s*:\s*"[^"]*"/, '"generatedAt": "<check>"');

async function fetchVendor() {
  const res = await fetch(CDN_URL);
  if (!res.ok) throw new Error(`mermaid download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(vendorFile, buf);
  console.log(`wrote ${path.relative(repoRoot, vendorFile)} (${buf.length} bytes, mermaid@${MERMAID_VERSION})`);
}

const args = process.argv.slice(2);
if (args.includes("--vendor")) {
  await fetchVendor();
}

const md = fs.readFileSync(sourceMd, "utf8");
const { data, warnings, problems } = buildData(md, new Date().toISOString());
const content = serialize(data);

for (const w of warnings) console.warn(`WARN ${w}`);
for (const p of problems) console.error(`ERROR ${p}`);

if (args.includes("--check")) {
  const expected = normalizeForCheck(content);
  const existing = fs.existsSync(outFile) ? normalizeForCheck(fs.readFileSync(outFile, "utf8")) : null;
  if (existing !== expected) {
    console.error(`${path.relative(repoRoot, outFile)} is out of sync with BUSINESS-FLOWS.md. Run: node docs/agent/scripts/build-flow-viz.mjs`);
    process.exit(1);
  }
  if (problems.length) {
    console.error(`${problems.length} structural problem(s) found in diagrams.`);
    process.exit(1);
  }
  console.log("flow-viz data OK (in sync, diagrams parse).");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, content, "utf8");
console.log(`wrote ${path.relative(repoRoot, outFile)} (${flowsCount(data)} flows, ${data.services.length} services)`);

function flowsCount(d) {
  return d.flows.filter((f) => f.diagrams.length > 0).length;
}
