// Vanilla browser client for sparkflow web mode.
// - Chat pane: xterm.js proxying a server-side PTY over WebSocket.
// - Jobs panel: cards with View / Kill / Restart actions.
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
  // Latest jobs snapshot from SSE.
  jobs: [],
};

const els = {
  tabs: document.getElementById("tabs"),
  main: document.getElementById("main"),
  chat: document.getElementById("chat"),
  list: document.getElementById("job-list"),
  count: document.getElementById("job-count"),
  tooltip: document.getElementById("tooltip"),
  prefChat: document.getElementById("pref-chat"),
  prefJobs: document.getElementById("pref-jobs"),
};

// --------------------------- step colors ---------------------------
// Each step gets a stable color derived from its name so the chip on the card
// and the label in the job log view agree. Five colors (we skip red to avoid
// conflating with failure).
const STEP_PALETTE_SIZE = 5;
const STEP_PALETTE_ANSI = [
  "\x1b[38;5;117m", // cyan   → --cyan    #7dcfff
  "\x1b[38;5;149m", // green  → --green   #9ece6a
  "\x1b[38;5;179m", // yellow → --yellow  #e0af68
  "\x1b[38;5;141m", // magenta→ --magenta #bb9af7
  "\x1b[38;5;111m", // blue   → --accent  #7aa2f7
];
const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";

function stepColorIndex(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % STEP_PALETTE_SIZE;
}

// --------------------------- log line transform ---------------------------
// Parse a raw log line; return the string to write to xterm (with ANSI step
// label) or null to skip.
function transformLogLine(line, verbose) {
  // JSON status events. In non-verbose we hide them entirely; in verbose we
  // render a compact, dim form.
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

  // `[step]` / `[step:stderr]` / `[step:tool]` / `[step:tool_result]` / `[step:meta]`
  const m = line.match(/^\[([^\]:]+)(?::([a-z_]+))?\]\s?(.*)$/);
  if (m) {
    const step = m[1];
    const suffix = m[2]; // undefined | "stderr" | "tool" | "tool_result" | "meta"
    const content = m[3];
    if (!verbose) {
      // Sparkflow meta lines are infrastructure; hide them.
      if (step === "sparkflow") return null;
      // Pure status transitions are already represented by card chips/pills.
      if (/^(running|succeeded|failed)(\s*\(.+\))?$/.test(content)) return null;
      // Tool-use / tool-result / result-summary lines (new suffix-based format).
      if (suffix === "tool" || suffix === "tool_result" || suffix === "meta") return null;
      // Legacy format (pre–suffix rollout): text + tool-use flattened on one
      // line with a `[tool:` marker somewhere in the content. Filter those too.
      if (content.includes("[tool: ") || content.includes("[tool_result]")) return null;
    }
    const ansi = STEP_PALETTE_ANSI[stepColorIndex(step)];
    const label = `${ansi}[${step}${suffix ? ":" + suffix : ""}]${ANSI_RESET}`;
    return `${label} ${content}`;
  }

  // Untagged line. In non-verbose, skip; in verbose, dim it.
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
  // Measure first so we can position off the anchor's bottom-left,
  // nudging left/up if we'd overflow the viewport.
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
  // Move offscreen on next frame so stale position doesn't flash on re-show.
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

const wsUrl = (location.protocol === "https:" ? "wss" : "ws") + `://${location.host}/chat`;
let ws = null;
let wsRetryDelay = 250;

function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
function b64decode(b64) { return decodeURIComponent(escape(atob(b64))); }

function connectChat() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { wsRetryDelay = 250; sendResize(); };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "data" && typeof msg.bytes === "string") {
      chatTerm.write(b64decode(msg.bytes));
    }
  };
  ws.onclose = () => {
    chatTerm.write("\r\n[chat disconnected — reconnecting…]\r\n");
    setTimeout(connectChat, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 5000);
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function sendBytes(str) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "data", bytes: b64encode(str) }));
}
function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "resize", cols: chatTerm.cols, rows: chatTerm.rows }));
}

chatTerm.onData((data) => sendBytes(data));
connectChat();

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
  // Show the matching pane, hide others.
  for (const pane of els.main.querySelectorAll(".pane")) {
    pane.classList.toggle("active", pane.dataset.tabId === tabId || (tabId === "chat" && pane.id === "chat"));
  }
  // Refit the relevant terminal (layout may have been stale while hidden).
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

  // Floating toolbar — overlays the top-right corner of the xterm.
  const toolbar = document.createElement("div");
  toolbar.className = "pane-toolbar";
  const verboseLabel = document.createElement("label");
  const verboseCheckbox = document.createElement("input");
  verboseCheckbox.type = "checkbox";
  verboseCheckbox.checked = false; // default: non-verbose (just step output)
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

  const view = {
    term,
    fit,
    pane,
    termContainer,
    rawLines: [],
    lineLength: 0,
    verbose: false,
    verboseCheckbox,
    polling: false,
    pollTimer: null,
    stopped: false,
  };
  state.jobViews.set(jobId, view);

  verboseCheckbox.addEventListener("change", () => {
    view.verbose = verboseCheckbox.checked;
    rerenderJobView(view);
  });

  activateTab(jobId);
  pollJobLog(jobId);
}

function rerenderJobView(view) {
  // xterm.reset() clears both the screen and the scrollback buffer.
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
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/log?since=${view.lineLength}`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.lines) && data.lines.length > 0) {
        // Keep a cap on the in-memory raw buffer so re-render on verbose
        // toggle doesn't turn pathological.
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
      // Slow the poll once the job is terminal.
      const terminal = data.state === "succeeded" || data.state === "failed";
      const nextDelay = terminal ? 3000 : 750;
      if (!view.stopped) view.pollTimer = setTimeout(() => pollJobLog(jobId), nextDelay);
      return;
    }
    if (res.status === 404) {
      // Job was removed; close the tab after a grace period.
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

// Build an ordered list of [stepName, "running"] pairs to show on the card.
// Only *currently-running* steps get a chip — once a step succeeds or fails,
// the server-computed activeSteps drops it. The state pill shows terminal
// outcomes at the job level, so step chips for completed steps would be
// noise.
function stepsForJob(job) {
  if (job.activeSteps) return Object.entries(job.activeSteps);
  // Legacy payloads: only show the single currentStep while it's running.
  if (job.currentStep && (job.stepState ?? "running") === "running") {
    return [[job.currentStep, "running"]];
  }
  return [];
}

// JobManager sets summary to `"<step>: <state>"` on every step_status event.
// The state pill conveys the job-level outcome and the step chips show
// what's currently running; the per-step status line adds nothing, so hide
// it regardless of whether a matching chip is present. Other summaries
// ("completed", "killed by user", pending questions, etc.) fall through.
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

function renderJobs() {
  els.list.replaceChildren();
  const jobs = state.jobs;
  els.count.textContent = jobs.length === 0 ? "" : `${jobs.length} total`;

  if (jobs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No jobs running. Use /sf-dispatch in the chat to start a workflow.";
    els.list.appendChild(li);
    return;
  }

  for (const job of jobs) {
    els.list.appendChild(renderJobCard(job));
  }
}

function renderJobCard(job) {
  const li = document.createElement("li");
  li.className = "job-card";
  if (state.activeTabId === job.id) li.classList.add("viewing");

  const terminal = job.state === "succeeded" || job.state === "failed";

  // Top row: name + state pill + (× for terminal jobs).
  const top = document.createElement("div");
  top.className = "row";
  const name = document.createElement("span");
  name.className = "name";
  const base = job.workflowName || job.workflowPath || "workflow";
  name.textContent = job.slug ? `${base}: ${job.slug}` : base;
  attachTooltip(name, job.description || name.textContent);
  top.appendChild(name);

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
      removeJob(job.id);
    });
    top.appendChild(close);
  }

  li.appendChild(top);

  // Meta: id · step(s) · elapsed. Multiple chips when parallel steps run.
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

  // Summary — pending question takes precedence. Otherwise show job.summary,
  // but suppress the redundant "<stepName>: <state>" status line when the step
  // chips already convey that information.
  const rawSummary = job.pendingQuestion ? `Q: ${job.pendingQuestion}` : (job.summary || "");
  const text = job.pendingQuestion ? rawSummary : (isStepStatusLine(rawSummary) ? "" : rawSummary);
  if (text) {
    const summary = document.createElement("div");
    summary.className = "summary" + (job.pendingQuestion ? " question" : "");
    summary.textContent = text;
    attachTooltip(summary, text);
    li.appendChild(summary);
  }

  // Actions.
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
  killBtn.addEventListener("click", () => killJob(job.id));
  actions.appendChild(killBtn);

  const restartBtn = document.createElement("button");
  restartBtn.type = "button";
  restartBtn.className = "btn";
  restartBtn.textContent = "Restart";
  restartBtn.addEventListener("click", () => restartJob(job.id));
  actions.appendChild(restartBtn);

  li.appendChild(actions);
  return li;
}

// --------------------------- actions ---------------------------

async function killJob(jobId) {
  const res = await postAction(`/api/jobs/${encodeURIComponent(jobId)}/kill`);
  if (res.ok) toast("success", `Killed job ${jobId.slice(0, 8)}.`);
  else toast("error", `Kill failed: ${res.error}`);
}

async function restartJob(jobId) {
  const res = await postAction(`/api/jobs/${encodeURIComponent(jobId)}/restart`);
  if (res.ok) {
    toast("success", `Restarted ${jobId.slice(0, 8)} as ${res.newJobId?.slice(0, 8)}.`);
    if (res.newJobId && state.jobViews.has(jobId)) {
      closeJobTab(jobId);
      openJobTab(res.newJobId);
    }
  } else {
    toast("error", `Restart failed: ${res.error}`);
  }
}

async function removeJob(jobId) {
  const res = await postAction(`/api/jobs/${encodeURIComponent(jobId)}/remove`);
  if (res.ok) {
    toast("success", `Removed ${jobId.slice(0, 8)}.`);
    // Close the viewing tab if we had one open — it's gone.
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

// --------------------------- preferences ---------------------------

async function loadPreferences() {
  try {
    const res = await fetch("/api/preferences", { headers: { Accept: "application/json" } });
    if (!res.ok) return;
    const prefs = await res.json();
    if (prefs.chat === "claude" || prefs.chat === "gemini") els.prefChat.value = prefs.chat;
    if (prefs.jobs === "claude" || prefs.jobs === "gemini") els.prefJobs.value = prefs.jobs;
  } catch { /* ignore */ }
}

async function savePreference(key, value) {
  try {
    const res = await fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("error", `Failed to set ${key}: ${body?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    toast("success", `${key === "jobs" ? "Job runtime" : "Chat"} → ${value}`);
  } catch (err) {
    toast("error", `Failed to set ${key}: ${String(err?.message ?? err)}`);
  }
}

els.prefJobs.addEventListener("change", () => savePreference("jobs", els.prefJobs.value));
els.prefChat.addEventListener("change", () => savePreference("chat", els.prefChat.value));
loadPreferences();

// --------------------------- SSE feed ---------------------------

function connectEvents() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (Array.isArray(data.jobs)) {
        state.jobs = data.jobs;
        renderJobs();
        updateJobTabLabels();
        // If a viewed job disappears, close its tab.
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

// #main's height changes whenever the status panel grows or shrinks
// (new jobs arrive, cards toggle, toolbar appears, etc.). xterm doesn't
// observe its container natively — if we don't refit on those changes,
// the bottom rows render beneath the dashboard. Guarded with
// requestAnimationFrame because ResizeObserver callbacks fire synchronously
// inside layout.
const mainResizeObs = new ResizeObserver(() => {
  requestAnimationFrame(refitAllPanes);
});
mainResizeObs.observe(els.main);

// Re-render every second so the elapsed-time column ticks between SSE pushes.
setInterval(() => renderJobs(), 1000);

// Initial render (before SSE arrives).
renderTabs();
renderJobs();
