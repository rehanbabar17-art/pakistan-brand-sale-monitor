"use strict";

const DEFAULT_OWNER = "rehanbabar17-art";
const DEFAULT_REPO = "pakistan-brand-sale-monitor";
const STORAGE_KEY = "link-monitor-github-config";

const SOURCES = {
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
  },
  google: {
    configPath: "brands.json",
    statePath: "state/google_search_state.json",
    historyPath: "state/google_search_history.json",
    workflow: "google-sales-monitor.yml",
    statePrefix: "google::",
    label: "Web search",
    readOnly: true
  }
};

const state = {
  config: null,
  connected: false,
  data: {
    price: emptySourceData(),
    link: emptySourceData(),
    google: emptySourceData()
  },
  installPrompt: null
};

const elements = {
  refreshButton: document.getElementById("refresh-button"),
  installButton: document.getElementById("install-button"),
  connectionCard: document.getElementById("connection-card"),
  connectionForm: document.getElementById("connection-form"),
  connectionStatus: document.getElementById("connection-status"),
  ownerInput: document.getElementById("owner"),
  repositoryInput: document.getElementById("repository"),
  branchInput: document.getElementById("branch"),
  tokenInput: document.getElementById("token"),
  monitorForm: document.getElementById("monitor-form"),
  monitorList: document.getElementById("monitor-list"),
  checkPricesButton: document.getElementById("check-prices"),
  checkLinksButton: document.getElementById("check-links"),
  checkSearchButton: document.getElementById("check-search"),
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
    if (value && value.owner && value.repo && value.branch && value.token) return value;
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
  state.config = null;
  state.connected = false;
}

function inferRepository() {
  const segments = location.pathname.split("/").filter(Boolean);
  if (location.hostname.endsWith(".github.io") && segments.length >= 2) {
    return { owner: segments[0], repo: segments[1] };
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
  if (!state.config) throw new Error("Connect to GitHub first");
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${state.config.token}`
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`https://api.github.com${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      if (payload.message) message = payload.message;
    } catch (_) { /* keep status text */ }
    if (response.status === 401) message = "GitHub rejected the token";
    if (response.status === 404) message = "Repository or file was not found";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function apiJson(path, options = {}) {
  const response = await api(path, options);
  return response.status === 204 ? null : response.json();
}

async function fetchJsonFile(path) {
  const query = new URLSearchParams({ ref: state.config.branch, _: Date.now().toString() });
  const response = await api(`/repos/${state.config.owner}/${state.config.repo}/contents/${encodePath(path)}?${query}`);
  const payload = await response.json();
  const value = JSON.parse(decodeBase64Unicode(payload.content || ""));
  return { value, sha: payload.sha };
}

async function writeJsonFile(path, value, message) {
  let sha = null;
  try {
    const existing = await fetchJsonFile(path);
    sha = existing.sha;
    if (JSON.stringify(existing.value) === JSON.stringify(value)) {
      return { unchanged: true, sha };
    }
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  const body = {
    message,
    content: encodeBase64Unicode(`${JSON.stringify(value, null, 2)}\n`),
    branch: state.config.branch
  };
  if (sha) body.sha = sha;
  await api(`/repos/${state.config.owner}/${state.config.repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    body
  });
  return { unchanged: false, sha };
}

async function dispatchWorkflow(workflow) {
  await api(`/repos/${state.config.owner}/${state.config.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
    method: "POST",
    body: { ref: state.config.branch }
  });
}

async function connect(options = {}) {
  const inferred = inferRepository();
  const config = {
    owner: elements.ownerInput.value.trim() || options.owner || inferred.owner,
    repo: elements.repositoryInput.value.trim() || options.repo || inferred.repo,
    branch: elements.branchInput.value.trim() || "main",
    token: elements.tokenInput.value.trim() || (options.useSavedToken ? state.config?.token : "")
  };
  if (!config.owner || !config.repo || !config.token) {
    setConnectionStatus("pending", "Not connected");
    return false;
  }

  state.config = config;
  const user = await apiJson("/user");
  const repository = await apiJson(`/repos/${config.owner}/${config.repo}`);
  config.branch = config.branch === "main" && repository.default_branch ? repository.default_branch : config.branch;
  saveConfig(config);
  state.connected = true;
  setConnectionStatus("connected", `Connected · ${user.login}`);
  fillSettings();
  await refreshAll();
  if (!options.silent) toast("Connected to GitHub");
  return true;
}

function setConnectionStatus(kind, text) {
  elements.connectionStatus.className = `status-pill ${kind}`;
  elements.connectionStatus.textContent = text;
}

function normalizeMonitor(kind, item) {
  const source = SOURCES[kind];
  const name = item.name || new URL(item.url).hostname.replace(/^www\./, "");
  const stateKey = `${source.statePrefix}${name}`;
  const current = state.data[kind].states[stateKey];
  const history = state.data[kind].history.find(event => event.name === name);
  return {
    kind,
    name,
    url: item.url,
    mode: item.mode || "",
    stateKey,
    current,
    lastEvent: history
  };
}

function allMonitors() {
  return [
    ...state.data.price.items.map(item => normalizeMonitor("price", item)),
    ...state.data.link.items.map(item => normalizeMonitor("link", item)),
    ...state.data.google.items.map(item => normalizeMonitor("google", item))
  ];
}

function monitorCurrentValue(monitor) {
  if (!monitor.current) return "Waiting for first check";
  if (monitor.kind === "price") return monitor.current.price || "Unknown price";
  if (monitor.kind === "google") return `${monitor.current?.result_count ?? 0} latest search result(s)`;
  if (monitor.current.summary) return monitor.current.summary;
  if (monitor.current.title) return monitor.current.title;
  return "Saved baseline";
}

function renderMonitors() {
  const monitors = allMonitors();
  if (!monitors.length) {
    elements.monitorList.innerHTML = `<div class="empty">No watches yet.<br>Add a Daraz product or any web page above.</div>`;
    return;
  }

  elements.monitorList.innerHTML = monitors.map((monitor, index) => `
    <article class="monitor-card" data-index="${index}">
      <div>
        <h3 class="monitor-name">${escapeHtml(monitor.name)}</h3>
        <div class="monitor-meta">
          <span class="chip">${SOURCES[monitor.kind].label}</span>
          ${monitor.lastEvent ? `<span class="chip ${escapeHtml(monitor.lastEvent.status)}">${escapeHtml(monitor.lastEvent.status)}</span>` : ""}
        </div>
        <a class="monitor-url" href="${escapeAttribute(monitor.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(monitor.url)}</a>
        <div class="monitor-current">${escapeHtml(monitorCurrentValue(monitor))}</div>
        ${monitor.current?.checked_at ? `<div class="monitor-last">Checked ${formatDate(monitor.current.checked_at)}</div>` : ""}
      </div>
      <div class="monitor-actions">
        <button class="mini-button run-button" data-kind="${monitor.kind}">Run</button>
        <button class="mini-button open-button" data-url="${escapeAttribute(monitor.url)}">Open</button>
        ${monitor.kind === "google" ? "" : `<button class="mini-button delete-button" data-kind="${monitor.kind}" data-url="${escapeAttribute(monitor.url)}">Delete</button>`}
      </div>
    </article>
  `).join("");
}

function renderActivity() {
  const events = [
    ...state.data.price.history.map(event => ({ ...event, source: "price" })),
    ...state.data.link.history.map(event => ({ ...event, source: "link" })),
    ...state.data.google.history.map(event => ({ ...event, source: "google_search" }))
  ].sort((left, right) => String(right.checked_at).localeCompare(String(left.checked_at)));

  elements.activityCount.textContent = events.length ? `${events.length} events` : "";
  if (!events.length) {
    elements.activityList.innerHTML = `<div class="empty">No change history yet. History appears after the first scheduled or manual check.</div>`;
    return;
  }

  elements.activityList.innerHTML = events.slice(0, 200).map(event => {
    let detail;
    if (event.source === "price") {
      detail = event.previous_price ? `Price changed: ${event.previous_price} → ${event.price}` : `Baseline price: ${event.price}`;
    } else {
      detail = Array.isArray(event.changes) && event.changes.length ? event.changes.join(" · ") : event.summary;
    }
    if (event.source === "google_search") detail = event.title ? `${event.title} — ${event.snippet}` : detail;
    return `
      <article class="event-card">
        <div class="event-head">
          <span class="event-name">${escapeHtml(event.name)}</span>
          <span class="event-time">${formatDate(event.checked_at)}</span>
        </div>
        <div class="monitor-meta"><span class="chip ${escapeHtml(event.status)}">${escapeHtml(event.status)}</span><span class="chip">${event.source === "price" ? "Price" : "Page"}</span></div>
        <p class="event-detail">${escapeHtml(detail || "Change detected")}</p>
        ${event.url ? `<a class="event-link" href="${escapeAttribute(event.url)}" target="_blank" rel="noopener noreferrer">Open page</a>` : ""}
      </article>
    `;
  }).join("");
}

function renderAll() {
  renderMonitors();
  renderActivity();
  fillSettings();
}

function fillSettings() {
  if (!state.config) {
    elements.settingsDetails.innerHTML = "<div><dt>Status</dt><dd>Not connected</dd></div>";
    return;
  }
  const rows = [
    ["Owner", state.config.owner],
    ["Repository", state.config.repo],
    ["Branch", state.config.branch],
    ["Token", `••••••••${state.config.token.slice(-4)}`],
    ["Watches", allMonitors().length]
  ];
  elements.settingsDetails.innerHTML = rows.map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("");
}

async function loadSource(kind) {
  const source = SOURCES[kind];
  const optionalFile = async path => {
    try {
      return await fetchJsonFile(path);
    } catch (error) {
      if (error.status === 404) return { value: null };
      throw error;
    }
  };
  const statePromise = optionalFile(source.statePath);
  const historyPromise = optionalFile(source.historyPath);
  const [configResult, stateResult, historyResult] = await Promise.all([fetchJsonFile(source.configPath), statePromise, historyPromise]);
  state.data[kind] = {
    items: Array.isArray(configResult.value.links)
      ? configResult.value.links
      : (Array.isArray(configResult.value.brands)
        ? configResult.value.brands.map(brand => ({ name: brand.name, url: brand.url }))
        : []),
    sha: configResult.sha,
    states: stateResult.value || {},
    history: Array.isArray(historyResult.value) ? historyResult.value : []
  };
}

async function refreshAll() {
  if (!state.connected) return;
  setLoading(true);
  try {
    await Promise.all([loadSource("price"), loadSource("link"), loadSource("google")]);
    renderAll();
  } finally {
    setLoading(false);
  }
}

async function addMonitor(formData) {
  const kind = formData.get("type") === "content" ? "link" : "price";
  const item = {
    name: formData.get("name").trim(),
    url: formData.get("url").trim()
  };
  if (!/^https?:\/\//i.test(item.url)) throw new Error("URL must start with http:// or https://");
  if (state.data[kind].items.some(existing => existing.url.toLowerCase() === item.url.toLowerCase())) {
    throw new Error("This URL is already being monitored");
  }
  if (kind === "price") item.mode = "price";

  const path = SOURCES[kind].configPath;
  const nextItems = [...state.data[kind].items, item];
  const result = await writeJsonFile(
    path,
    { links: nextItems },
    `Add ${kind} monitor: ${item.name}`
  );
  state.data[kind].items = nextItems;
  state.data[kind].sha = result.sha;
  renderMonitors();
  dispatchWorkflow(SOURCES[kind].workflow).catch(error => toast(error.message, "error"));
  return `${SOURCES[kind].label} monitor added`;
}

async function deleteMonitor(kind, url) {
  const items = state.data[kind].items.filter(item => item.url.toLowerCase() !== url.toLowerCase());
  if (items.length === state.data[kind].items.length) return;
  const result = await writeJsonFile(
    SOURCES[kind].configPath,
    { links: items },
    `Remove ${kind} monitor`
  );
  state.data[kind].items = items;
  state.data[kind].sha = result.sha;
  renderMonitors();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
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
  [elements.refreshButton, elements.checkPricesButton, elements.checkLinksButton, elements.checkSearchButton].forEach(button => button.disabled = loading);
  elements.refreshButton.textContent = loading ? "…" : "↻";
}

elements.connectionForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await connect();
  } catch (error) {
    setConnectionStatus("error", "Connection failed");
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

elements.refreshButton.addEventListener("click", () => refreshAll().catch(error => toast(error.message, "error")));
elements.checkPricesButton.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.price.workflow);
    toast("Hourly price checker requested");
  } catch (error) { toast(error.message, "error"); }
});
elements.checkLinksButton.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.link.workflow);
    toast("Shared page checker requested");
  } catch (error) { toast(error.message, "error"); }
});
elements.checkSearchButton.addEventListener("click", async () => {
  try {
    await dispatchWorkflow(SOURCES.google.workflow);
    toast("Google sale search requested");
  } catch (error) { toast(error.message, "error"); }
});

elements.monitorForm.addEventListener("submit", async event => {
  event.preventDefault();
  const submitButton = event.target.querySelector("button[type=submit]");
  submitButton.disabled = true;
  try {
    const message = await addMonitor(new FormData(event.target));
    event.target.reset();
    toast(message);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    submitButton.disabled = false;
  }
});

elements.monitorList.addEventListener("click", async event => {
  const runButton = event.target.closest(".run-button");
  const deleteButton = event.target.closest(".delete-button");
  const openButton = event.target.closest(".open-button");
  const card = event.target.closest(".monitor-card");
  if (!card) return;
  const monitor = allMonitors()[Number(card.dataset.index)];
  if (!monitor) return;
  if (openButton) window.open(monitor.url, "_blank", "noopener");
  if (runButton) {
    runButton.disabled = true;
    try {
      await dispatchWorkflow(SOURCES[monitor.kind].workflow);
      toast(`Check requested for ${monitor.name}`);
    } catch (error) { toast(error.message, "error"); }
    finally { runButton.disabled = false; }
  }
  if (deleteButton) {
    if (monitor.kind === "google") return;
    deleteButton.disabled = true;
    try {
      await deleteMonitor(monitor.kind, monitor.url);
      toast("Monitor removed");
    } catch (error) { toast(error.message, "error"); deleteButton.disabled = false; }
  }
});

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(item => item.classList.toggle("active", item === tab));
  document.querySelectorAll(".panel").forEach(panel => panel.classList.toggle("active", panel.id === `${tab.dataset.tab}-panel`));
}));

elements.disconnectButton.addEventListener("click", () => {
  clearConfig();
  state.data = { price: emptySourceData(), link: emptySourceData() };
  elements.tokenInput.value = "";
  renderAll();
  setConnectionStatus("pending", "Not connected");
  toast("Disconnected");
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
  state.config = readConfig();
  elements.ownerInput.value = state.config?.owner || inferred.owner;
  elements.repositoryInput.value = state.config?.repo || inferred.repo;
  elements.branchInput.value = state.config?.branch || "main";
  elements.tokenInput.value = state.config?.token || "";
  renderAll();
  if (state.config) {
    setConnectionStatus("pending", "Connecting…");
    connect({ silent: true, useSavedToken: true }).catch(error => {
      setConnectionStatus("error", "Connection failed");
      toast(error.message, "error");
    });
  }
})();
