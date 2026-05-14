// Generic step-publishable HTML dashboard widget.
// Shows /repos/:repoId/dashboard in a collapsible panel when .sparkflow/dashboard.html exists.
// Polls the active repo's dashboard endpoint every 2s; reloads the iframe when content changes.

const POLL_MS = 2000;
const STORAGE_KEY = `sparkflow.dashboard.expanded.${location.port}`;

let expanded = loadExpanded();
let available = false;
let lastEtag = null;
let pollTimer = null;

function loadExpanded() {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

function saveExpanded(val) {
  try { localStorage.setItem(STORAGE_KEY, String(val)); } catch {}
}

// -- Build widget DOM --

const widget = document.createElement("div");
widget.className = "dw";
widget.style.display = "none";

const header = document.createElement("button");
header.className = "dw-header";
header.setAttribute("aria-expanded", "false");

const chevron = document.createElement("span");
chevron.className = "dw-chevron";

const label = document.createElement("span");
label.className = "dw-label";
label.textContent = "Dashboard";

header.appendChild(chevron);
header.appendChild(label);

const body = document.createElement("div");
body.className = "dw-body";

const iframe = document.createElement("iframe");
iframe.className = "dw-iframe";
iframe.setAttribute("title", "Live dashboard");
iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");

body.appendChild(iframe);
widget.appendChild(header);
widget.appendChild(body);
document.body.appendChild(widget);

// -- Toggle --

header.addEventListener("click", () => {
  expanded = !expanded;
  saveExpanded(expanded);
  apply();
});

header.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && expanded) {
    expanded = false;
    saveExpanded(false);
    apply();
  }
});

function apply() {
  widget.classList.toggle("dw--expanded", expanded);
  header.setAttribute("aria-expanded", String(expanded));
}

apply();

// -- Repo tracking --

const repoFilterEl = document.getElementById("repo-filter");

function currentDashboardUrl() {
  const repoId = repoFilterEl ? repoFilterEl.value : null;
  if (!repoId) return null;
  return `/repos/${encodeURIComponent(repoId)}/dashboard`;
}

function resetWidget() {
  available = false;
  lastEtag = null;
  widget.style.display = "none";
}

if (repoFilterEl) {
  repoFilterEl.addEventListener("change", () => {
    resetWidget();
    if (pollTimer !== null) clearTimeout(pollTimer);
    poll();
  });
}

// -- Polling --

async function poll() {
  if (document.hidden) return;
  const url = currentDashboardUrl();
  if (!url) {
    pollTimer = setTimeout(poll, POLL_MS);
    return;
  }
  try {
    const res = await fetch(url, { method: "GET" });
    if (res.ok) {
      const etag = res.headers.get("etag") ?? res.headers.get("last-modified") ?? String(Date.now());
      if (!available) {
        // First time dashboard appeared: load iframe
        available = true;
        widget.style.display = "";
        iframe.src = url + "?" + Date.now();
        lastEtag = etag;
      } else if (etag !== lastEtag) {
        // Content changed: reload iframe to pick up new HTML
        lastEtag = etag;
        iframe.src = url + "?" + Date.now();
      }
    } else {
      available = false;
      widget.style.display = "none";
    }
  } catch {
    // Network error — keep current state
  }
  pollTimer = setTimeout(poll, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (pollTimer !== null) clearTimeout(pollTimer);
    poll();
  }
});

poll();
