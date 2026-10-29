// Redfish Explorer: a lazy containment tree on the left, the selected resource
// on the right with schema annotations. Routing uses the URL hash
// (#/<source>/redfish/v1/...), so the browser's back button walks the history.
"use strict";

const ROOT = "/redfish/v1";
const HIDDEN_KEYS = new Set(["@odata.id", "@odata.type", "@odata.context", "@odata.etag", "@Redfish.Copyright"]);
const STATUS_KEYS = new Set(["Health", "HealthRollup", "State", "Severity"]);

const $ = sel => document.querySelector(sel);
const state = { source: null, path: ROOT, view: "props" };
const cache = new Map();

// Helpers

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

// Drop JSON-pointer fragments (".../Thermal#/Fans/0") and trailing slashes.
function cleanPath(p) {
  return p.split("#")[0].replace(/\/+$/, "") || ROOT;
}

function isRfPath(s) {
  return typeof s === "string" && /^\/redfish\/v1(\/|$|#)/.test(s);
}

function isLink(v) {
  return v && typeof v === "object" && !Array.isArray(v) &&
    typeof v["@odata.id"] === "string" && Object.keys(v).length === 1;
}

function href(path) {
  return `#/${state.source}${cleanPath(path)}`;
}

// Long paths wrap at "/" rather than mid-segment.
function linkTo(path, label) {
  const parts = label ? [label] : path.split(/(?=\/)/).flatMap((p, i) => i ? [el("wbr"), p] : [p]);
  return el("a", { href: href(path), class: "rflink" }, parts);
}

function lastSeg(path) {
  return cleanPath(path).split("/").pop();
}

function healthClass(v) {
  return { OK: "ok", Warning: "warn", Critical: "crit", Enabled: "ok", Disabled: "muted",
           Absent: "muted", StandbyOffline: "muted", UnavailableOffline: "warn" }[v] || "muted";
}

// Error bodies are Redfish-style ({"error": {"message": ...}}) or, from the
// local proxy, {"error": "..."}.
function errorText(json) {
  const e = json && json.error;
  return typeof e === "string" ? e : e && e.message;
}

function worstHealth(json) {
  const s = json && json.Status;
  if (!s) return null;
  const order = ["Critical", "Warning", "OK"];
  for (const h of order) if (s.Health === h || s.HealthRollup === h) return h;
  return null;
}

// Data

function getResource(path) {
  const key = `${state.source}|${cleanPath(path)}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`/rf/${state.source}${cleanPath(path)}`).then(async r => {
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* $metadata is XML */ }
      return { ok: r.ok, status: r.status, json, text };
    }).catch(err => ({ ok: false, status: 0, json: { error: String(err) }, text: "" })));
  }
  return cache.get(key);
}

// Children for the containment tree: collection members and navigation
// properties that point below this resource. Links elsewhere (Links, Actions,
// cross-references) appear in the property view, not as tree children, which
// keeps the tree acyclic.
function treeChildren(path, json) {
  if (!json || typeof json !== "object") return [];
  const base = cleanPath(path);
  const out = new Map();
  const add = (p, label) => {
    const c = cleanPath(p);
    if (c.startsWith(base + "/") && !out.has(c)) out.set(c, label);
  };
  if (Array.isArray(json.Members)) {
    for (const m of json.Members) if (m && m["@odata.id"]) add(m["@odata.id"], lastSeg(m["@odata.id"]));
  }
  for (const [k, v] of Object.entries(json)) {
    if (k === "Links" || k === "Actions" || k === "Oem" || k === "Members") continue;
    if (isLink(v)) add(v["@odata.id"], k);
  }
  return [...out].map(([p, label]) => ({ path: p, label }));
}

// Tree

const treeNodes = new Map(); // path -> {li, kids, caret, loading, open}

function treeNode(path, label) {
  const caret = el("button", { class: "caret", "aria-label": "expand" }, "▸");
  const dot = el("span", { class: "dot" });
  const a = el("a", { href: href(path), class: "tlabel" }, label);
  const kids = el("ul", { class: "kids", hidden: "" });
  const li = el("li", { "data-path": path }, el("div", { class: "trow" }, caret, dot, a), kids);
  const node = { li, kids, caret, dot, loading: null, open: false };
  caret.addEventListener("click", () => toggle(path));
  treeNodes.set(path, node);
  // Fetch each node as soon as it's added, for its health dot and to find out
  // whether it's a leaf.
  getResource(path).then(r => decorate(path, r));
  return li;
}

function decorate(path, r) {
  const node = treeNodes.get(path);
  if (!node) return;
  const h = worstHealth(r.json);
  if (h) { node.dot.className = `dot ${healthClass(h)}`; node.dot.title = `Health: ${h}`; }
  if (!r.ok) { node.dot.className = "dot crit"; node.dot.title = `HTTP ${r.status}`; }
  if (r.ok && treeChildren(path, r.json).length === 0) node.caret.classList.add("leaf");
}

async function expand(path) {
  const node = treeNodes.get(path);
  if (!node) return;
  // Share one load between concurrent callers (buildTree and reveal both
  // expand the root) so children are appended only once.
  if (!node.loading) {
    node.loading = getResource(path).then(r => {
      for (const c of treeChildren(path, r.json)) node.kids.append(treeNode(c.path, c.label));
    });
  }
  await node.loading;
  node.open = true;
  node.kids.hidden = false;
  node.caret.textContent = "▾";
}

function collapse(path) {
  const node = treeNodes.get(path);
  if (!node) return;
  node.open = false;
  node.kids.hidden = true;
  node.caret.textContent = "▸";
}

function toggle(path) {
  const node = treeNodes.get(path);
  if (node && node.open) collapse(path); else expand(path);
}

function buildTree() {
  treeNodes.clear();
  const nav = $("#tree");
  nav.replaceChildren(el("ul", { class: "troot" }, treeNode(ROOT, "redfish/v1")));
  expand(ROOT);
}

// Open every ancestor of path so the selection is visible in the tree.
async function reveal(path) {
  const segs = cleanPath(path).split("/").slice(3); // after "", "redfish", "v1"
  let cur = ROOT;
  await expand(cur);
  for (const s of segs.slice(0, -1)) {
    cur = `${cur}/${s}`;
    if (!treeNodes.has(cur)) break;
    await expand(cur);
  }
  document.querySelectorAll(".trow.sel").forEach(e => e.classList.remove("sel"));
  const node = treeNodes.get(cleanPath(path));
  if (node) {
    const row = node.li.querySelector(".trow");
    row.classList.add("sel");
    row.scrollIntoView({ block: "nearest" });
  }
}

// Property view

function pill(v) {
  return el("span", { class: `pill ${healthClass(v)}` }, v);
}

function docCell(ann, extra) {
  if (!ann && !extra) return el("td", { class: "doc" });
  const bits = [];
  if (ann && ann.description) bits.push(el("div", {}, ann.description));
  if (extra) bits.push(el("div", { class: "enum" }, extra));
  const tags = [];
  if (ann && ann.units) tags.push(`units: ${ann.units}`);
  if (ann && ann.excerpt) tags.push(`excerpt of ${ann.excerpt}`);
  if (ann && ann.versionAdded) tags.push(`added ${ann.versionAdded}`);
  if (ann && ann.deprecated) tags.push(`deprecated: ${ann.deprecated}`);
  if (tags.length) bits.push(el("div", { class: "tags" }, tags.join(" · ")));
  return el("td", { class: "doc", title: (ann && ann.longDescription) || "" }, bits);
}

function primitive(key, v, ann, itemSchema) {
  if (v === null) return el("span", { class: "null" }, "null");
  if (typeof v === "string") {
    if (isRfPath(v)) return linkTo(v);
    if (STATUS_KEYS.has(key)) return pill(v);
    return el("span", { class: "str" }, v);
  }
  const unit = ann && ann.units ? el("span", { class: "unit" }, ` ${ann.units}`) : null;
  return el("span", { class: typeof v }, String(v), unit);
}

// Inline values: primitives, links, and arrays of either. Objects and
// arrays of objects are containers and get child rows instead.
function valueCell(key, v, ann) {
  if (isLink(v)) return linkTo(v["@odata.id"]);
  if (Array.isArray(v)) {
    if (v.length === 0) return el("span", { class: "null" }, "[ ]");
    if (v.every(isLink)) {
      return el("ul", { class: "links" }, v.map(x => el("li", {}, linkTo(x["@odata.id"]))));
    }
    const items = ann && ann.target && ann.target.items;
    return el("div", {}, v.map(x => el("div", {},
      primitive(key, x, ann),
      Schema.enumMeaning(items, x) ? el("span", { class: "enum inline" }, ` (${Schema.enumMeaning(items, x)})`) : null)));
  }
  if (v && typeof v === "object") return el("span", { class: "null" }, "{ }");
  return primitive(key, v, ann);
}

function isContainer(v) {
  if (Array.isArray(v)) return v.some(x => x && typeof x === "object" && !isLink(x));
  return !!v && typeof v === "object" && !isLink(v) && Object.keys(v).length > 0;
}

// The property view is one flat table. Nested objects and array items are
// indented rows under a collapsible parent, so every description lines up in
// a single doc column. Each entry is {tr, kids, open}.
function propEntry(depth, label, attrs, val, doc, kids, open = depth < 2, jq = null) {
  const e = { tr: null, kids, open };
  const th = el("th", attrs);
  if (kids) {
    const caret = el("button", { class: "caret", "aria-expanded": String(e.open) }, e.open ? "▾" : "▸");
    caret.addEventListener("click", () => {
      e.open = !e.open;
      caret.textContent = e.open ? "▾" : "▸";
      caret.setAttribute("aria-expanded", String(e.open));
      showRows(e.kids, e.open);
      markGroupEnds(e.tr.parentNode);
    });
    th.append(caret);
  } else {
    th.append(el("span", { class: "caret leaf" }));
  }
  // Clicking a name makes its jq path the curl panel's filter.
  th.append(jq ? el("span", { class: "pname", onclick: () => setJq(jq, th) }, label) : label);
  e.tr = el("tr", { class: depth === 0 ? "group" : "", style: `--depth: ${depth}` },
    th, el("td", { class: "val" }, val), doc);
  return e;
}

function showRows(entries, visible) {
  for (const e of entries) {
    e.tr.hidden = !visible;
    if (e.kids) showRows(e.kids, visible && e.open);
  }
}

// The last visible row of each top-level property gets the group's bottom
// padding; which row that is changes as groups collapse.
function markGroupEnds(tbody) {
  let prev = null;
  for (const tr of tbody.rows) {
    if (tr.hidden) continue;
    if (prev) prev.classList.toggle("end", tr.classList.contains("group"));
    prev = tr;
  }
  if (prev) prev.classList.add("end");
}

function flatRows(entries) {
  return entries.flatMap(e => [e.tr, ...(e.kids ? flatRows(e.kids) : [])]);
}

async function propEntries(obj, schemaNode, depth, jqBase = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (depth === 0 && HIDDEN_KEYS.has(k)) continue;
    const jq = jqKey(jqBase, k);
    const ann = await Schema.property(schemaNode, k);
    const meaning = typeof v === "string" ? Schema.enumMeaning(ann && ann.target, v) : "";
    const attrs = {
      class: ann ? null : "noschema",
      title: (ann && ann.longDescription) || (ann ? null : "Not in schema (OEM, annotation, or unknown)"),
    };
    let kids = null, val;
    if (isContainer(v) && Array.isArray(v)) {
      const items = ann && ann.target && ann.target.items;
      kids = [];
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x && typeof x === "object" && !isLink(x)) {
          kids.push(propEntry(depth + 1, `[${i}]`, {},
            x.Name ? el("span", { class: "summary" }, x.Name) : "",
            el("td", { class: "doc" }, ""), await propEntries(x, items, depth + 2, `${jq}[${i}]`), depth < 2,
            `${jq}[${i}]`));
        } else {
          kids.push(propEntry(depth + 1, `[${i}]`, {}, valueCell(k, x, ann), el("td", { class: "doc" }, ""), null,
            undefined, `${jq}[${i}]`));
        }
      }
      val = el("span", { class: "summary" }, `${v.length} item${v.length === 1 ? "" : "s"}`);
    } else if (isContainer(v)) {
      kids = await propEntries(v, ann && ann.target, depth + 1, jq);
      val = null;
    } else {
      val = valueCell(k, v, ann);
    }
    out.push(propEntry(depth, k, attrs, val, docCell(ann, meaning), kids, undefined, jq));
  }
  return out;
}

async function propTable(obj, schemaNode) {
  const entries = await propEntries(obj, schemaNode, 0);
  showRows(entries, true);
  const tbody = el("tbody", {}, flatRows(entries));
  markGroupEnds(tbody);
  return el("table", { class: "props" }, tbody);
}

// Curl panel: the request for the current resource, sent to this site or to
// a real BMC. Target, host and -k are remembered per browser; query options
// carry across navigation; the jq filter resets with each resource.

const PREFS_KEY = "redfish-explorer.curl";
const curl = Object.assign(
  { target: "site", host: "", insecure: true, jq: true, open: false,
    select: "", expand: "", levels: "", filter: "", top: "", skip: "" },
  loadPrefs());
let jqPath = "";
let curlRefresh = () => {};

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

function savePrefs() {
  const { target, host, insecure, jq, open } = curl;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ target, host, insecure, jq, open })); } catch { /* private mode */ }
}

function shq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function jqKey(base, k) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `${base}.${k}` : `${base}.${JSON.stringify(k)}`;
}

function setJq(path, th) {
  jqPath = path;
  document.querySelectorAll(".props th.jqsel").forEach(e => e.classList.remove("jqsel"));
  th.classList.add("jqsel");
  curlRefresh();
}

// Encode only what would break the URL; keep $select=Status,Name readable.
function queryString() {
  const enc = v => v.trim().replace(/[%&#+\s]/g, c => encodeURIComponent(c));
  const q = [];
  if (curl.select.trim()) q.push(`$select=${enc(curl.select)}`);
  if (curl.expand) q.push(`$expand=${curl.expand}${curl.levels ? `($levels=${curl.levels})` : ""}`);
  if (curl.filter.trim()) q.push(`$filter=${enc(curl.filter)}`);
  if (curl.top) q.push(`$top=${curl.top}`);
  if (curl.skip) q.push(`$skip=${curl.skip}`);
  return q.length ? `?${q.join("&")}` : "";
}

function curlCommand(path, isJson) {
  const rf = cleanPath(path) + queryString();
  let parts;
  if (curl.target === "bmc") {
    const host = curl.host.trim().replace(/\/+$/, "") || "<bmc-address>";
    const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
    parts = ["curl -s", curl.insecure ? "-k" : null, `-u "$RF_USER:$RF_PASS"`, shq(base + rf)];
  } else {
    parts = ["curl -s", shq(`${location.origin}/rf/${state.source}${rf}`)];
  }
  if (isJson && curl.jq) parts.push("|", "jq", shq(jqPath || "."));
  return parts.filter(Boolean).join(" ");
}

function curlPanel(path, isJson) {
  const cmd = el("pre", {});
  const copy = el("button", { type: "button" }, "Copy");
  copy.addEventListener("click", () => {
    const done = () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); };
    if (navigator.clipboard) navigator.clipboard.writeText(cmd.textContent).then(done, () => selectText(cmd));
    else selectText(cmd);
  });

  const field = (key, label, attrs = {}) => {
    const input = el("input", { value: curl[key], spellcheck: "false", ...attrs });
    input.addEventListener("input", () => { curl[key] = input.value; savePrefs(); curlRefresh(); });
    return el("label", {}, label, input);
  };
  const check = (key, label) => {
    const input = el("input", { type: "checkbox", checked: curl[key] || null });
    input.addEventListener("change", () => { curl[key] = input.checked; savePrefs(); curlRefresh(); });
    return el("label", {}, input, label);
  };
  const choose = (key, label, options) => {
    const sel = el("select", {}, options.map(([v, t]) => el("option", { value: v, selected: curl[key] === v || null }, t)));
    sel.addEventListener("change", () => { curl[key] = sel.value; savePrefs(); curlRefresh(); });
    return el("label", {}, label, sel);
  };

  const num = { type: "number", min: "0", inputmode: "numeric" };
  const host = field("host", "Host", { placeholder: "10.0.0.5" });
  const insecure = check("insecure", "-k (self-signed cert)");
  const levels = field("levels", "$levels", { ...num, min: "1" });
  const note = el("p", { class: "note" },
    "This site serves the mockups as static files, so it ignores query parameters. A real BMC applies them.");
  const creds = el("p", { class: "hint" },
    "Credentials come from $RF_USER and $RF_PASS in your shell, so they stay out of your history.");

  const details = el("details", { open: curl.open || null },
    el("summary", {}, "Build the request"),
    el("div", { class: "curl-opts" },
      choose("target", "Send to", [["site", "This site (mock)"], ["bmc", "A real BMC"]]),
      host, insecure),
    el("div", { class: "curl-opts" },
      field("select", "$select", { placeholder: "Status,Name" }),
      choose("expand", "$expand", [["", "none"], [".", ". (subordinate)"], ["~", "~ (links)"], ["*", "* (all)"]]),
      levels,
      field("filter", "$filter", { placeholder: "Status/Health eq 'OK'" }),
      field("top", "$top", num),
      field("skip", "$skip", num),
      isJson ? check("jq", "pipe to jq") : null),
    isJson ? el("p", { class: "hint" }, "Click a property name to set the jq filter.") : null,
    creds, note);
  details.addEventListener("toggle", () => { curl.open = details.open; savePrefs(); });

  curlRefresh = () => {
    cmd.textContent = curlCommand(path, isJson);
    const bmc = curl.target === "bmc";
    host.hidden = insecure.hidden = creds.hidden = !bmc;
    levels.querySelector("input").disabled = !curl.expand;
    // The "ignores query parameters" note is only true for mockups. A BMC applies
    // them, and so does a live source, since the local proxy forwards the query.
    note.hidden = bmc || state.source === "live" || !queryString();
  };
  curlRefresh();
  return el("section", { class: "curl", "aria-label": "curl command" },
    el("div", { class: "curl-cmd" }, cmd, copy), details);
}

function selectText(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(range);
}

// Raw JSON with clickable links

function rawJson(v, indent = "") {
  const pad = indent + "  ";
  if (v === null) return el("span", { class: "null" }, "null");
  if (typeof v === "string") {
    const s = JSON.stringify(v);
    return isRfPath(v) ? el("a", { href: href(v), class: "rflink str" }, s) : el("span", { class: "str" }, s);
  }
  if (typeof v !== "object") return el("span", { class: typeof v }, String(v));
  const arr = Array.isArray(v);
  const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
  if (!entries.length) return arr ? "[]" : "{}";
  const out = [arr ? "[\n" : "{\n"];
  entries.forEach(([k, x], i) => {
    out.push(pad);
    if (!arr) out.push(el("span", { class: "key" }, JSON.stringify(k)), ": ");
    out.push(rawJson(x, pad), i < entries.length - 1 ? ",\n" : "\n");
  });
  out.push(indent, arr ? "]" : "}");
  return el("span", {}, out);
}

// Page

function breadcrumbs(path) {
  const segs = cleanPath(path).split("/").filter(Boolean);
  const crumbs = [];
  let cur = "";
  segs.forEach((s, i) => {
    cur += `/${s}`;
    if (i < 2) { if (i === 1) crumbs.push(linkTo(cur, "/redfish/v1")); return; }
    crumbs.push(el("span", { class: "sep" }, "/"), linkTo(cur, s));
  });
  return el("div", { class: "crumbs" }, crumbs);
}

async function render() {
  const main = $("#main");
  const path = state.path;
  main.replaceChildren(el("div", { class: "loading" }, "Loading…"));
  const r = await getResource(path);
  if (path !== state.path) return; // navigated away meanwhile

  const head = [breadcrumbs(path)];
  if (!r.ok) {
    head.push(el("div", { class: "error" }, `HTTP ${r.status}: ${errorText(r.json) || r.text.slice(0, 300)}`));
    main.replaceChildren(...head, curlPanel(path, !!r.json));
    return;
  }
  if (!r.json) { // $metadata and friends
    main.replaceChildren(...head, curlPanel(path, false), el("pre", { class: "raw" }, r.text));
    return;
  }

  const j = r.json;
  const schema = await Schema.forResource(j);
  const status = j.Status || {};
  head.push(el("h1", {}, j.Name || lastSeg(path),
    ["Health", "HealthRollup", "State"].filter(k => status[k]).map(k =>
      el("span", { class: "hstat", title: k }, el("small", {}, k === "HealthRollup" ? "rollup " : ""), pill(status[k])))));
  const t = Schema.parseType(j["@odata.type"]);
  head.push(el("div", { class: "meta" },
    el("code", {}, j["@odata.type"] || "(no @odata.type)"),
    t && !schema ? el("span", { class: "warn-text" }, ` schema ${t.file} not found`) : null));
  if (schema && schema.node.description) {
    head.push(el("p", { class: "typedoc", title: schema.node.longDescription || "" }, schema.node.description));
  }

  // A resource should live where its @odata.id says it does. This check is how
  // I found the copy-paste errors in the DMTF mockups (see the README).
  const declared = j["@odata.id"] && cleanPath(j["@odata.id"]);
  if (declared && declared !== cleanPath(path)) {
    head.push(el("div", { class: "warning" },
      "@odata.id mismatch: served at ", el("code", {}, cleanPath(path)), " but declares ",
      linkTo(declared), "."));
  }

  const tabs = el("div", { class: "tabs" },
    ["props", "raw"].map(v => el("button", {
      class: state.view === v ? "on" : "",
      onclick: () => { state.view = v; render(); },
    }, v === "props" ? "Properties" : "Raw JSON")));

  const body = state.view === "raw"
    ? el("pre", { class: "raw" }, rawJson(j))
    : await propTable(j, schema);
  if (path !== state.path) return;
  main.replaceChildren(...head, curlPanel(path, true), tabs, body);
  main.scrollTop = 0;
  window.scrollTo(0, 0); // on phones the page scrolls, not main
}

// On narrow screens the tree is a drawer opened from the header.
function setDrawer(open) {
  document.body.classList.toggle("drawer-open", open);
  $("#tree-toggle").setAttribute("aria-expanded", String(open));
  const sel = open && document.querySelector(".trow.sel");
  if (sel) sel.scrollIntoView({ block: "center" });
}

// Routing

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  const i = h.indexOf("/");
  if (!h) return null;
  return i < 0 ? { source: h, path: ROOT } : { source: h.slice(0, i), path: cleanPath(h.slice(i)) };
}

async function onRoute() {
  const r = parseHash();
  if (!r) { location.replace(`#/${state.source}${ROOT}`); return; }
  const sourceChanged = r.source !== state.source;
  state.source = r.source;
  if (sourceChanged || r.path !== state.path) jqPath = "";
  state.path = r.path;
  $("#source").value = r.source;
  $("#goto-path").value = r.path;
  if (sourceChanged || !treeNodes.size) buildTree();
  render();
  reveal(r.path);
}

async function init() {
  const sources = await fetch("/api/sources").then(r => r.json());
  const sel = $("#source");
  for (const s of sources) sel.append(el("option", { value: s.id, title: s.description }, `${s.title} (${s.id})`));
  sel.addEventListener("change", () => { location.hash = `#/${sel.value}${ROOT}`; });
  $("#goto").addEventListener("submit", e => {
    e.preventDefault();
    const p = $("#goto-path").value.trim();
    if (isRfPath(p)) location.hash = `#/${state.source}${cleanPath(p)}`;
  });
  $("#tree-toggle").addEventListener("click", () =>
    setDrawer(!document.body.classList.contains("drawer-open")));
  $("#scrim").addEventListener("click", () => setDrawer(false));
  $("#tree").addEventListener("click", e => { if (e.target.closest("a")) setDrawer(false); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") setDrawer(false); });
  state.source = sources.length ? sources[0].id : null;
  window.addEventListener("hashchange", onRoute);
  onRoute();
}

init();
