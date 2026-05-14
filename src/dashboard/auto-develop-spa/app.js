/* auto-develop SPA — vanilla JS, no build step */
(function () {
  "use strict";

  // Derived from the current URL: /repos/:repoId/dashboard
  const BASE = window.location.pathname.replace(/\/$/, "");
  // BASE is already /repos/:repoId/dashboard
  const STATE_URL = BASE + "/state";
  const EVENTS_URL = BASE + "/events";

  // Section collapse state persisted in sessionStorage
  const COLLAPSE_KEY = "sf-dash-collapsed-sections";
  function getCollapsed() {
    try { return new Set(JSON.parse(sessionStorage.getItem(COLLAPSE_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function setCollapsed(s) {
    try { sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])); } catch {}
  }

  let state = null;
  let jobStates = {}; // jobId -> { label, at }
  let liveJobs = {}; // currentJobId -> { badge, interval }
  let sseStatus = "connecting";
  let collapsed = getCollapsed();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(isoStr) {
    const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diff < 60) return diff + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    return Math.floor(diff / 3600) + "h ago";
  }

  function elapsed(isoStr) {
    const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
    if (diff < 60) return diff + "s";
    if (diff < 3600) return Math.floor(diff / 60) + "m " + (diff % 60) + "s";
    return Math.floor(diff / 3600) + "h " + Math.floor((diff % 3600) / 60) + "m";
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    const root = document.getElementById("root");
    if (!root) return;
    if (!state) {
      root.innerHTML = '<div class="no-roadmap">Loading…</div>';
      return;
    }

    const { sections, summary, recent, updatedAt } = state;
    const allTasks = sections.flatMap((s) => s.tasks);

    // Collect pinned tasks (in_progress and blocked)
    const pinned = allTasks.filter((t) => t.status === "in_progress" || t.status === "blocked");

    let html = "";

    // Progress bar
    const pct = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
    html += `<div class="progress-bar"><div class="progress-bar__fill" style="width:${pct}%"></div></div>`;
    html += `<div class="progress-label"><span>${summary.done} / ${summary.total} done</span><span>${summary.blocked} blocked &middot; ${summary.in_progress} active</span></div>`;

    // Recent activity (up to 3)
    if (recent && recent.length > 0) {
      html += '<div class="recent"><div class="recent__title">Recent</div>';
      for (const r of recent.slice(0, 3)) {
        html += `<div class="recent__item"><span class="recent__dot recent__dot--${esc(r.event)}"></span><span class="recent__text">${esc(r.task)}</span><span class="recent__time">${relTime(r.at)}</span></div>`;
      }
      html += "</div>";
    }

    // Active / Blocked pinned panel
    if (pinned.length > 0) {
      html += '<div class="pinned-panel"><div class="pinned-panel__header">Active &amp; Blocked</div>';
      for (const t of pinned) {
        const glyph = t.status === "in_progress" ? "▶" : "⊘";
        const badge = t.currentJobId && jobStates[t.currentJobId]
          ? ` <span class="pinned-task__badge">${esc(jobStates[t.currentJobId])}</span>`
          : "";
        const reason = t.blockedReason
          ? `<div class="pinned-task__reason">${esc(t.blockedReason)}</div>`
          : "";
        html += `<div class="pinned-task pinned-task--${esc(t.status)}"><div class="pinned-task__row"><span class="pinned-task__glyph">${glyph}</span><span class="pinned-task__text">${esc(t.text)}</span>${badge}</div>${reason}</div>`;
      }
      html += "</div>";
    }

    // Sections
    for (const section of sections) {
      const sectionKey = section.title ?? "__top__";
      const isCollapsed = collapsed.has(sectionKey);
      const allDone = section.tasks.length > 0 && section.tasks.every((t) => t.status === "done");

      if (section.title !== null) {
        const doneCnt = section.tasks.filter((t) => t.status === "done").length;
        html += `<div class="section ${isCollapsed || allDone ? "section--collapsed" : ""}" data-section="${esc(sectionKey)}">`;
        html += `<div class="section__header" data-toggle="${esc(sectionKey)}"><span class="section__chevron">▼</span><span class="section__title">${esc(section.title)}</span><span class="section__count">${doneCnt}/${section.tasks.length}</span></div>`;
      } else {
        html += `<div class="section" data-section="${esc(sectionKey)}">`;
      }

      html += '<ul class="section__tasks tasks">';
      for (const t of section.tasks) {
        const glyph = t.status === "done" ? "✓" : t.status === "blocked" ? "⊘" : t.status === "in_progress" ? "▶" : "○";
        const badge = t.currentJobId && jobStates[t.currentJobId]
          ? `<span class="task__badge">${esc(jobStates[t.currentJobId])}</span>`
          : "";
        const reason = t.blockedReason
          ? `<div class="task__reason">${esc(t.blockedReason)}</div>`
          : "";
        html += `<li class="task task--${esc(t.status)}"><div class="task__row"><span class="task__glyph">${glyph}</span><span class="task__text">${esc(t.text)}</span>${badge}</div>${reason}</li>`;
      }
      html += "</ul></div>";
    }

    if (sections.length === 0) {
      html += '<div class="no-roadmap">No ROADMAP.md found.</div>';
    }

    // Footer
    const ts = updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    const statusClass = sseStatus === "live" ? "footer__status--live" : "footer__status--offline";
    const statusLabel = sseStatus === "live" ? "● live" : sseStatus === "connecting" ? "○ connecting" : "○ offline";
    html += `<div class="footer"><span>updated ${ts}</span><span class="footer__status ${statusClass}">${statusLabel}</span></div>`;

    root.innerHTML = html;

    // Attach section toggle handlers
    root.querySelectorAll("[data-toggle]").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.getAttribute("data-toggle");
        if (collapsed.has(key)) collapsed.delete(key);
        else collapsed.add(key);
        setCollapsed(collapsed);
        render();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Job event handling
  // -------------------------------------------------------------------------

  function handleJobEvent(payload) {
    try {
      const job = JSON.parse(payload);
      if (!job || !job.id) return;
      const jobId = job.id;

      if (job.state === "running" && job.currentStep) {
        jobStates[jobId] = "running";
      } else if (job.state === "succeeded") {
        jobStates[jobId] = "done";
        setTimeout(() => { delete jobStates[jobId]; render(); }, 5000);
      } else if (job.state === "failed" || job.state === "failed_waiting") {
        jobStates[jobId] = "failed";
      } else {
        delete jobStates[jobId];
      }
    } catch {}
    render();
  }

  // -------------------------------------------------------------------------
  // SSE connection
  // -------------------------------------------------------------------------

  let sse = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;

  function connectSSE() {
    if (sse) { try { sse.close(); } catch {} sse = null; }
    sseStatus = "connecting";

    // Pass auth token from cookie if present (server requires it)
    const src = new EventSource(EVENTS_URL);
    sse = src;

    src.addEventListener("state", (e) => {
      try {
        state = JSON.parse(e.data);
        reconnectDelay = 1000;
        sseStatus = "live";
      } catch {}
      render();
    });

    src.addEventListener("job", (e) => {
      handleJobEvent(e.data);
    });

    src.onopen = () => {
      sseStatus = "live";
      render();
    };

    src.onerror = () => {
      sseStatus = "offline";
      render();
      try { src.close(); } catch {}
      sse = null;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectSSE();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  }

  // -------------------------------------------------------------------------
  // Initial load + SSE
  // -------------------------------------------------------------------------

  async function init() {
    try {
      const res = await fetch(STATE_URL);
      if (res.ok) {
        state = await res.json();
        render();
      }
    } catch {}
    connectSSE();
  }

  document.addEventListener("DOMContentLoaded", () => {
    render();
    init();
  });

})();
