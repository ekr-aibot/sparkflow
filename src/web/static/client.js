// Vanilla browser client for sparkflow web mode.
// - Chat pane: xterm.js proxying a server-side PTY over WebSocket.
// - Jobs panel: cards with View / Kill / Restart actions, filterable by repo.
// - Tabs: clicking "View" on a job adds a tab and makes that the main pane.
//   The "Chat" tab is always first and cannot be closed — that's how you get back.

import { Terminal } from "/static/xterm.mjs";
import { FitAddon } from "/static/addon-fit.mjs";

// --------------------------- state ---------------------------

const state = {
  // Tabs shown in the header, left → right. First is always chat.
  tabs: [{ id: "chat", kind: "chat", label: "Chat" }],
  activeTabId: "chat",
  // One view per open job tab.
  jobViews: new Map(),
  // Latest jobs snapshot from SSE (each job has a .repoId field).
  jobs: [],
  // Latest repos snapshot from SSE.
  repos: [],
  // Currently selected repo. Null until the first repo attaches. Each repo is
  // its own independent context — jobs, chat, and tool selections all key off
  // this one value.
  selectedRepoId: localStorage.getItem("sparkflow:selectedRepoId") || null,
  // Whether to show healthy monitor jobs. Persisted to localStorage.
  showMonitors: localStorage.getItem("sparkflow:showMonitors") === "true",
};

const els = {
  tabs: document.getElementById("tabs"),
  main: document.getElementById("main"),
  chat: document.getElementById("chat"),
  list: document.getElementById("job-list"),
  count: document.getElementById("job-count"),
  tooltip: document.getElementById("tooltip"),
  repoSelector: document.getElementById("repo-selector"),
  repoFilter: document.getElementById("repo-filter"),
  prefChat: document.getElementById("pref-chat"),
  prefJobs: document.getElementById("pref-jobs"),
  showMonitors: document.getElementById("pref-show-monitors"),
  monitorToggleLabel: document.getElementById("monitor-toggle-label"),
  monitorToggleCount: document.getElementById("monitor-toggle-count"),
  chatSwitchModal: document.getElementById("chat-switch-modal"),
  chatSwitchCancel: document.getElementById("chat-switch-cancel"),
  chatSwitchConfirm: document.getElementById("chat-switch-confirm"),
};

// --------------------------- step colors ---------------------------
const STEP_PALETTE_SIZE = 5;
const STEP_PALETTE_ANSI = [
  "\x1b[38;5;117m",
  "\x1b[38;5;149m",
  "\x1b[38;5;179m",
  "\x1b[38;5;141m",
  "\x1b[38;5;111m",
];
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

function stepColorIndex(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % STEP_PALETTE_SIZE;
}

// --------------------------- log line transform ---------------------------
function transformLogLine(line, verbose) {
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const ev = JSON.parse(line);
      if (!verbose) return null;
      if (ev.type === "step_status" && typeof ev.step === "string") {
        const ansi = STEP_PALETTE_ANSI[stepColorIndex(ev.step)];
        return `${ANSI_DIM}${ansi}[${ev.step}]${ANSI_RESET}${ANSI_DIM} ${ev.state ?? ""}${ANSI_RESET}`;
      }
      if (ev.type === "workflow_start") return `${ANSI_DIM}[sparkflow] workflow started${ANSI_RESET}`;
      if (ev.type === "workflow_complete") {
        return `${ANSI_DIM}[sparkflow] workflow ${ev.success ? "succeeded" : "failed"}${ANSI_RESET}`;
      }
      if (ev.type === "ask_user") return `${ANSI_DIM}[sparkflow] ask_user: ${ev.question ?? ""}${ANSI_RESET}`;
      return `${ANSI_DIM}${line}${ANSI_RESET}`;
    } catch { /* not JSON — fall through */ }
  }

  const m = line.match(/^\[([^\]:]+)(?::([a-z_]+))?\]\s?(.*)$/);
  if (m) {
    const step = m[1];
    const suffix = m[2];
    const content = m[3];
    if (!verbose) {
      if (step === "sparkflow") return null;
      if (/^(running|succeeded|failed)(\s*\(.+\))?$/.test(content)) return null;
      if (suffix === "tool" || suffix === "tool_result" || suffix === "meta") return null;
      if (content.includes("[tool: ") || content.includes("[tool_result]")) return null;
    }
    const ansi = STEP_PALETTE_ANSI[stepColorIndex(step)];
    const label = `${ansi}[${step}${suffix ? ":" + suffix : ""}]${ANSI_RESET}`;
    return `${label} ${content}`;
  }

  if (!verbose) return null;
  return `${ANSI_DIM}${line}${ANSI_RESET}`;
}

// Floating toast host, injected once.
let toastsEl = document.getElementById("toasts");
if (!toastsEl) {
  toastsEl = document.createElement("div");
  toastsEl.id = "toasts";
  document.body.appendChild(toastsEl);
}

// --------------------------- tooltip ---------------------------

let currentAnchor = null;

function attachTooltip(el, text) {
  if (!text) return;
  el.classList.add("has-tooltip");
  el.addEventListener("mouseenter", () => showTooltip(el, text));
  el.addEventListener("mouseleave", hideTooltip);
  el.addEventListener("focus", () => showTooltip(el, text));
  el.addEventListener("blur", hideTooltip);
  el.addEventListener("click", hideTooltip);
}

function showTooltip(anchor, text) {
  if (currentAnchor && !currentAnchor.isConnected) {
    hideTooltip();
    return;
  }
  currentAnchor = anchor;
  const tip = els.tooltip;
  tip.textContent = text;
  tip.setAttribute("aria-hidden", "false");
  tip.classList.add("visible");
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const pad = 8;
  let top = anchorRect.bottom + 6;
  let left = anchorRect.left;
  if (left + tipRect.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - tipRect.width - pad);
  }
  if (top + tipRect.height > window.innerHeight - pad) {
    top = Math.max(pad, anchorRect.top - tipRect.height - 6);
  }
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function hideTooltip() {
  currentAnchor = null;
  els.tooltip.classList.remove("visible");
  els.tooltip.setAttribute("aria-hidden", "true");
  requestAnimationFrame(() => {
    if (!els.tooltip.classList.contains("visible")) {
      els.tooltip.style.transform = "translate(-9999px, -9999px)";
    }
  });
}

// --------------------------- chat terminal ---------------------------

const chatTerm = new Terminal({
  fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  theme: { background: "#000000", foreground: "#c0caf5", cursor: "#7aa2f7" },
});
const chatFit = new FitAddon();
chatTerm.loadAddon(chatFit);
chatTerm.open(els.chat);
chatFit.fit();

// --------------------------- websocket chat proxy ---------------------------
//
// The chat WS is bound to exactly one repoId at connect-time. When the user
// switches the repo pulldown, we tear down the old WS and open a new one —
// the engine on the far end is different, and its ring buffer / chat session
// is independent.

const WS_BASE = (location.protocol === "https:" ? "wss" : "ws") + `://${location.host}/chat`;
let ws = null;
let wsRetryDelay = 250;
let wsRepoId = null;
let suppressReconnectMessage = false;

function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

function closeChatWs() {
  if (!ws) return;
  suppressReconnectMessage = true;
  try { ws.onclose = null; ws.onerror = null; ws.close(); } catch { /* ignore */ }
  ws = null;
}

function connectChat(repoId) {
  if (!repoId) return;
  wsRepoId = repoId;
  const url = `${WS_BASE}?repoId=${encodeURIComponent(repoId)}`;
  ws = new WebSocket(url);
  ws.onopen = () => { wsRetryDelay = 250; sendResize(); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "data" && typeof msg.bytes === "string") {
      chatTerm.write(b64decode(msg.bytes));
    } else if (msg.type === "chat_tool" && (msg.tool === "claude" || msg.tool === "gemini")) {
      // The server announces the current tool on connect and on every switch
      // so the pulldown can reflect the engine's live state without us having
      // to piece it together from SSE timing.
      syncChatToolSelect(msg.tool);
    }
  };
  ws.onclose = () => {
    if (!suppressReconnectMessage) {
      chatTerm.write("\r\n[chat disconnected — reconnecting…]\r\n");
    }
    suppressReconnectMessage = false;
    const rid = wsRepoId;
    setTimeout(() => { if (rid === wsRepoId) connectChat(rid); }, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function switchChatToRepo(repoId) {
  if (!repoId || repoId === wsRepoId) return;
  closeChatWs();
  wsRetryDelay = 250;
  chatTerm.reset();
  connectChat(repoId);
}

function sendBytes(str) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "data", bytes: b64encode(str) }));
}
function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "resize", cols: chatTerm.cols, rows: chatTerm.rows }));
}
function sendSetChatTool(tool) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "set_chat_tool", tool }));
}

chatTerm.onData((data) => sendBytes(data));

// --------------------------- repo selector ---------------------------

function currentRepo() {
  return state.repos.find((r) => r.repoId === state.selectedRepoId) ?? null;
}

function syncChatToolSelect(tool) {
  if (els.prefChat.value !== tool) els.prefChat.value = tool;
  const repo = currentRepo();
  if (repo) repo.chatTool = tool;
}

function syncJobToolSelect(tool) {
  if (els.prefJobs.value !== tool) els.prefJobs.value = tool;
}

function renderRepoSelector() {
  const repos = state.repos;

  if (repos.length === 0) {
    els.repoFilter.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No repos attached";
    els.repoFilter.appendChild(opt);
    els.repoFilter.disabled = true;
    els.prefChat.disabled = true;
    els.prefJobs.disabled = true;
    state.selectedRepoId = null;
    return;
  }

  els.repoFilter.disabled = false;
  els.prefChat.disabled = false;
  els.prefJobs.disabled = false;

  els.repoFilter.replaceChildren();
  for (const repo of repos) {
    const opt = document.createElement("option");
    opt.value = repo.repoId;
    opt.textContent = repo.repoName;
    els.repoFilter.appendChild(opt);
  }

  // Pick a valid selection: keep the current choice if it's still attached,
  // else fall back to the first repo. This is also the first-load path.
  if (!state.selectedRepoId || !repos.some((r) => r.repoId === state.selectedRepoId)) {
    state.selectedRepoId = repos[0].repoId;
    localStorage.setItem("sparkflow:selectedRepoId", state.selectedRepoId);
  }
  els.repoFilter.value = state.selectedRepoId;

  const repo = currentRepo();
  if (repo?.chatTool) syncChatToolSelect(repo.chatTool);
  if (repo?.jobTool) syncJobToolSelect(repo.jobTool);

  // Open the chat WS for the selected repo if we're not already on it.
  if (state.selectedRepoId !== wsRepoId) switchChatToRepo(state.selectedRepoId);
}

els.repoFilter.addEventListener("change", () => {
  const next = els.repoFilter.value;
  if (!next) return;
  state.selectedRepoId = next;
  localStorage.setItem("sparkflow:selectedRepoId", next);
  switchChatToRepo(next);
  const repo = currentRepo();
  if (repo?.chatTool) syncChatToolSelect(repo.chatTool);
  if (repo?.jobTool) syncJobToolSelect(repo.jobTool);
  renderJobs();
});

// --------------------------- tool pulldowns ---------------------------

els.prefChat.addEventListener("change", () => {
  const repo = currentRepo();
  const nextTool = els.prefChat.value;
  if (!repo) return;
  if (repo.chatTool === nextTool) return;
  // Destructive switch — confirm first. Revert the select while the modal is
  // open so the dropdown doesn't lie about the current state.
  const previousTool = repo.chatTool ?? "claude";
  els.prefChat.value = previousTool;
  openChatSwitchModal(() => {
    sendSetChatTool(nextTool);
    // Optimistically reflect the new value; the server will confirm via a
    // chat_tool frame once the PTY restarts.
    els.prefChat.value = nextTool;
  });
});

els.prefJobs.addEventListener("change", () => {
  const repo = currentRepo();
  const nextTool = els.prefJobs.value;
  if (!repo) return;
  const url = `/repos/${encodeURIComponent(repo.repoId)}/job-tool`;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: nextTool }),
  }).then((r) => {
    if (!r.ok) {
      // Revert on failure so the select doesn't lie.
      els.prefJobs.value = repo.jobTool ?? "claude";
    } else {
      repo.jobTool = nextTool;
    }
  }).catch(() => {
    els.prefJobs.value = repo.jobTool ?? "claude";
  });
});

// --------------------------- chat-switch confirm modal ---------------------------

let pendingChatSwitch = null;

function openChatSwitchModal(onConfirm) {
  pendingChatSwitch = onConfirm;
  els.chatSwitchModal.hidden = false;
}
function closeChatSwitchModal() {
  pendingChatSwitch = null;
  els.chatSwitchModal.hidden = true;
}
els.chatSwitchCancel.addEventListener("click", closeChatSwitchModal);
els.chatSwitchConfirm.addEventListener("click", () => {
  const cb = pendingChatSwitch;
  closeChatSwitchModal();
  if (cb) cb();
});

// --------------------------- URL helpers ---------------------------

function jobActionUrl(repoId, jobId, action) {
  return `/repos/${encodeURIComponent(repoId)}/jobs/${encodeURIComponent(jobId)}/${action}`;
}

function jobRepoId(jobId) {
  return state.jobs.find((j) => j.id === jobId)?.repoId ?? "";
}

// --------------------------- tabs ---------------------------

function renderTabs() {
  els.tabs.replaceChildren();
  for (const tab of state.tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab" + (tab.id === state.activeTabId ? " active" : "");
    btn.setAttribute("role", "tab");
    btn.dataset.tabId = tab.id;
    btn.addEventListener("click", () => activateTab(tab.id));

    if (tab.kind === "job") {
      const dot = document.createElement("span");
      const jobState = findJob(tab.id)?.state ?? "unknown";
      dot.className = "tab-dot " + jobState;
      btn.appendChild(dot);
    }

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = tab.label;
    btn.appendChild(label);

    if (tab.kind === "job") {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "close tab");
      close.addEventListener("click", (ev) => {
        ev.stopPropagation();
        closeJobTab(tab.id);
      });
      btn.appendChild(close);
    }

    els.tabs.appendChild(btn);
  }
}

function activateTab(tabId) {
  state.activeTabId = tabId;
  for (const pane of els.main.querySelectorAll(".pane")) {
    pane.classList.toggle("active", pane.dataset.tabId === tabId || (tabId === "chat" && pane.id === "chat"));
  }
  if (tabId === "chat") {
    requestAnimationFrame(() => { chatFit.fit(); sendResize(); });
  } else {
    const view = state.jobViews.get(tabId);
    if (view) requestAnimationFrame(() => view.fit.fit());
  }
  renderTabs();
  renderJobs();
}

function openJobTab(jobId) {
  if (state.jobViews.has(jobId)) { activateTab(jobId); return; }

  const job = findJob(jobId);
  const label = jobTabLabel(job, jobId);
  state.tabs.push({ id: jobId, kind: "job", label });

  const pane = document.createElement("div");
  pane.className = "pane job-pane";
  pane.dataset.tabId = jobId;
  pane.setAttribute("role", "tabpanel");
  els.main.appendChild(pane);

  const toolbar = document.createElement("div");
  toolbar.className = "pane-toolbar";
  const verboseLabel = document.createElement("label");
  const verboseCheckbox = document.createElement("input");
  verboseCheckbox.type = "checkbox";
  verboseCheckbox.checked = false;
  const verboseText = document.createElement("span");
  verboseText.textContent = "Verbose";
  verboseLabel.append(verboseCheckbox, verboseText);
  attachTooltip(verboseLabel, "Verbose: show JSON status events, sparkflow meta, and step-transition lines. Off: just the running step's output.");
  toolbar.appendChild(verboseLabel);
  pane.appendChild(toolbar);

  const termContainer = document.createElement("div");
  termContainer.className = "pane-xterm";
  pane.appendChild(termContainer);

  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
    fontSize: 12,
    cursorBlink: false,
    disableStdin: true,
    convertEol: true,
    scrollback: 10000,
    theme: { background: "#000000", foreground: "#c0caf5" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(termContainer);

  const nudgeDiv = document.createElement("div");
  nudgeDiv.className = "pane-nudge";

  const nudgeStep = document.createElement("select");
  nudgeStep.className = "nudge-step";
  nudgeDiv.appendChild(nudgeStep);

  const nudgeInput = document.createElement("input");
  nudgeInput.className = "nudge-input";
  nudgeInput.type = "text";
  nudgeInput.placeholder = "Redirect the running step…";
  nudgeDiv.appendChild(nudgeInput);

  const nudgeSend = document.createElement("button");
  nudgeSend.type = "button";
  nudgeSend.className = "btn primary nudge-send";
  nudgeSend.textContent = "Send";
  nudgeDiv.appendChild(nudgeSend);

  const nudgeError = document.createElement("span");
  nudgeError.className = "nudge-error";
  nudgeDiv.appendChild(nudgeError);

  pane.appendChild(nudgeDiv);

  const view = {
    term,
    fit,
    pane,
    termContainer,
    repoId: job?.repoId ?? "",
    rawLines: [],
    lineLength: 0,
    verbose: false,
    verboseCheckbox,
    nudgeEl: nudgeDiv,
    nudgeStep,
    nudgeInput,
    nudgeSend,
    nudgeError,
    polling: false,
    pollTimer: null,
    stopped: false,
  };
  state.jobViews.set(jobId, view);

  verboseCheckbox.addEventListener("change", () => {
    view.verbose = verboseCheckbox.checked;
    rerenderJobView(view);
  });

  async function sendNudge() {
    const message = nudgeInput.value.trim();
    if (!message) return;
    const stepId = nudgeStep.value;
    if (!stepId) return;
    nudgeSend.disabled = true;
    const repoId = view.repoId || jobRepoId(jobId);
    try {
      const res = await fetch(jobActionUrl(repoId, jobId, "nudge"), {
        method: "POST",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ stepId, message }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        nudgeInput.value = "";
        nudgeError.textContent = "";
      } else {
        nudgeError.textContent = `nudge failed: ${body?.error ?? `HTTP ${res.status}`}`;
        setTimeout(() => { nudgeError.textContent = ""; }, 3000);
      }
    } catch (err) {
      nudgeError.textContent = `nudge failed: ${String(err?.message ?? err)}`;
      setTimeout(() => { nudgeError.textContent = ""; }, 3000);
    }
    nudgeSend.disabled = false;
  }

  nudgeSend.addEventListener("click", sendNudge);
  nudgeInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); sendNudge(); }
  });

  activateTab(jobId);
  pollJobLog(jobId);
}

function rerenderJobView(view) {
  try { view.term.reset(); } catch { /* ignore */ }
  for (const line of view.rawLines) {
    const out = transformLogLine(line, view.verbose);
    if (out !== null) view.term.write(out + "\r\n");
  }
}

function closeJobTab(jobId) {
  const view = state.jobViews.get(jobId);
  if (!view) return;
  view.stopped = true;
  if (view.pollTimer) clearTimeout(view.pollTimer);
  try { view.term.dispose(); } catch { /* ignore */ }
  view.pane.remove();
  state.jobViews.delete(jobId);
  state.tabs = state.tabs.filter((t) => t.id !== jobId);
  if (state.activeTabId === jobId) activateTab("chat");
  else { renderTabs(); renderJobs(); }
}

function jobTabLabel(job, jobId) {
  if (!job) return jobId.slice(0, 8);
  const base = job.slug ? `${job.workflowName ?? "?"}: ${job.slug}` : (job.workflowName ?? jobId.slice(0, 8));
  return base;
}

function updateJobTabLabels() {
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.kind !== "job") continue;
    const newLabel = jobTabLabel(findJob(tab.id), tab.id);
    if (newLabel !== tab.label) { tab.label = newLabel; changed = true; }
  }
  if (changed) renderTabs();
}

// --------------------------- job log polling ---------------------------

const RAW_LINES_CAP = 10000;

async function pollJobLog(jobId) {
  const view = state.jobViews.get(jobId);
  if (!view || view.stopped) return;
  const repoId = view.repoId || jobRepoId(jobId);
  try {
    const res = await fetch(
      jobActionUrl(repoId, jobId, `log?since=${view.lineLength}`),
      { headers: { Accept: "application/json" } },
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.lines) && data.lines.length > 0) {
        for (const line of data.lines) {
          view.rawLines.push(line);
          const out = transformLogLine(line, view.verbose);
          if (out !== null) view.term.write(out + "\r\n");
        }
        if (view.rawLines.length > RAW_LINES_CAP) {
          view.rawLines.splice(0, view.rawLines.length - RAW_LINES_CAP);
        }
      }
      if (typeof data.length === "number") view.lineLength = data.length;
      const terminal = data.state === "succeeded" || data.state === "failed";
      const nextDelay = terminal ? 3000 : 750;
      if (!view.stopped) view.pollTimer = setTimeout(() => pollJobLog(jobId), nextDelay);
      return;
    }
    if (res.status === 404) {
      toast("error", `Job ${jobId.slice(0, 8)} no longer exists.`);
      closeJobTab(jobId);
      return;
    }
  } catch {
    // Network blip; retry.
  }
  if (!view.stopped) view.pollTimer = setTimeout(() => pollJobLog(jobId), 2000);
}

// --------------------------- jobs panel + SSE ---------------------------

function findJob(id) { return state.jobs.find((j) => j.id === id); }

function isMonitor(job) { return job.kind === "monitor"; }

function monitorNeedsAttention(job) {
  return ["failed", "failed_waiting", "blocked"].includes(job.state) || !!job.pendingQuestion;
}

function visibleJobs(jobs, showMonitors, selectedRepoId) {
  return jobs.filter((j) => {
    if (!selectedRepoId || j.repoId !== selectedRepoId) return false;
    return !isMonitor(j) || showMonitors || monitorNeedsAttention(j);
  });
}

function stepsForJob(job) {
  if (Array.isArray(job.activeSteps) && job.activeSteps.length > 0) {
    return job.activeSteps.map((name) => [name, "running"]);
  }
  if (job.currentStep && (job.stepState ?? "running") === "running") {
    return [[job.currentStep, "running"]];
  }
  return [];
}

function isStepStatusLine(summary) {
  return !!summary && /^(\S+):\s*(running|succeeded|failed|queued|starting)$/.test(summary);
}

function elapsed(startTime, endTime) {
  const ms = (endTime ?? Date.now()) - startTime;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function updateNudgeBars() {
  for (const [jobId, view] of state.jobViews) {
    const job = findJob(jobId);
    if (!job) continue;

    const activeKeys = job.activeSteps && Array.isArray(job.activeSteps)
      ? job.activeSteps
      : Object.keys(job.activeSteps || {});
    const ccSteps = job.claudeCodeSteps || [];
    const nudgeable = activeKeys.filter((s) => ccSteps.includes(s));

    const hasNudge = nudgeable.length > 0;
    view.pane.classList.toggle("has-nudge", hasNudge);

    if (!hasNudge) continue;

    const prevStep = view.nudgeStep.value;
    view.nudgeStep.replaceChildren();
    for (const s of nudgeable) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      view.nudgeStep.appendChild(opt);
    }
    if (prevStep && nudgeable.includes(prevStep)) view.nudgeStep.value = prevStep;
    view.nudgeStep.hidden = nudgeable.length === 1;

    const disabled = !job.canNudge;
    view.nudgeInput.disabled = disabled;
    view.nudgeSend.disabled = disabled;
    if (disabled) {
      view.nudgeInput.title = "nudges unavailable after reload";
    } else {
      view.nudgeInput.title = "";
    }

    requestAnimationFrame(() => { try { view.fit.fit(); } catch { /* ignore */ } });
  }
}

function repoNameFor(repoId) {
  return state.repos.find((r) => r.repoId === repoId)?.repoName ?? repoId.slice(0, 6);
}

function renderJobs() {
  els.list.replaceChildren();
  const jobs = state.selectedRepoId
    ? state.jobs.filter((j) => j.repoId === state.selectedRepoId)
    : [];
  const monitors = jobs.filter(isMonitor);
  const visible = visibleJobs(state.jobs, state.showMonitors, state.selectedRepoId);

  if (monitors.length > 0) {
    els.monitorToggleLabel.removeAttribute("hidden");
    els.monitorToggleCount.textContent = `(${monitors.length})`;
  } else {
    els.monitorToggleLabel.setAttribute("hidden", "");
  }

  els.count.textContent = visible.length === 0 ? "" : `${visible.length} total`;

  if (visible.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No jobs running. Use /sf-dispatch in the chat to start a workflow.";
    els.list.appendChild(li);
    return;
  }

  for (const job of visible) {
    els.list.appendChild(renderJobCard(job));
  }
}

function renderJobCard(job) {
  const li = document.createElement("li");
  li.className = "job-card";
  if (state.activeTabId === job.id) li.classList.add("viewing");

  const terminal = job.state === "succeeded" || job.state === "failed";

  const top = document.createElement("div");
  top.className = "row";
  const name = document.createElement("span");
  name.className = "name";
  const base = job.workflowName || job.workflowPath || "workflow";
  name.textContent = job.slug ? `${base}: ${job.slug}` : base;
  attachTooltip(name, job.description || name.textContent);
  top.appendChild(name);

  // Show repo badge when multiple repos are attached.
  if (state.repos.length > 1 && job.repoId) {
    const repoBadge = document.createElement("span");
    repoBadge.className = "repo-badge";
    repoBadge.textContent = repoNameFor(job.repoId);
    top.appendChild(repoBadge);
  }

  const pill = document.createElement("span");
  pill.className = `state-pill ${job.state}`;
  pill.textContent = (job.state || "?").replace("_", " ");
  top.appendChild(pill);

  if (terminal) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close-btn";
    close.textContent = "×";
    close.setAttribute("aria-label", `Remove job ${job.id.slice(0, 8)}`);
    attachTooltip(close, "Remove from dashboard");
    close.addEventListener("click", (ev) => {
      ev.stopPropagation();
      removeJob(job.id, job.repoId);
    });
    top.appendChild(close);
  }

  li.appendChild(top);

  const meta = document.createElement("div");
  meta.className = "meta";
  const id = document.createElement("span");
  id.className = "id";
  id.textContent = job.id.slice(0, 8);
  meta.appendChild(id);

  const steps = stepsForJob(job);
  for (const [stepName] of steps) {
    const chip = document.createElement("span");
    chip.className = "step";
    chip.dataset.stepColor = String(stepColorIndex(stepName));
    chip.textContent = stepName;
    attachTooltip(chip, `${stepName} — running`);
    meta.appendChild(chip);
  }

  const time = document.createElement("span");
  time.className = "elapsed";
  time.textContent = elapsed(job.startTime, job.endTime);
  meta.appendChild(time);

  li.appendChild(meta);

  const rawSummary = job.pendingQuestion ? `Q: ${job.pendingQuestion}` : (job.summary || "");
  const text = job.pendingQuestion ? rawSummary : (isStepStatusLine(rawSummary) ? "" : rawSummary);
  if (text) {
    const summary = document.createElement("div");
    summary.className = "summary" + (job.pendingQuestion ? " question" : "");
    summary.textContent = text;
    attachTooltip(summary, text);
    li.appendChild(summary);
  }

  const actions = document.createElement("div");
  actions.className = "actions";

  const viewBtn = document.createElement("button");
  viewBtn.type = "button";
  viewBtn.className = "btn primary";
  viewBtn.textContent = state.activeTabId === job.id ? "Viewing" : "View";
  viewBtn.disabled = state.activeTabId === job.id;
  viewBtn.addEventListener("click", () => openJobTab(job.id));
  actions.appendChild(viewBtn);

  const killBtn = document.createElement("button");
  killBtn.type = "button";
  killBtn.className = "btn danger";
  killBtn.textContent = "Kill";
  killBtn.disabled = terminal;
  killBtn.addEventListener("click", () => killJob(job.id, job.repoId));
  actions.appendChild(killBtn);

  const restartBtn = document.createElement("button");
  restartBtn.type = "button";
  restartBtn.className = "btn";
  restartBtn.textContent = "Restart";
  restartBtn.addEventListener("click", () => restartJob(job.id, job.repoId));
  actions.appendChild(restartBtn);

  li.appendChild(actions);
  return li;
}

// --------------------------- actions ---------------------------

async function killJob(jobId, repoId) {
  const rid = repoId || jobRepoId(jobId);
  const res = await postAction(jobActionUrl(rid, jobId, "kill"));
  if (res.ok) toast("success", `Killed job ${jobId.slice(0, 8)}.`);
  else toast("error", `Kill failed: ${res.error}`);
}

async function restartJob(jobId, repoId) {
  const rid = repoId || jobRepoId(jobId);
  const res = await postAction(jobActionUrl(rid, jobId, "restart"));
  if (res.ok) {
    toast("success", `Restarted ${jobId.slice(0, 8)}.`);
    if (res.newJobId && state.jobViews.has(jobId)) {
      closeJobTab(jobId);
      openJobTab(res.newJobId);
    }
  } else {
    toast("error", `Restart failed: ${res.error}`);
  }
}

async function removeJob(jobId, repoId) {
  const rid = repoId || jobRepoId(jobId);
  const res = await postAction(jobActionUrl(rid, jobId, "remove"));
  if (res.ok) {
    toast("success", `Removed ${jobId.slice(0, 8)}.`);
    if (state.jobViews.has(jobId)) closeJobTab(jobId);
  } else {
    toast("error", `Remove failed: ${res.error}`);
  }
}

async function postAction(url) {
  try {
    const res = await fetch(url, { method: "POST", headers: { Accept: "application/json" } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, ...body };
    return { ok: false, error: body?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

function toast(kind, text) {
  const div = document.createElement("div");
  div.className = `toast ${kind}`;
  div.textContent = text;
  toastsEl.appendChild(div);
  setTimeout(() => {
    div.style.transition = "opacity 200ms ease";
    div.style.opacity = "0";
    setTimeout(() => div.remove(), 220);
  }, 2400);
}

// Monitor toggle: initialize from state and persist changes to localStorage.
els.showMonitors.checked = state.showMonitors;
els.showMonitors.addEventListener("change", () => {
  state.showMonitors = els.showMonitors.checked;
  localStorage.setItem("sparkflow:showMonitors", String(state.showMonitors));
  renderJobs();
});

// --------------------------- SSE feed ---------------------------

function connectEvents() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (Array.isArray(data.repos)) {
        state.repos = data.repos;
        renderRepoSelector();
      }
      if (Array.isArray(data.jobs)) {
        state.jobs = data.jobs.slice().sort((a, b) => a.startTime - b.startTime);
        renderJobs();
        updateJobTabLabels();
        updateNudgeBars();
        for (const id of state.jobViews.keys()) {
          if (!findJob(id)) closeJobTab(id);
        }
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => { es.close(); setTimeout(connectEvents, 2000); };
}
connectEvents();

// --------------------------- layout ---------------------------

function refitAllPanes() {
  try { chatFit.fit(); sendResize(); } catch { /* ignore */ }
  for (const view of state.jobViews.values()) {
    try { view.fit.fit(); } catch { /* ignore */ }
  }
}

window.addEventListener("resize", refitAllPanes);

const mainResizeObs = new ResizeObserver(() => {
  requestAnimationFrame(refitAllPanes);
});
mainResizeObs.observe(els.main);

setInterval(() => renderJobs(), 1000);

renderTabs();
renderJobs();
