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
};

// Floating toast host, injected once.
let toastsEl = document.getElementById("toasts");
if (!toastsEl) {
  toastsEl = document.createElement("div");
  toastsEl.id = "toasts";
  document.body.appendChild(toastsEl);
}

// --------------------------- tooltip ---------------------------

function attachTooltip(el, text) {
  if (!text) return;
  el.classList.add("has-tooltip");
  el.addEventListener("mouseenter", () => showTooltip(el, text));
  el.addEventListener("mouseleave", hideTooltip);
  el.addEventListener("focus", () => showTooltip(el, text));
  el.addEventListener("blur", hideTooltip);
}

function showTooltip(anchor, text) {
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

  // Pane element.
  const pane = document.createElement("div");
  pane.className = "pane job-pane";
  pane.dataset.tabId = jobId;
  pane.setAttribute("role", "tabpanel");
  els.main.appendChild(pane);

  // Dedicated xterm for this job log.
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
  term.open(pane);

  const view = { term, fit, pane, lineLength: 0, polling: false, pollTimer: null, stopped: false };
  state.jobViews.set(jobId, view);

  activateTab(jobId);
  pollJobLog(jobId);
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
        view.term.write(data.lines.join("\r\n") + "\r\n");
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

// The JobManager sets summary to `"<step>: <state>"` on every step_status
// event. That's a duplicate of the step chips we already render on the card,
// so hide it. Non-matching summaries ("completed", "killed by user", etc.)
// fall through and are shown.
function isStepStatusDuplicate(job, summary) {
  if (!summary) return false;
  const m = summary.match(/^(\S+):\s*(running|succeeded|failed|queued|starting)$/);
  if (!m) return false;
  return stepsForJob(job).some(([name]) => name === m[1]);
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
  attachTooltip(name, name.textContent);
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
  const text = job.pendingQuestion ? rawSummary : (isStepStatusDuplicate(job, rawSummary) ? "" : rawSummary);
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
  if (res.ok) toast("success", `Restarted ${jobId.slice(0, 8)} as ${res.newJobId?.slice(0, 8)}.`);
  else toast("error", `Restart failed: ${res.error}`);
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

window.addEventListener("resize", () => {
  chatFit.fit();
  sendResize();
  for (const view of state.jobViews.values()) {
    try { view.fit.fit(); } catch { /* ignore */ }
  }
});

// Re-render every second so the elapsed-time column ticks between SSE pushes.
setInterval(() => renderJobs(), 1000);

// Initial render (before SSE arrives).
renderTabs();
renderJobs();
