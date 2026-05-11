// Auto-develop progress accordion widget.
// Mounted as a fixed overlay in the upper-right corner of the main page.
// Polls /api/auto-develop at 2s (10s when no roadmap exists).

const STORAGE_KEY = `sparkflow.auto-develop.expanded.${location.port}`;
const POLL_NORMAL_MS = 2000;
const POLL_SLOW_MS = 10000;
const TICK_MS = 1000;

let expanded = loadExpanded();
let lastGoodData = null;
let staleSince = null;
let lastUpdatedAt = null;
let pollTimer = null;
let tickTimer = null;

function loadExpanded() {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

function saveExpanded(val) {
  try { localStorage.setItem(STORAGE_KEY, String(val)); } catch {}
}

function formatElapsed(startMs) {
  const s = Math.floor((Date.now() - startMs) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function formatAge(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// -- DOM helpers --

function el(tag, cls, textContent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (textContent !== undefined) e.textContent = textContent;
  return e;
}

// -- Widget DOM --

const widget = el("div", "adw");
const header = el("button", "adw-header");
const chevron = el("span", "adw-chevron");
const headerLabel = el("span", "adw-header-label", "Auto-develop");
const headerSummary = el("span", "adw-header-summary");
const body = el("div", "adw-body");

header.setAttribute("aria-expanded", "false");
header.appendChild(chevron);
header.appendChild(headerLabel);
header.appendChild(headerSummary);
widget.appendChild(header);
widget.appendChild(body);
document.body.appendChild(widget);

header.addEventListener("click", () => {
  expanded = !expanded;
  saveExpanded(expanded);
  applyExpanded();
});

header.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && expanded) {
    expanded = false;
    saveExpanded(false);
    applyExpanded();
  }
});

function applyExpanded() {
  widget.classList.toggle("adw--expanded", expanded);
  header.setAttribute("aria-expanded", String(expanded));
}

applyExpanded();

// -- Rendering --

function renderHeader(data) {
  const tasks = data.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const total = tasks.length;

  let summary = ` · ${done}/${total}`;
  if (data.current_job) summary += " · ⏳1";
  if (blocked > 0) summary += ` · ⊘1`;

  headerSummary.textContent = summary;
}

function renderBody(data) {
  body.innerHTML = "";

  const tasks = data.tasks;
  const done = tasks.filter((t) => t.status === "done").length;
  const blocked = tasks.filter((t) => t.status === "blocked").length;
  const pending = tasks.filter((t) => t.status === "pending").length;
  const job = data.current_job;

  // Summary line
  const summaryLine = el("div", "adw-summary-line");
  let summaryText = `${done} done · ${blocked} blocked · ${pending} pending`;
  if (job) summaryText += ` · ▶ step: ${job.currentStep ?? "running"}`;
  summaryLine.textContent = summaryText;
  body.appendChild(summaryLine);

  // Task list
  const list = el("ul", "adw-task-list");
  const inProgressLine = job ? job.currentTaskLine : null;
  let showNextPill = job === null || inProgressLine === null;
  let nextPillPlaced = false;

  for (const task of tasks) {
    const li = el("li", "adw-task");
    const isInProgress = inProgressLine !== null && task.line === inProgressLine;

    if (isInProgress) {
      li.classList.add("adw-task--inprogress");
      showNextPill = false;
    } else if (task.status === "done") {
      li.classList.add("adw-task--done");
    } else if (task.status === "blocked") {
      li.classList.add("adw-task--blocked");
    } else {
      li.classList.add("adw-task--pending");
    }

    const row = el("div", "adw-task-row");

    // Glyph
    const glyph = el("span", "adw-glyph");
    if (isInProgress) glyph.textContent = "⏳"; // ⏳
    else if (task.status === "done") glyph.textContent = "✓"; // ✓
    else if (task.status === "blocked") glyph.textContent = "⊘"; // ⊘
    else glyph.textContent = "○"; // ◯
    row.appendChild(glyph);

    // Text
    const text = el("span", "adw-task-text", task.text);
    row.appendChild(text);

    // "next" pill: first pending task when nothing is in progress
    if (showNextPill && !nextPillPlaced && task.status === "pending" && !isInProgress) {
      const pill = el("span", "adw-next-pill", "next ▸");
      row.appendChild(pill);
      nextPillPlaced = true;
    }

    li.appendChild(row);

    // In-progress subtext
    if (isInProgress && job) {
      const sub = el("div", "adw-task-sub");
      sub.textContent = `└ job ${job.id} · ${job.currentStep ?? "running"} · `;
      const elapsedSpan = el("span", "adw-elapsed");
      elapsedSpan.dataset.startTime = String(job.startTime);
      elapsedSpan.textContent = formatElapsed(job.startTime);
      sub.appendChild(elapsedSpan);
      li.appendChild(sub);
    }

    // Blocked reason
    if (task.status === "blocked" && task.blockedReason) {
      const reason = el("div", "adw-blocked-reason", task.blockedReason);
      li.appendChild(reason);
    }

    list.appendChild(li);
  }
  body.appendChild(list);

  // Footer
  const footer = el("div", "adw-footer");

  // Stale indicator or updated time
  const timeSpan = el("span", "adw-footer-time");
  if (staleSince !== null) {
    timeSpan.classList.add("adw-footer-stale");
    timeSpan.textContent = `stale (${formatAge(staleSince)})`;
  } else if (lastUpdatedAt !== null) {
    timeSpan.textContent = `updated ${formatAge(lastUpdatedAt)}`;
  }
  footer.appendChild(timeSpan);

  // ROADMAP link (via /api/roadmap-raw for universal browser support)
  const link = document.createElement("a");
  link.className = "adw-roadmap-link";
  link.href = "/api/roadmap-raw";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "ROADMAP ↗";
  footer.appendChild(link);

  if (data.other_running_count > 0) {
    const more = el("div", "adw-more", `+${data.other_running_count} more auto-develop runs`);
    body.appendChild(more);
  }

  body.appendChild(footer);
}

function render(data) {
  if (!data.roadmap_exists) {
    widget.style.display = "none";
    return;
  }
  widget.style.display = "";
  renderHeader(data);
  if (expanded) renderBody(data);
}

// -- Tick: updates elapsed times every second without re-polling --

function tick() {
  const spans = widget.querySelectorAll(".adw-elapsed");
  for (const span of spans) {
    const startTime = parseInt(span.dataset.startTime ?? "0", 10);
    if (startTime > 0) span.textContent = formatElapsed(startTime);
  }
  // Also update "updated N ago" in footer
  const footerTime = widget.querySelector(".adw-footer-time:not(.adw-footer-stale)");
  if (footerTime && lastUpdatedAt !== null) {
    footerTime.textContent = `updated ${formatAge(lastUpdatedAt)}`;
  }
  const staleTime = widget.querySelector(".adw-footer-stale");
  if (staleTime && staleSince !== null) {
    staleTime.textContent = `stale (${formatAge(staleSince)})`;
  }
}

// -- Polling --

async function poll() {
  if (document.hidden) return;
  try {
    const res = await fetch("/api/auto-develop");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastGoodData = data;
    staleSince = null;
    lastUpdatedAt = Date.now();
    render(data);
    schedulePoll(data.roadmap_exists ? POLL_NORMAL_MS : POLL_SLOW_MS);
  } catch {
    if (staleSince === null) staleSince = Date.now();
    // Keep showing last good state; re-render footer to update stale indicator
    if (lastGoodData !== null) render(lastGoodData);
    schedulePoll(POLL_NORMAL_MS);
  }
}

function schedulePoll(ms) {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) poll();
});

// Start polling and ticking
poll();
tickTimer = setInterval(tick, TICK_MS);
