// Vanilla browser client for sparkflow web mode.
// Loads xterm.js (vendored from node_modules), proxies the chat over a
// WebSocket, and keeps the bottom job panel in sync via SSE.

import { Terminal } from "/static/xterm.mjs";
import { FitAddon } from "/static/addon-fit.mjs";

// --- terminal ---
const term = new Terminal({
  fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  cursorBlink: true,
  convertEol: false,
  scrollback: 5000,
  theme: {
    background: "#000000",
    foreground: "#c0caf5",
    cursor: "#7aa2f7",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("chat"));
fit.fit();

// --- websocket chat proxy ---
const wsUrl = (location.protocol === "https:" ? "wss" : "ws") + `://${location.host}/chat`;
let ws = null;
let wsRetryDelay = 250;

function b64encode(str) {
  // UTF-8 → base64 without spreading large strings
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function connectChat() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    wsRetryDelay = 250;
    sendResize();
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "data" && typeof msg.bytes === "string") {
      term.write(b64decode(msg.bytes));
    }
  };
  ws.onclose = () => {
    term.write("\r\n[chat disconnected — reconnecting…]\r\n");
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
  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
}

term.onData((data) => sendBytes(data));

window.addEventListener("resize", () => {
  fit.fit();
  sendResize();
});

connectChat();

// --- SSE job feed ---
const list = document.getElementById("job-list");

function elapsed(startTime, endTime) {
  const ms = (endTime ?? Date.now()) - startTime;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m${secs % 60}s`;
}

function renderJobs(jobs) {
  list.replaceChildren();
  if (!jobs || jobs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No jobs running. Use /sf-dispatch in the chat to start a workflow.";
    list.appendChild(li);
    return;
  }
  for (const job of jobs) {
    const li = document.createElement("li");
    li.className = "job";

    const id = document.createElement("span");
    id.className = "id";
    id.textContent = job.id.slice(0, 8);

    const name = document.createElement("span");
    name.className = "name";
    const baseName = job.workflowName || job.workflowPath || "?";
    const step = job.currentStep ? `/${job.currentStep}` : "";
    name.textContent = `[${job.slug ? `${baseName}: ${job.slug}` : baseName}${step}]`;

    const state = document.createElement("span");
    state.className = `state state-${job.state}`;
    state.textContent = (job.state || "?").toUpperCase();

    const summary = document.createElement("span");
    summary.className = "summary";
    const q = job.pendingQuestion ? ` ? ${job.pendingQuestion}` : "";
    summary.textContent = (job.summary || "") + q;

    const time = document.createElement("span");
    time.className = "elapsed";
    time.textContent = `(${elapsed(job.startTime, job.endTime)})`;

    li.append(id, name, state, summary, time);
    list.appendChild(li);
  }
}

let lastJobs = [];
function connectEvents() {
  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (Array.isArray(data.jobs)) {
        lastJobs = data.jobs;
        renderJobs(lastJobs);
      }
    } catch { /* ignore */ }
  };
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}
connectEvents();

// Re-render every second so the elapsed-time column ticks even between SSE pushes.
setInterval(() => renderJobs(lastJobs), 1000);
