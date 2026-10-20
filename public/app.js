(function () {
  "use strict";

  var PRIORITY_LABELS = { new: "Neuer Lead", evening_retry: "Abendversuch", follow_up: "Nachfassen" };
  var READY_TITLE = "Bereit, wenn du es bist";
  var READY_TEXT = "Hol dir einen Lead, um loszulegen. Er bleibt für dich reserviert, bis du den nächsten anforderst.";
  var STATS_INTERVAL_MS = 60 * 1000;

  var slot = document.getElementById("slot");
  var queueEl = document.getElementById("queue");
  var whoEl = document.getElementById("who");
  var noticeEl = document.getElementById("notice");
  var nextBtn = document.getElementById("next");
  var skipBtn = document.getElementById("skip");
  var inactiveBtn = document.getElementById("inactive");
  var logoutBtn = document.getElementById("logout");
  /** Cloudflare Access ends the login for all Access apps and deletes the cookie here. */
  var LOGOUT_URL = "/cdn-cgi/access/logout";

  /** The rep's reserved lead: { lead, lease } from the API, or null. */
  var current = null;
  var busy = false;
  var ticker = null;
  var returning = false;

  // --- API ------------------------------------------------------------------------------

  async function api(path, body) {
    var options = { method: body === undefined ? "GET" : "POST", credentials: "same-origin" };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
      options.body = JSON.stringify(body);
    }
    var response;
    try {
      response = await fetch("/api" + path, options);
    } catch (e) {
      // An expired Access session redirects to the login page, which fetch can't follow.
      var offline = new Error("Keine Verbindung, oder dein Login ist abgelaufen. Lade die Seite neu.");
      offline.status = 0;
      throw offline;
    }
    var data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      var error = new Error((data && data.detail) || "Anfrage fehlgeschlagen (HTTP " + response.status + ").");
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // --- rendering ------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) +
      ", " + d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  }

  function relative(iso) {
    var minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "gerade eben";
    if (minutes < 60) return "vor " + minutes + (minutes === 1 ? " Minute" : " Minuten");
    var hours = Math.round(minutes / 60);
    if (hours < 24) return "vor " + hours + (hours === 1 ? " Stunde" : " Stunden");
    var days = Math.round(hours / 24);
    return "vor " + days + (days === 1 ? " Tag" : " Tagen");
  }

  function countdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function renderStats(stats) {
    if (!stats) return;
    var fresh = (stats.by_priority && stats.by_priority.new) || 0;
    var parts = [
      stats.available + (stats.available === 1 ? " Lead" : " Leads"),
      fresh + (fresh === 1 ? " neuer Lead" : " neue Leads"),
      stats.active_reps + (stats.active_reps === 1 ? " Rep aktiv" : " Reps aktiv"),
    ];
    queueEl.textContent = parts.join(" · ");
  }

  function renderLead(data) {
    var lead = data.lead;
    var name = lead.name || "Kontakt ohne Namen";
    var pips = el("div", { class: "pips", "aria-hidden": "true" });
    for (var i = 0; i < lead.max_calls; i++) {
      pips.appendChild(el("span", { class: "pip" + (i < lead.call_count ? " on" : "") }));
    }
    var lastContacted = lead.last_contacted_at
      ? el("dd", null, [document.createTextNode(fmtDate(lead.last_contacted_at)), el("small", { text: relative(lead.last_contacted_at) })])
      : el("dd", { text: "Nie" });

    var card = el("a", {
      class: "card",
      href: lead.hubspot_url,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": name + " in HubSpot öffnen",
    }, [
      el("div", { class: "meta" }, [
        el("span", { class: "badge", text: PRIORITY_LABELS[lead.priority] || lead.priority }),
        el("span", { class: "stage", text: lead.stage }),
      ]),
      el("h1", { class: "name", text: name }),
      el("dl", { class: "facts" }, [
        el("div", null, [el("dt", { text: "Anrufe" }), el("dd", { text: lead.call_count + " von " + lead.max_calls }), pips]),
        el("div", null, [el("dt", { text: "PLZ" }), el("dd", { text: lead.zip || "Keine Angabe" })]),
        el("div", { class: "wide" }, [el("dt", { text: "Zuletzt kontaktiert" }), lastContacted]),
      ]),
      el("div", { class: "open-hint" }, [
        el("span", { text: "Kontakt in HubSpot öffnen" }),
        el("span", { id: "countdown" }),
      ]),
    ]);
    slot.replaceChildren(card);
    if (data.stale) showNotice("HubSpot hat nicht geantwortet, die Angaben sind evtl. nicht aktuell.", false);
    else hideNotice();
  }

  function renderState(title, text, isError) {
    slot.replaceChildren(el("div", { class: "card" }, [
      el("h1", { class: "state-title", text: title }),
      el("p", { class: "state-text" + (isError ? " error" : ""), text: text }),
    ]));
  }

  function showNotice(text, isError, action) {
    noticeEl.replaceChildren(el("span", { text: text }), action || null);
    noticeEl.className = "notice" + (isError ? " error" : "");
    noticeEl.hidden = false;
  }

  function hideNotice() {
    noticeEl.hidden = true;
    noticeEl.replaceChildren();
  }

  function setHolding(holding) {
    skipBtn.hidden = !holding;
    inactiveBtn.hidden = !holding;
    nextBtn.textContent = holding ? "Nächster Lead" : "Lead holen";
  }

  // --- lease timer ----------------------------------------------------------------------

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = null;
  }

  function startTicker() {
    stopTicker();
    tick();
    ticker = setInterval(tick, 1000);
  }

  function tick() {
    if (!current) return stopTicker();
    var now = Date.now();
    var warnAt = new Date(current.lease.warn_at).getTime();
    var returnAt = new Date(current.lease.return_at).getTime();
    var label = document.getElementById("countdown");
    if (label) label.textContent = "Für dich reserviert · " + countdown(returnAt - now);

    if (now >= returnAt) {
      returnLead("timeout");
    } else if (now >= warnAt && noticeEl.dataset.kind !== "warn") {
      var keep = el("button", { type: "button", class: "small", text: "Behalten" });
      keep.addEventListener("click", keepLead);
      showNotice("Noch dran? Der Lead geht gleich zurück in die Warteschlange.", false, keep);
      noticeEl.dataset.kind = "warn";
    }
  }

  // --- actions --------------------------------------------------------------------------

  function show(data) {
    noticeEl.dataset.kind = "";
    renderStats(data.queue);
    if (data.lead) {
      current = { lead: data.lead, lease: data.lease };
      setHolding(true);
      renderLead(data);
      startTicker();
    } else {
      current = null;
      stopTicker();
      setHolding(false);
      hideNotice();
      renderState("Gerade keine Leads", "Alle anrufbaren Leads sind vergeben oder wurden kürzlich angerufen. Versuch es gleich noch einmal.", false);
    }
  }

  function fail(error) {
    if (error.status === 409) {
      // The reservation is gone (expired, or released from another tab).
      current = null;
      stopTicker();
      setHolding(false);
      hideNotice();
      renderState("Lead zurück in der Warteschlange", "Dieser Lead ist nicht mehr für dich reserviert. Hol dir einen neuen.", false);
      return;
    }
    showNotice(error.message, true);
  }

  async function nextLead(outcome) {
    if (busy) return;
    busy = true;
    nextBtn.disabled = skipBtn.disabled = true;
    try {
      show(await api("/next", { previous_outcome: outcome }));
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
      nextBtn.disabled = skipBtn.disabled = false;
    }
  }

  async function keepLead() {
    if (!current || busy) return;
    busy = true;
    try {
      show(await api("/leads/" + current.lead.lead_id + "/extend", {}));
    } catch (error) {
      fail(error);
    } finally {
      busy = false;
    }
  }

  async function returnLead(reason) {
    if (!current || returning) return;
    returning = true;
    var leadId = current.lead.lead_id;
    current = null;
    stopTicker();
    setHolding(false);
    hideNotice();
    renderState("Lead zurück in der Warteschlange", "Du hast eine Weile keinen neuen Lead angefordert, deshalb ging dieser zurück in die Warteschlange.", false);
    try {
      await api("/leads/" + leadId + "/release", { reason: reason });
      refreshStats();
    } catch (_) {
      // The server frees it on its own a little later.
    } finally {
      returning = false;
    }
  }

  /** "Inaktiv": return the lead (with cooldown, the rep may have called) and stop. */
  async function goInactive() {
    if (busy) return;
    busy = true;
    var leadId = current && current.lead.lead_id;
    current = null;
    stopTicker();
    setHolding(false);
    hideNotice();
    renderState(READY_TITLE, READY_TEXT, false);
    try {
      if (leadId) await api("/leads/" + leadId + "/release", { reason: "done" });
      refreshStats();
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      busy = false;
    }
  }

  /** "Logout": return the lead like "Inaktiv" does, then end the Access login. */
  async function logout() {
    logoutBtn.disabled = true;
    var leadId = current && current.lead.lead_id;
    current = null; // no "tab closed" release on the way out
    stopTicker();
    if (leadId) {
      try {
        await Promise.race([
          api("/leads/" + leadId + "/release", { reason: "done" }),
          new Promise(function (resolve) { setTimeout(resolve, 3000); }),
        ]);
      } catch (_) {
        // The server frees it on its own a little later.
      }
    }
    window.location.href = LOGOUT_URL;
  }

  async function refreshStats() {
    try { renderStats(await api("/stats")); } catch (_) {}
  }

  async function syncWithServer() {
    try {
      var data = await api("/me");
      if (data.lead) show(data);
      else if (current) fail({ status: 409 });
      else renderStats(data.queue);
    } catch (_) {}
  }

  // --- start ----------------------------------------------------------------------------

  nextBtn.addEventListener("click", function () { nextLead("done"); });
  skipBtn.addEventListener("click", function () { nextLead("skipped"); });
  inactiveBtn.addEventListener("click", goInactive);
  logoutBtn.addEventListener("click", logout);

  // Closing the tab returns the lead (held back for the cooldown, the rep may have called).
  window.addEventListener("pagehide", function () {
    if (!current) return;
    var body = new Blob([JSON.stringify({ reason: "unload" })], { type: "application/json" });
    navigator.sendBeacon("/api/leads/" + current.lead.lead_id + "/release", body);
  });

  // Timers are throttled in background tabs; re-check with the server when coming back.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") syncWithServer();
  });

  setInterval(function () { if (!busy) refreshStats(); }, STATS_INTERVAL_MS);

  (async function start() {
    try {
      var session = await api("/session");
      whoEl.textContent = session.email;
      logoutBtn.hidden = false;
      var data = await api("/me");
      if (data.lead) {
        show(data);
      } else {
        renderStats(data.queue);
        setHolding(false);
        renderState(READY_TITLE, READY_TEXT, false);
      }
    } catch (error) {
      renderState("Lead-Warteschlange konnte nicht geladen werden", error.message, true);
    } finally {
      nextBtn.disabled = false;
    }
  })();
})();
