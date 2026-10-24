"use strict";

const DEFAULT_OWNER = "rehanbabar17-art";
const DEFAULT_REPO = "pakistan-brand-sale-monitor";
const STORAGE_KEY = "link-monitor-github-config";

const SOURCES = {
  brand: {
    configPath: "brands.json",
    statePath: "state/sale_state.json",
    historyPath: "state/sent_alerts.json",
    workflow: "sale-monitor.yml",
    statePrefix: "",
    label: "Brand"
  },
  price: {
    configPath: "prices.json",
    statePath: "state/daraz_price_state.json",
    historyPath: "state/daraz_price_history.json",
    workflow: "price-monitor.yml",
    statePrefix: "daraz::",
    label: "Price"
  },
  link: {
    configPath: "links.json",
    statePath: "state/link_state.json",
    historyPath: "state/link_history.json",
    workflow: "shared-link-monitor.yml",
    statePrefix: "link::",
    label: "Page"
  }
};

const state = {
  config: null,
  connected: false,
  searchQuery: "",
  brandFilter: "all",
  data: {
    brand: emptySourceData(),
    price: emptySourceData(),
    link: emptySourceData()
  },
  installPrompt: null
};

const elements = {
  refreshButton: document.getElementById("refresh-button"),
  installButton: document.getElementById("install-button"),
  brandSearch: document.getElementById("brand-search"),
  saleSummaryBadge: document.getElementById("sale-summary-badge"),
  searchFeedback: document.getElementById("search-feedback"),
  brandsList: document.getElementById("brands-list"),
  connectionCard: document.getElementById("connection-card"),
  connectionForm: document.getElementById("connection-form"),
  connectionStatus: document.getElementById("connection-status"),
  ownerInput: document.getElementById("owner"),
  repositoryInput: document.getElementById("repository"),
  branchInput: document.getElementById("branch"),
  tokenInput: document.getElementById("token"),
  monitorForm: document.getElementById("monitor-form"),
  monitorList: document.getElementById("monitor-list"),
  checkSalesButton: document.getElementById("check-sales"),
  checkPricesButton: document.getElementById("check-prices"),
  checkLinksButton: document.getElementById("check-links"),
  activityList: document.getElementById("activity-list"),
  activityCount: document.getElementById("activity-count"),
  settingsDetails: document.getElementById("settings-details"),
  disconnectButton: document.getElementById("disconnect-button"),
  toast: document.getElementById("toast")
};

function emptySourceData() {
  return { items: [], sha: null, states: {}, history: [] };
}

function readConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value && value.owner && value.repo) return value;
  } catch (error) {
    console.warn("Could not read stored configuration", error);
  }
  return null;
}

function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  state.config = config;
}

function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
  state.config = { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: "main", token: "" };
  state.connected = false;
}

function inferRepository() {
  const segments = location.pathname.split("/").filter(Boolean);
  if (location.hostname.endsWith(".github.io") && segments.length >= 1) {
    return { owner: location.hostname.split(".")[0], repo: segments[0] };
  }
  return { owner: DEFAULT_OWNER, repo: DEFAULT_REPO };
}

function encodePath(path) {
  return path.split("/").map(part => encodeURIComponent(part)).join("/");
}

function decodeBase64Unicode(value) {
  const bytes = Uint8Array.from(atob(value.replace(/\s/g, "")), character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Unicode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach(byte => binary += String.fromCharCode(byte));
  return btoa(binary);
}

async function api(path, options = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (state.config?.token) {
    headers.Authorization = `Bearer ${state.config.token}`;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers,
    body: options.body && typeof options.body !== "string" ? JSON.stringify(options.body) : options.body
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload.message) message = payload.message;
    } catch (_) { /* keep status text */ }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function fetchJsonFile(path) {
  const cfg = state.config || { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: "main", token: "" };
  try {
    const query = new URLSearchParams({ ref: cfg.branch || "main", _: Date.now().toString() });
    const response = await api(`/repos/${cfg.owner}/${cfg.repo}/contents/${encodePath(path)}?${query}`);
    const payload = await response.json();
    const value = JSON.parse(decodeBase64Unicode(payload.content || ""));
    return { value, sha: payload.sha };
  } catch (err) {
    // Fallback to raw.githubusercontent.com for unauthenticated read
    const rawUrl = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch || "main"}/${path}?_=${Date.now()}`;
    const rawResp = await fetch(rawUrl);
    if (!rawResp.ok) {
      const error = new Error(`Could not load ${path}`);
      error.status = rawResp.status;
      throw error;
    }
    return { value: await rawResp.json(), sha: null };
  }
}

async function writeJsonFile(path, value, message) {
  if (!state.config?.token) throw new Error("Add your GitHub PAT in the GitHub PAT tab first");
  let sha = null;
  try {
    const existing = await fetchJsonFile(path);
    sha = existing.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const body = {
    message,
    content: encodeBase64Unicode(`${JSON.stringify(value, null, 2)}\n`),
    branch: state.config.branch || "main"
  };
  if (sha) body.sha = sha;
  await api(`/repos/${state.config.owner}/${state.config.repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    body
  });
  return { sha };
}

async function dispatchWorkflow(workflow) {
  if (!state.config?.token) throw new Error("Add your GitHub PAT in the GitHub PAT tab to trigger scans");
  await api(`/repos/${state.config.owner}/${state.config.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: { ref: state.config.branch || "main" }
  });
}

function extractMaxDiscount(discounts = [], summary = "") {
  let max = 0;
  for (const text of [...discounts, summary]) {
    const matches = String(text).matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g);
    for (const m of matches) {
      const v = parseFloat(m[1]);
      if (v > 0 && v <= 95 && v > max) max = v;
    }
  }
  return max;
}

function extractProductCount(st) {
  if (!st) return 0;
  if (typeof st.sale_product_count === "number" && st.sale_product_count > 0) return st.sale_product_count;
  const m = String(st.summary || "").match(/\((\d+)\s+products\s+on\s+sale\)/i);
  if (m) return parseInt(m[1], 10);
  return typeof st.product_count === "number" ? st.product_count : 0;
}

function getBrandItems() {
  const brandStates = state.data.brand.states || {};
  const configured = state.data.brand.items.length
    ? state.data.brand.items
    : Object.keys(brandStates)
        .filter(k => k !== "tijara_top_deals" && k !== "salesiren_top_deals" && !k.includes("::"))
        .map(name => ({ name, url: brandStates[name]?.url || "" }));

  const tracked = configured
    .filter(b => !b.name.includes("Brand Tijara"))
    .map(b => {
      const st = brandStates[b.name] || {};
      const discounts = Array.isArray(st.discounts) ? st.discounts : [];
      const maxDiscount = extractMaxDiscount(discounts, st.summary || "");
      const productCount = extractProductCount(st);
      const active = Boolean(st.active || productCount > 0 || maxDiscount > 0);
      return {
        name: b.name,
        url: st.url || b.url,
        active,
        maxDiscount,
        discounts,
        productCount,
        summary: st.summary || b.name,
        checked_at: st.checked_at || "",
        isAggregator: false
      };
    });

  const agg = [];
  const tijara = brandStates.tijara_top_deals || {};
  for (const [, val] of Object.entries(tijara)) {
    if (Array.isArray(val) && val.length >= 2) {
      agg.push({
        name: `${val[0]} (via Brand Tijara)`,
        url: "https://www.brandtijara.com/brands-on-sale",
        active: true,
        maxDiscount: Number(val[1]) || 0,
        discounts: [`Up to ${val[1]}% off`],
        productCount: 0,
        summary: `${val[0]} — Up to ${val[1]}% off on Brand Tijara`,
        checked_at: "",
        isAggregator: true
      });
    }
  }
  const siren = brandStates.salesiren_top_deals || {};
  for (const [, val] of Object.entries(siren)) {
    if (Array.isArray(val) && val.length >= 2) {
      agg.push({
        name: `${val[0]} (via Sale Siren)`,
        url: "https://salesiren.pk/",
        active: !val[2],
        maxDiscount: Number(val[1]) || 0,
        discounts: [`Up to ${val[1]}% off`],
        productCount: 0,
        summary: `${val[0]} — Up to ${val[1]}% off on Sale Siren`,
        checked_at: "",
        isAggregator: true
      });
    }
  }

  return { tracked, agg };
}

function renderBrandSales() {
  const { tracked, agg } = getBrandItems();
  const activeCount = tracked.filter(b => b.active).length;
  const totalProducts = tracked.reduce((sum, b) => sum + (b.active ? b.productCount : 0), 0);
  elements.saleSummaryBadge.textContent = `${activeCount}/${tracked.length} On Sale · ${totalProducts.toLocaleString()} Products`;

  const q = state.searchQuery.trim().toLowerCase();
  let pool = state.brandFilter === "aggregators" ? agg : tracked;
  if (q && state.brandFilter !== "aggregators") {
    pool = [...tracked, ...agg];
  }

  const filtered = pool
    .filter(item => {
      if (q) {
        const hay = `${item.name} ${item.summary} ${item.discounts.join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (state.brandFilter === "active") return item.active;
      if (state.brandFilter === "top60") return item.active && item.maxDiscount >= 60;
      if (state.brandFilter === "inactive") return !item.active;
      return true;
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if (b.productCount !== a.productCount) return b.productCount - a.productCount;
      return b.maxDiscount - a.maxDiscount;
    });

  if (q) {
    elements.searchFeedback.classList.remove("hidden");
    const onSaleMatches = filtered.filter(i => i.active).length;
    elements.searchFeedback.innerHTML = filtered.length
      ? `<strong>${filtered.length}</strong> match(es) for "${escapeHtml(state.searchQuery)}" — <strong>${onSaleMatches}</strong> currently on sale.`
      : `No brand matched "${escapeHtml(state.searchQuery)}".`;
  } else {
    elements.searchFeedback.classList.add("hidden");
  }

  if (!filtered.length) {
    elements.brandsList.innerHTML = `<div class="empty">No matching brands found.</div>`;
    return;
  }

  elements.brandsList.innerHTML = filtered.map(brand => `
    <article class="monitor-card">
      <div>
        <h3 class="monitor-name">${escapeHtml(brand.name)}</h3>
        <div class="monitor-meta">
          <span class="chip ${brand.active ? "sale-on" : "sale-off"}">${brand.active ? "SALE ACTIVE" : "NO ACTIVE SALE"}</span>
          ${brand.maxDiscount > 0 ? `<span class="chip changed">Up to ${brand.maxDiscount}% OFF</span>` : ""}
          ${brand.productCount > 0 ? `<span class="chip">${brand.productCount.toLocaleString()} products on sale</span>` : ""}
        </div>
        <div class="monitor-current">${escapeHtml(brand.summary)}</div>
        ${brand.checked_at ? `<div class="monitor-last">Checked ${formatDate(brand.checked_at)}</div>` : ""}
      </div>
      <div class="monitor-actions">
        <a class="mini-button" style="display:flex;align-items:center;justify-content:center;text-decoration:none;" href="${escapeAttribute(brand.url)}" target="_blank" rel="noopener noreferrer">Visit Store</a>
      </div>
    </article>
  `).join("");
}

function normalizeMonitor(kind, item) {
  const source = SOURCES[kind];
  const name = item.name || new URL(item.url).hostname.replace(/^www\./, "");
  const stateKey = `${source.statePrefix}${name}`;
  const current = state.data[kind].states[stateKey];
  return { kind, name, url: item.url, current };
}

function allMonitors() {
  return [
    ...state.data.price.items.map(item => normalizeMonitor("price", item)),
    ...state.data.link.items.map(item => normalizeMonitor("link", item))
  ];
}

function renderMonitors() {
  const monitors = allMonitors();
  if (!monitors.length) {
    elements.monitorList.innerHTML = `<div class="empty">No custom price/page watches yet. All ${state.data.brand.items.length} brands are shown in the Brand Sales tab.</div>`;
    return;
  }
  elements.monitorList.innerHTML = monitors.map((monitor, index) => `
    <article class="monitor-card" data-index="${index}">
      <div>
        <h3 class="monitor-name">${escapeHtml(monitor.name)}</h3>
        <div class="monitor-meta"><span class="chip">${SOURCES[monitor.kind].label}</span></div>
        <a class="monitor-url" href="${escapeAttribute(monitor.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(monitor.url)}</a>
        <div class="monitor-current">${escapeHtml(monitor.current?.summary || monitor.current?.price || "Baseline")}</div>
      </div>
    </article>
  `).join("");
}

function renderActivity() {
  const events = [
    ...state.data.price.history.map(event => ({ ...event, source: "price" })),
    ...state.data.link.history.map(event => ({ ...event, source: "link" }))
  ].sort((left, right) => String(right.checked_at).localeCompare(String(left.checked_at)));

  elements.activityCount.textContent = events.length ? `${events.length} events` : "";
  if (!events.length) {
    elements.activityList.innerHTML = `<div class="empty">All brand sale statuses are live in the Brand Sales tab.</div>`;
    return;
  }
  elements.activityList.innerHTML = events.slice(0, 100).map(event => `
    <article class="event-card">
      <div class="event-head">
        <span class="event-name">${escapeHtml(event.name)}</span>
        <span class="event-time">${formatDate(event.checked_at)}</span>
      </div>
      <p class="event-detail">${escapeHtml(event.summary || event.price || "Updated")}</p>
    </article>
  `).join("");
}

function fillSettings() {
  const cfg = state.config || { owner: DEFAULT_OWNER, repo: DEFAULT_REPO, branch: "main", token: "" };
  const rows = [
    ["Owner", cfg.owner],
    ["Repository", cfg.repo],
    ["Branch", cfg.branch],
    ["Mode", cfg.token ? `Authenticated (••••${cfg.token.slice(-4)})` : "Public Live GitHub Read"],
    ["Tracked Brands", state.data.brand.items.length]
  ];
  elements.settingsDetails.innerHTML = rows.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("");
}

function renderAll() {
  renderBrandSales();
  renderMonitors();
  renderActivity();
  fillSettings();
}

async function loadSource(kind) {
  const source = SOURCES[kind];
  const optionalFile = async path => {
    try {
      return await fetchJsonFile(path);
    } catch (_) {
      return { value: null };
    }
  };
  const [configResult, stateResult, historyResult] = await Promise.all([
    optionalFile(source.configPath),
    optionalFile(source.statePath),
    optionalFile(source.historyPath)
  ]);
  const rawConfig = configResult.value || {};
  state.data[kind] = {
    items: Array.isArray(rawConfig.brands)
      ? rawConfig.brands
      : (Array.isArray(rawConfig.links) ? rawConfig.links : []),
    sha: configResult.sha,
    states: stateResult.value || {},
    history: Array.isArray(historyResult.value) ? historyResult.value : []
  };
}

async function refreshAll() {
  setLoading(true);
  try {
    await Promise.all([loadSource("brand"), loadSource("price"), loadSource("link")]);
    renderAll();
  } finally {
    setLoading(false);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[c]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

let toastTimer;
function toast(message, type = "") {
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function setLoading(loading) {
  elements.refreshButton.disabled = loading;
  elements.refreshButton.textContent = loading ? "…" : "↻";
}

elements.brandSearch.addEventListener("input", event => {
  state.searchQuery = event.target.value;
  renderBrandSales();
});

document.querySelectorAll(".filter-btn").forEach(btn => btn.addEventListener("click", () => {
  document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
  state.brandFilter = btn.dataset.filter;
  renderBrandSales();
}));

elements.connectionForm.addEventListener("submit", async event => {
  event.preventDefault();
  const cfg = {
    owner: elements.ownerInput.value.trim() || DEFAULT_OWNER,
    repo: elements.repositoryInput.value.trim() || DEFAULT_REPO,
    branch: elements.branchInput.value.trim() || "main",
    token: elements.tokenInput.value.trim()
  };
  saveConfig(cfg);
  elements.connectionStatus.className = `status-pill ${cfg.token ? "connected" : "pending"}`;
  elements.connectionStatus.textContent = cfg.token ? "PAT saved" : "Public read mode";
  await refreshAll();
  toast("Synced sale_state.json from GitHub");
});

elements.refreshButton.addEventListener("click", () => refreshAll().then(() => toast("Refreshed sale_state.json")).catch(err => toast(err.message, "error")));

elements.checkSalesButton?.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.brand.workflow);
    toast("Brand sale monitor workflow triggered on GitHub!");
  } catch (error) { toast(error.message, "error"); }
});

elements.checkPricesButton?.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.price.workflow);
    toast("Hourly price checker requested");
  } catch (error) { toast(error.message, "error"); }
});

elements.checkLinksButton?.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.link.workflow);
    toast("Shared page checker requested");
  } catch (error) { toast(error.message, "error"); }
});

elements.monitorForm.addEventListener("submit", async event => {
  event.preventDefault();
  const formData = new FormData(event.target);
  const type = formData.get("type");
  const name = formData.get("name").trim();
  const url = formData.get("url").trim();
  try {
    if (type === "brand") {
      const next = [...state.data.brand.items, { name, url }];
      await writeJsonFile("brands.json", { brands: next }, `Add brand: ${name}`);
    } else {
      const kind = type === "content" ? "link" : "price";
      const next = [...state.data[kind].items, { name, url }];
      await writeJsonFile(SOURCES[kind].configPath, { links: next }, `Add ${kind}: ${name}`);
    }
    event.target.reset();
    await refreshAll();
    toast(`Added ${name}`);
  } catch (error) {
    toast(error.message, "error");
  }
});

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(item => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === `${tab.dataset.tab}-panel`));
}));

elements.disconnectButton.addEventListener("click", () => {
  clearConfig();
  elements.tokenInput.value = "";
  renderAll();
  toast("Token cleared");
});

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  state.installPrompt = event;
  elements.installButton.classList.remove("hidden");
});

elements.installButton.addEventListener("click", async () => {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  elements.installButton.classList.add("hidden");
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(console.warn);
}

(async function initialize() {
  const inferred = inferRepository();
  state.config = readConfig() || { owner: inferred.owner, repo: inferred.repo, branch: "main", token: "" };
  elements.ownerInput.value = state.config.owner;
  elements.repositoryInput.value = state.config.repo;
  elements.branchInput.value = state.config.branch || "main";
  elements.tokenInput.value = state.config.token || "";
  elements.connectionStatus.className = `status-pill ${state.config.token ? "connected" : "pending"}`;
  elements.connectionStatus.textContent = state.config.token ? "Connected via PAT" : "Public read mode";
  await refreshAll();
})();
