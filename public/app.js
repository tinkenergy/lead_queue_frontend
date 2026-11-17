// tink Lead-Queue: the calling page for sales reps.
//
// A thin client of the lead queue v2 API (reonic-sync-api, proxied by the Worker under
// /api). Every action answers with the rep's whole state; the page only draws it, counts
// down and formats times. Design: the tink Lead-Queue design system (tokens.css, tl.css).
(function () {
  "use strict";

  var LOGOUT_URL = "/cdn-cgi/access/logout";
  var TZ = "Europe/Berlin";
  var GROUPS = [
    { key: "new_leads", label: "Neuer Lead", cls: "new" },
    { key: "evening_retry", label: "Abendversuch", cls: "evening" },
    { key: "reachable", label: "Derzeit erreichbar", cls: "reach" },
    { key: "hot_leads", label: "Heißer Lead", cls: "hot" },
    { key: "backlog", label: "Altbestand", cls: "backlog" },
    { key: "called_today", label: "Heute angerufen", cls: "called" },
  ];
  var TASK_TYPES = { CALL: "Anruf", EMAIL: "E-Mail", TODO: "Aufgabe", SMS: "SMS", LINKED_IN: "LinkedIn", MEETING: "Termin" };
  var AGE_PRESETS = [
    { label: "bis 3 Tage", from: null, to: 3 },
    { label: "> 7 Tage", from: 8, to: null },
    { label: "> 14 Tage", from: 15, to: null },
    { label: "> 30 Tage", from: 31, to: null },
  ];

  var ICON = {
    link: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/></svg>',
    mail: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="M2 4l6 5 6-5"/></svg>',
    calendar: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 7h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
    repeat: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9l1.6 1.4M13.5 2.5v3h-3M13.5 8a5.5 5.5 0 0 1-9.4 3.9l-1.6-1.4M2.5 13.5v-3h3"/></svg>',
    people: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5"/><path d="M1.5 13.5c.6-2.3 2.3-3.5 4.5-3.5s3.9 1.2 4.5 3.5"/><path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 10.2c1.3.5 2.1 1.6 2.5 3.3"/></svg>',
    clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 1.5"/></svg>',
    caret: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>',
    filter: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 3.5h12M4.5 8h7M7 12.5h2"/></svg>',
    phone: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3.5 2h2.6l1.2 3-1.6 1.1a8 8 0 0 0 4.2 4.2L11 8.7l3 1.2v2.6c0 .8-.7 1.5-1.5 1.5A11 11 0 0 1 2 3.5C2 2.7 2.7 2 3.5 2z"/></svg>',
  };

  // --- state --------------------------------------------------------------------------------

  var S = {
    state: null, // the last LeadQueueState (or merged pulse)
    settings: null, // from GET /state
    email: "",
    loading: true,
    busy: false,
    unavailable: false,
    lastCheck: null,
    alerts: [], // [{ text, retry }]
    notice: null, // { text, until }
    toast: null, // { name, leadId, until }
    reminder: null, // { data, after }
    doneAt: {}, // task id -> time ticked during this reservation
    pendingTasks: {},
    errorTasks: {},
    leadId: null,
    panel: null, // open filter panel: groups|sources|calls|age
    draft: null, // filters being edited
    ageTab: "days",
    weekPick: null,
    sourceQuery: "",
    preview: null,
    menuOpen: false,
    expiring: false,
  };

  var $ = function (id) { return document.getElementById(id); };

  // --- helpers --------------------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "html") node.innerHTML = value; // trusted constants only (icons)
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    });
    return node;
  }
  function icon(name) { var span = el("span", { html: ICON[name] }); return span.firstChild; }
  function fill(node, children) { node.replaceChildren.apply(node, children.filter(Boolean)); }

  var fmt = {
    time: function (d) { return new Date(d).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: TZ }); },
    day: function (d) { return new Date(d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: TZ }).replace(".,", ","); },
    dayYear: function (d) { return new Date(d).toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", timeZone: TZ }).replace(".,", ","); },
    dateKey: function (d) { return new Date(d).toLocaleDateString("sv-SE", { timeZone: TZ }); },
    hour: function (d) { return parseInt(new Date(d).toLocaleString("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }), 10); },
  };
  function shortDay(d) { // "Fr, 13.11."
    return fmt.day(d).replace(/^(\w+)\.?,?\s*/, "$1, ");
  }
  function isToday(d) { return fmt.dateKey(d) === fmt.dateKey(Date.now()); }
  function dayLabel(d) { return isToday(d) ? "Heute, " + shortDay(d).split(", ")[1] : shortDay(d); }
  function countdown(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60), s = total % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function inMinutes(ms) {
    var minutes = Math.max(0, Math.round(ms / 60000));
    if (minutes < 60) return "in " + minutes + " Min";
    var h = Math.floor(minutes / 60), m = minutes % 60;
    return "in " + h + " Std" + (m ? " " + m + " Min" : "");
  }
  function relative(iso) {
    var minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "gerade eben";
    if (minutes < 60) return "vor " + minutes + " Min";
    var hours = Math.round(minutes / 60);
    if (hours < 24) return "vor " + hours + (hours === 1 ? " Stunde" : " Stunden");
    var days = Math.round(hours / 24);
    return "vor " + days + (days === 1 ? " Tag" : " Tagen");
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  function group(key) { return GROUPS.filter(function (g) { return g.key === key; })[0]; }
  function settings() { return S.settings || {}; }
  function maxCalls() { return settings().max_calls || 4; }
  function reminderSteps() {
    var map = {};
    (settings().mail_reminders || []).forEach(function (s) { map[s.call_number] = s.mail_name; });
    return map;
  }
  function sourceLabel(value) {
    if (value === null) return "Ohne Quelle";
    var option = (settings().lead_sources || []).filter(function (o) { return o.value === value; })[0];
    return option ? option.label : value;
  }
  function lead() { return S.state && S.state.lead; }
  function reservation() { return S.state && S.state.reservation; }
  function status() { return (S.state && S.state.status) || {}; }
  function filters() { return (S.state && S.state.filters) || { groups: [], min_unreached_calls: null, age: null, sources: [] }; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }

  // --- API ------------------------------------------------------------------------------------

  function api(method, path, body) {
    var options = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch("/api" + path, options).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) {}
        if (!response.ok) {
          var error = new Error((data && data.detail) || "Anfrage fehlgeschlagen (HTTP " + response.status + ").");
          error.status = response.status;
          error.code = data && data.code;
          throw error;
        }
        S.lastCheck = new Date();
        return data;
      });
    }, function () {
      // An expired Access login redirects to Google, which fetch can't follow.
      var offline = new Error("Keine Verbindung, oder dein Login ist abgelaufen. Lade die Seite neu.");
      offline.status = 0;
      throw offline;
    });
  }

  /** Runs one rep action: busy while it runs, its answer replaces the state, a failure
   *  becomes an alert naming the action with "Nochmal versuchen". */
  function act(label, method, path, body, options) {
    options = options || {};
    if (S.busy && !options.background) return Promise.resolve(null);
    if (!options.background) { S.busy = true; render(); }
    var before = S.state;
    return api(method, path, body).then(function (data) {
      S.busy = false;
      S.unavailable = false;
      if (options.apply !== false && data) applyState(data, before, options);
      if (options.then) options.then(data);
      render();
      return data;
    }, function (error) {
      S.busy = false;
      handleError(error, label, function () { return act(label, method, path, body, options); }, options);
      render();
      return null;
    });
  }

  function handleError(error, label, retry, options) {
    if (error.status === 404 && !error.code) { S.unavailable = true; return; }
    if (options && options.onCode && options.onCode[error.code]) { options.onCode[error.code](error); return; }
    if (error.code === "not_reserved" || error.code === "paused") { loadState(); return; }
    S.alerts = [{ text: label + " hat nicht geklappt. " + (error.status === 0 ? error.message : ""), retry: retry }];
  }

  function applyState(data, before, options) {
    if (data.settings) S.settings = data.settings;
    var previousLead = before && before.lead;
    S.state = data;
    S.alerts = [];
    var current = data.lead ? data.lead.lead_id : null;
    if (current !== S.leadId) { S.doneAt = {}; S.pendingTasks = {}; S.errorTasks = {}; S.leadId = current; S.expiring = false; }
    if (data.undo && options && options.undoName !== undefined) {
      S.toast = { name: options.undoName, leadId: data.undo.lead_id, until: Math.min(new Date(data.undo.until).getTime(), Date.now() + (settings().undo_seconds || 5) * 1000) };
    }
    if (data.mail_reminder) S.reminder = { data: data.mail_reminder, after: (options && options.afterReminder) || "next" };
    if (data.reservation && data.reservation.just_extended && options && options.extendNotice) {
      S.notice = { text: options.extendNotice, until: Date.now() + 6000 };
    }
    void previousLead;
  }

  function loadState() {
    return api("GET", "/state").then(function (data) {
      S.loading = false;
      S.unavailable = false;
      applyState(data, S.state, {});
      render();
    }, function (error) {
      S.loading = false;
      handleError(error, "Laden", loadState);
      render();
    });
  }

  function loadPulse() {
    return api("GET", "/pulse").then(function (pulse) {
      if (!S.state) return;
      var held = S.state.reservation && S.state.reservation.lead_id;
      var now = pulse.reservation && pulse.reservation.lead_id;
      if (held !== now) return loadState(); // another tab changed the reservation
      S.state.queue = pulse.queue;
      S.state.stats = pulse.stats;
      S.state.callbacks = pulse.callbacks;
      S.state.status = pulse.status;
      S.state.reservation = pulse.reservation;
      render();
    }, function (error) {
      if (error.status === 404 && !error.code) { S.unavailable = true; render(); }
    });
  }

  function loadMeetings() {
    return api("GET", "/meetings").then(function (section) {
      if (S.state) { S.state.meetings = section; renderToday(); }
    }, function () {});
  }

  // --- rep actions ------------------------------------------------------------------------------

  function takeLead() { return act("Nächster Lead konnte nicht geladen werden. Lead holen", "POST", "/lead"); }
  function finish(pause) {
    var current = lead();
    if (!current) return;
    S.toast = null;
    return act(pause ? "Erledigt, Pause bis Termin" : "Erledigt", "POST", "/lead/done", { lead_id: current.lead_id, pause: !!pause }, {
      undoName: current.name || "Lead",
      afterReminder: pause ? "close" : "next",
    });
  }
  function skip() {
    var current = lead();
    if (current) return act("Überspringen", "POST", "/lead/skip", { lead_id: current.lead_id });
  }
  function keep(reason) {
    var current = lead();
    if (!current) return;
    return act("Verlängern", "POST", "/lead/extend", { lead_id: current.lead_id, reason: reason || "keep" }, {
      background: reason === "hubspot_opened",
      extendNotice: reason === "hubspot_opened" ? "HubSpot geöffnet, Zeit verlängert" : null,
    });
  }
  function expire() {
    var current = lead();
    if (!current || S.expiring) return;
    S.expiring = true;
    return act("Rückgabe", "POST", "/lead/expire", { lead_id: current.lead_id }, { background: true });
  }
  function reclaim(leadId) {
    var taken = function () {
      S.alerts = [{ text: "Zu spät: Jemand anderes hat den Lead jetzt.", retry: null }];
      loadState();
    };
    return act("Zurückholen", "POST", "/lead/reclaim", { lead_id: leadId }, { onCode: { taken: taken, gone: taken } });
  }
  function undo() {
    var toast = S.toast;
    if (!toast) return;
    S.toast = null;
    S.reminder = null;
    return act("Rückgängig", "POST", "/lead/undo", { lead_id: toast.leadId }, {
      onCode: { undo_closed: function () {}, gone: function () { S.alerts = [{ text: "Der Lead ist nicht mehr in der Warteschlange.", retry: null }]; } },
    });
  }
  function pause() { S.toast = null; return act("Pause", "POST", "/pause", undefined, { afterReminder: "close" }); }
  function resume() { return act("Weitermachen", "POST", "/resume"); }
  function logout() {
    S.menuOpen = false;
    return act("Abmelden", "POST", "/logout", undefined, {
      afterReminder: "logout",
      then: function (data) { if (!data || !data.mail_reminder) window.location.href = LOGOUT_URL; },
    });
  }
  function resetSkips() {
    S.menuOpen = false;
    return api("POST", "/skips/reset").then(function (data) {
      S.notice = { text: data.reset ? plural(data.reset, "übersprungener Lead ist", "übersprungene Leads sind") + " wieder da." : "Keine übersprungenen Leads.", until: Date.now() + 6000 };
      return loadPulse();
    }, function (error) { handleError(error, "Übersprungene zurückholen", resetSkips); render(); });
  }
  function closeReminder() {
    var after = S.reminder ? S.reminder.after : "close";
    S.reminder = null;
    render();
    if (after === "next") takeLead();
    if (after === "logout") window.location.href = LOGOUT_URL;
  }

  function toggleTask(task) {
    var done = !task.done;
    S.pendingTasks[task.task_id] = true;
    delete S.errorTasks[task.task_id];
    renderTasks();
    api("PATCH", "/tasks/" + encodeURIComponent(task.task_id), { done: done }).then(function (updated) {
      delete S.pendingTasks[task.task_id];
      if (done) S.doneAt[task.task_id] = new Date(); else delete S.doneAt[task.task_id];
      var tasks = S.state && S.state.tasks && S.state.tasks.data;
      (tasks || []).forEach(function (t) { if (t.task_id === updated.task_id) { t.done = updated.done; t.overdue = updated.overdue; } });
      renderTasks();
    }, function (error) {
      delete S.pendingTasks[task.task_id];
      if (error.code === "not_reserved") { loadState(); return; }
      S.errorTasks[task.task_id] = true;
      renderTasks();
    });
  }

  // --- filters ----------------------------------------------------------------------------------

  var previewTimer = null;
  function openPanel(name) {
    S.panel = S.panel === name ? null : name;
    S.draft = clone(filters());
    S.weekPick = null;
    S.sourceQuery = "";
    S.ageTab = S.draft.age && S.draft.age.unit === "weeks" ? "weeks" : "days";
    S.preview = null;
    renderFilters();
    if (S.panel) schedulePreview(0);
  }
  function closePanel() { S.panel = null; S.draft = null; S.preview = null; renderFilters(); }
  function schedulePreview(delay) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(function () {
      if (!S.draft) return;
      var draft = S.draft;
      api("POST", "/filters/preview", { filters: draft }).then(function (counts) {
        if (S.draft === draft) { S.preview = counts; renderFilters(); }
      }, function () {});
    }, delay === undefined ? 300 : delay);
  }
  function changeDraft(mutator) { mutator(S.draft); renderFilters(); schedulePreview(); }
  function saveFilters(next) {
    var held = lead();
    S.panel = null; S.draft = null; S.preview = null;
    return act("Filter übernehmen", "PUT", "/filters", { filters: next }, {
      background: true,
      then: function () {
        if (held) S.notice = { text: "Filter gilt ab dem nächsten Lead. " + (held.name || "Dein Lead") + " bleibt bei dir.", until: Date.now() + 6000 };
      },
    });
  }
  function clearFilters() { S.panel = null; return act("Filter zurücksetzen", "DELETE", "/filters", undefined, { background: true }); }
  function withoutDimension(f, dim) {
    var next = clone(f);
    if (dim === "groups") next.groups = [];
    if (dim === "sources") next.sources = [];
    if (dim === "min_unreached_calls") next.min_unreached_calls = null;
    if (dim === "age") next.age = null;
    return next;
  }
  function ageLabel(age) {
    if (!age) return null;
    if (age.unit === "weeks") {
      var a = age.from ? "KW " + Number(age.from.split("W")[1]) : null;
      var b = age.to ? "KW " + Number(age.to.split("W")[1]) : null;
      if (a && b) return a === b ? a : a + " bis " + Number(age.to.split("W")[1]);
      return a ? "ab " + a : "bis " + b;
    }
    if (age.from !== null && age.to !== null) return age.from + " bis " + age.to + " Tage";
    if (age.from !== null) return "> " + (age.from - 1) + " Tage";
    return "bis " + age.to + " Tage";
  }
  function chipLabel(dim, f) {
    if (dim === "groups" && f.groups.length) return "Gruppe: " + f.groups.map(function (k) { return group(k).label; }).join(", ");
    if (dim === "sources" && f.sources.length) {
      return "Quelle: " + (f.sources.length > 2 ? f.sources.length + " ausgewählt" : f.sources.map(sourceLabel).join(", "));
    }
    if (dim === "min_unreached_calls" && f.min_unreached_calls !== null) return "Anrufe: mind. " + f.min_unreached_calls;
    if (dim === "age" && f.age) return "Lead-Alter: " + ageLabel(f.age);
    return null;
  }

  function isoWeek(date) {
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    var year = d.getUTCFullYear();
    var week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
    return year + "-W" + (week < 10 ? "0" : "") + week;
  }
  function weekStart(key) {
    var parts = key.split("-W"), year = Number(parts[0]), week = Number(parts[1]);
    var jan4 = new Date(Date.UTC(year, 0, 4));
    var monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
    return new Date(monday.getTime() + (week - 1) * 7 * 86400000);
  }

  // --- rendering --------------------------------------------------------------------------------

  function render() {
    renderStats();
    renderHeader();
    renderFilters();
    renderAlerts();
    renderSlot();
    renderActions();
    renderTasks();
    renderToday();
    renderToast();
    renderModal();
    tick();
  }

  function renderStats() {
    var section = S.state && S.state.stats;
    var node = $("stats");
    if (!section) { fill(node, []); return; }
    if (section.status !== "ok") {
      fill(node, [el("div", { class: "tl-panel tl-muted", style: "font-size:14px" }, [
        section.status === "no_owner" ? "Kein Hubspot-Nutzer verknüpft." : "Tageszahlen gerade nicht verfügbar.",
      ])]);
      return;
    }
    var d = section.data;
    var meter = function (value, goal, sun, unit) {
      var pct = goal ? Math.min(100, Math.round((value / goal) * 100)) : 0;
      return el("div", { class: "tl-stat", style: "flex:1" }, [
        el("div", { class: "tl-stat__val" }, [el("b", { text: String(value) }), "von " + goal + " " + unit]),
        el("span", { class: "tl-meter" + (sun ? " tl-meter--sun" : "") }, [el("span", { style: "width:" + pct + "%" })]),
      ]);
    };
    fill(node, [el("div", { class: "tl-panel" }, [el("div", { class: "tl-stats", style: "gap:24px" }, [
      el("span", { class: "tl-muted", style: "font-size:13px;line-height:16px" }, ["Tagesziel", el("br"), el("b", { style: "color:var(--ink)", text: "Heute" })]),
      meter(d.calls, d.goals.calls, false, "Anrufen"),
      meter(d.qualified, d.goals.qualified, true, "Qualis"),
    ])])]);
  }

  function renderHeader() {
    var pauseBtn = $("pause");
    var paused = status().paused;
    pauseBtn.hidden = !S.state || S.unavailable || paused;
    pauseBtn.disabled = S.busy;
    pauseBtn.onclick = pause;
    // Reps online: a quiet hint left of Pause (queue.active_reps, refreshed with every pulse).
    var online = $("online");
    var reps = S.state && S.state.queue ? S.state.queue.active_reps : null;
    online.hidden = reps === null || reps === undefined || S.unavailable;
    if (!online.hidden) {
      fill(online, [icon("people"), reps + " online"]);
      online.title = reps === 1 && lead() ? "Nur du bist gerade aktiv" : (reps === 1 ? "1 Rep" : reps + " Reps") + " gerade aktiv" + (lead() ? ", du eingeschlossen" : "");
    }
    var user = $("user");
    fill(user, [S.email || "Angemeldet", icon("caret")]);
    user.setAttribute("aria-expanded", S.menuOpen ? "true" : "false");
    user.onclick = function (event) { event.stopPropagation(); S.menuOpen = !S.menuOpen; renderHeader(); };
    var menu = $("menu");
    menu.hidden = !S.menuOpen;
    fill(menu, [
      el("div", { class: "tl-menu__head" }, ["Angemeldet als", el("b", { text: S.email || "unbekannt" })]),
      el("button", { role: "menuitem", type: "button", onclick: resetSkips }, ["Übersprungene zurückholen", el("small", { text: "Zeigt Leads wieder, die du übersprungen hast" })]),
      el("button", { role: "menuitem", type: "button", onclick: showShortcuts }, ["Tastenkürzel"]),
      el("hr"),
      el("button", { role: "menuitem", type: "button", class: "danger", onclick: logout }, ["Abmelden", el("small", { text: "Gibt deinen aktuellen Lead zurück" })]),
    ]);
  }

  function renderFilters() {
    var node = $("filters");
    if (!S.state || S.unavailable) { fill(node, []); return; }
    var f = filters();
    var q = S.state.queue;
    var quick = function (label, key) {
      var pressed = f.groups.length === 1 && f.groups[0] === key;
      return el("button", { class: "tl-fchip tl-fchip--quick", type: "button", "aria-pressed": pressed ? "true" : "false",
        onclick: function () { var next = clone(f); next.groups = pressed ? [] : [key]; saveFilters(next); } }, [label]);
    };
    var chip = function (dim, name, panel) {
      var label = chipLabel(dim, f);
      var open = S.panel === panel;
      var button = label
        ? el("span", { class: "tl-fchip tl-fchip--on", role: "group" }, [
            el("button", { class: "tl-link", style: "font-weight:600", type: "button", "aria-haspopup": "dialog", "aria-expanded": open ? "true" : "false", onclick: function (e) { e.stopPropagation(); openPanel(panel); } }, [label]),
            el("button", { class: "tl-fchip__x", type: "button", "aria-label": "Filter " + name + " entfernen", onclick: function () { saveFilters(withoutDimension(f, dim)); } }, ["×"]),
          ])
        : el("button", { class: "tl-fchip", type: "button", "aria-haspopup": "dialog", "aria-expanded": open ? "true" : "false", onclick: function (e) { e.stopPropagation(); openPanel(panel); } }, [name, " ", icon("caret")]);
      return el("span", { class: "lq-chipwrap" }, [button, open ? renderPanel(panel) : null]);
    };
    var mixTitle = GROUPS.map(function (g) { return g.label + " " + (q.available_by_group[g.key] || 0); }).join(", ") +
      ". Dazu " + plural(q.cooling_down, "Lead", "Leads") + " in Abkühlung" + (q.scheduled ? ", " + q.scheduled + " geplant" : "") + ".";
    var active = f.groups.length || f.sources.length || f.min_unreached_calls !== null || f.age;
    fill(node, [el("div", { class: "tl-filters", role: "toolbar", "aria-label": "Filter" }, [
      quick("Jetzt erreichbar", "reachable"),
      quick("Heiße Leads", "hot_leads"),
      el("span", { class: "tl-filters__sep" }),
      el("span", { class: "tl-filters__label", title: "Filter", "aria-label": "Filter", html: ICON.filter }),
      chip("groups", "Gruppe", "groups"),
      chip("sources", "Quelle", "sources"),
      chip("min_unreached_calls", "Anrufe", "calls"),
      chip("age", "Lead-Alter", "age"),
      el("span", { class: "tl-filters__count" }, [
        el("div", { class: "tl-mix", role: "img", title: mixTitle, "aria-label": mixTitle }, GROUPS.map(function (g) {
          return el("span", { class: "g-" + g.cls, style: "flex:" + (q.available_by_group[g.key] || 0) });
        })),
        active
          ? el("span", null, [el("b", { text: String(q.matching_filters) }), " von " + plural(q.available, "Lead", "Leads")])
          : el("span", null, [el("b", { text: String(q.available) }), q.available === 1 ? " Lead" : " Leads"]),
        active ? el("button", { class: "tl-link", type: "button", onclick: clearFilters }, ["Zurücksetzen"]) : null,
      ]),
    ])]);
  }

  function panelFoot(clearDim) {
    var total = S.preview ? S.preview.total : null;
    return el("div", { class: "tl-pop__foot" }, [
      el("button", { class: "tl-link", type: "button", onclick: function () { changeDraft(function (d) { Object.assign(d, withoutDimension(d, clearDim)); }); } }, ["Zurücksetzen"]),
      el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: function () { saveFilters(S.draft); } },
        [total === null ? "Übernehmen" : plural(total, "Lead", "Leads") + " anzeigen"]),
    ]);
  }

  function renderPanel(name) {
    var d = S.draft, p = S.preview;
    var stop = function (e) { e.stopPropagation(); };
    if (name === "groups") {
      var total = p ? GROUPS.reduce(function (s, g) { return s + (p.by_group[g.key] || 0); }, 0) : "";
      var opt = function (key, label, count, cls, rank) {
        var checked = key === null ? d.groups.length === 0 : d.groups.length === 1 && d.groups[0] === key;
        return el("button", { class: "tl-opt", role: "radio", type: "button", "aria-checked": checked ? "true" : "false",
          onclick: function () { changeDraft(function (x) { x.groups = key ? [key] : []; }); } }, [
          el("span", { class: "radio" }),
          cls ? el("i", { class: "g-" + cls, style: "width:10px;height:10px;border-radius:3px" }) : el("span"),
          el("span", null, rank ? [el("span", { class: "rank", text: String(rank) }), "  " + label] : [label]),
          el("span", { class: "n", text: count === "" ? "" : String(count) }),
        ]);
      };
      return el("div", { class: "tl-pop", role: "dialog", "aria-label": "Filter Gruppe", onclick: stop }, [
        el("h4", { class: "tl-pop__title" }, ["Gruppe ", el("small", { text: "in Reihenfolge der Warteschlange" })]),
        el("div", { class: "tl-opts", role: "radiogroup" }, [opt(null, "Alle Gruppen", total)].concat(GROUPS.map(function (g, i) {
          return opt(g.key, g.label, p ? p.by_group[g.key] || 0 : "", g.cls, i + 1);
        }))),
        panelFoot("groups"),
      ]);
    }
    if (name === "sources") {
      var counts = {};
      (p ? p.by_source : []).forEach(function (s) { counts[s.value === null ? "__none__" : s.value] = s.count; });
      var options = (settings().lead_sources || []).map(function (o) { return { value: o.value, label: o.label }; });
      options.push({ value: null, label: "Ohne Quelle" });
      // Once the counts are in, sources without leads are left out (unless selected, so they can be unticked).
      if (p) options = options.filter(function (o) { return counts[o.value === null ? "__none__" : o.value] || d.sources.indexOf(o.value) >= 0; });
      options.sort(function (a, b) { return (counts[b.value === null ? "__none__" : b.value] || 0) - (counts[a.value === null ? "__none__" : a.value] || 0); });
      var query = S.sourceQuery.toLowerCase();
      var shown = options.filter(function (o) { return !query || (o.label || "").toLowerCase().indexOf(query) >= 0; });
      return el("div", { class: "tl-pop", role: "dialog", "aria-label": "Filter Quelle", onclick: stop }, [
        el("h4", { class: "tl-pop__title" }, ["Lead-Quelle ", el("small", { text: "mehrere möglich" })]),
        options.length >= 8 ? el("input", { class: "tl-search", placeholder: "Quelle suchen", "aria-label": "Quelle suchen", value: S.sourceQuery,
          oninput: function (e) { S.sourceQuery = e.target.value; var pos = e.target.selectionStart; renderFilters(); var input = document.querySelector(".tl-search"); if (input) { input.focus(); input.setSelectionRange(pos, pos); } } }) : null,
        el("div", { class: "tl-opts lq-opts-scroll", role: "group", "aria-label": "Quellen" }, shown.map(function (o) {
          var on = d.sources.indexOf(o.value) >= 0;
          var key = o.value === null ? "__none__" : o.value;
          return el("button", { class: "tl-opt tl-opt--src", role: "checkbox", type: "button", "aria-checked": on ? "true" : "false",
            onclick: function () { changeDraft(function (x) { x.sources = on ? x.sources.filter(function (v) { return v !== o.value; }) : x.sources.concat([o.value]); }); } }, [
            el("span", { class: "check" }), el("span", { text: o.label }), el("span", { class: "n", text: p ? String(counts[key] || 0) : "" }),
          ]);
        })),
        el("p", { class: "tl-pop__hint", text: "Die Liste kommt aus HubSpot, sortiert nach Anzahl." }),
        panelFoot("sources"),
      ]);
    }
    if (name === "calls") {
      var max = maxCalls();
      var seg = [el("button", { type: "button", "aria-pressed": d.min_unreached_calls === null ? "true" : "false", onclick: function () { changeDraft(function (x) { x.min_unreached_calls = null; }); } }, ["Egal"])];
      for (var n = 1; n < max; n++) (function (k) {
        seg.push(el("button", { type: "button", "aria-pressed": d.min_unreached_calls === k ? "true" : "false", onclick: function () { changeDraft(function (x) { x.min_unreached_calls = k; }); } }, [k + "+"]));
      })(n);
      var hist = p ? p.by_unreached_calls : {};
      var top = Math.max.apply(null, [1].concat(Object.keys(hist).map(function (k) { return hist[k]; })));
      var bars = [];
      for (var c = 0; c < max; c++) {
        bars.push(el("span", { class: d.min_unreached_calls !== null && c >= d.min_unreached_calls ? "in" : "" }, [el("i", { style: "height:" + Math.max(4, Math.round(((hist[c] || 0) / top) * 30)) + "px" }), String(c)]));
      }
      return el("div", { class: "tl-pop", role: "dialog", "aria-label": "Filter Anrufe", onclick: stop }, [
        el("h4", { class: "tl-pop__title" }, ["Bisherige Anrufe ", el("small", { text: "nicht erreicht, mindestens" })]),
        el("div", { class: "tl-seg", role: "group", "aria-label": "Mindestanzahl" }, seg),
        el("div", { class: "tl-hist", "aria-hidden": "true" }, bars),
        el("p", { class: "tl-pop__hint", text: (d.min_unreached_calls ? "Nur Leads, die schon mindestens " + d.min_unreached_calls + "-mal nicht erreicht wurden. " : "") + "Nach " + max + " nicht erreichten Anrufen verlässt ein Lead die Warteschlange." }),
        panelFoot("min_unreached_calls"),
      ]);
    }
    // age
    var tabs = el("div", { class: "tl-seg", role: "tablist" }, [
      el("button", { role: "tab", type: "button", "aria-pressed": S.ageTab === "days" ? "true" : "false", onclick: function () { S.ageTab = "days"; renderFilters(); } }, ["Alter in Tagen"]),
      el("button", { role: "tab", type: "button", "aria-pressed": S.ageTab === "weeks" ? "true" : "false", onclick: function () { S.ageTab = "weeks"; renderFilters(); } }, ["Kalenderwoche"]),
    ]);
    var body;
    if (S.ageTab === "days") {
      var days = d.age && d.age.unit === "days" ? d.age : { unit: "days", from: null, to: null };
      var setDays = function (from, to) { changeDraft(function (x) { x.age = from === null && to === null ? null : { unit: "days", from: from, to: to }; }); };
      body = [
        el("div", { class: "tl-presets" }, AGE_PRESETS.map(function (pr) {
          var on = days.from === pr.from && days.to === pr.to && d.age;
          return el("button", { class: "tl-fchip", type: "button", "aria-pressed": on ? "true" : "false", onclick: function () { setDays(pr.from, pr.to); } }, [pr.label]);
        })),
        el("div", { class: "tl-range" }, [
          el("span", { text: "oder von" }),
          el("input", { "aria-label": "Mindestalter in Tagen", inputmode: "numeric", value: days.from === null ? "" : String(days.from), placeholder: "0",
            onchange: function (e) { var v = e.target.value.trim(); setDays(v === "" ? null : Math.max(0, parseInt(v, 10) || 0), days.to); } }),
          el("span", { text: "bis" }),
          el("input", { "aria-label": "Höchstalter in Tagen", inputmode: "numeric", value: days.to === null ? "" : String(days.to), placeholder: "egal",
            onchange: function (e) { var v = e.target.value.trim(); setDays(days.from, v === "" ? null : Math.max(0, parseInt(v, 10) || 0)); } }),
          el("span", { text: "Tagen" }),
        ]),
        el("p", { class: "tl-pop__hint", text: "Alter = Tage seit Erstellung des Leads in HubSpot." }),
      ];
    } else {
      var byWeek = {};
      (p ? p.by_week : []).forEach(function (w) { byWeek[w.week] = w.count; });
      var current = isoWeek(new Date());
      var keys = Object.keys(byWeek).concat([current]).sort();
      var first = keys[0], weeks = [];
      for (var t = weekStart(first).getTime(); t <= weekStart(current).getTime(); t += 7 * 86400000) weeks.push(isoWeek(new Date(t + 3 * 86400000)));
      weeks = weeks.slice(-12);
      var sel = d.age && d.age.unit === "weeks" ? d.age : null;
      var pick = function (w) {
        if (S.weekPick && S.weekPick !== w) {
          var a = S.weekPick < w ? S.weekPick : w, b = S.weekPick < w ? w : S.weekPick;
          S.weekPick = null;
          changeDraft(function (x) { x.age = { unit: "weeks", from: a, to: b }; });
        } else {
          S.weekPick = w;
          changeDraft(function (x) { x.age = { unit: "weeks", from: w, to: w }; });
        }
      };
      body = [
        el("div", { class: "tl-weeks" }, weeks.map(function (w) {
          var inRange = sel && w >= sel.from && w <= sel.to;
          var edge = sel && (w === sel.from || w === sel.to);
          var start = weekStart(w);
          return el("button", { class: "tl-week" + (edge ? " tl-week--edge" : inRange ? " tl-week--in" : "") + (w === current ? " tl-week--now" : ""),
            type: "button", "aria-pressed": inRange ? "true" : "false", title: plural(byWeek[w] || 0, "Lead", "Leads"), onclick: function () { pick(w); } },
            ["KW " + Number(w.split("W")[1]), el("small", { text: shortDay(start).split(", ")[1] + ", " + (byWeek[w] || 0) })]);
        })),
        sel ? el("div", { class: "tl-muted", style: "font-size:14px" }, [el("b", { style: "color:var(--ink)", text: ageLabel(sel) })]) : null,
        el("p", { class: "tl-pop__hint", text: "Erste Woche anklicken, dann die letzte für einen Zeitraum. Gestrichelt: aktuelle Woche." }),
      ];
    }
    return el("div", { class: "tl-pop", role: "dialog", "aria-label": "Filter Lead-Alter", style: "width:380px", onclick: stop },
      [el("h4", { class: "tl-pop__title", text: "Lead-Alter" }), tabs].concat(body, [panelFoot("age")]));
  }

  function renderAlerts() {
    var items = [];
    S.alerts.forEach(function (a) {
      items.push(el("div", { class: "tl-alert", role: "alert" }, [a.text,
        a.retry ? el("button", { class: "tl-btn tl-btn--sm", type: "button", onclick: function () { S.alerts = []; a.retry(); } }, ["Nochmal versuchen"]) : null]));
    });
    if (S.notice && S.notice.until > Date.now()) {
      items.push(el("div", null, [el("span", { class: "tl-notice", role: "status", text: S.notice.text })]));
    }
    fill($("alerts"), items);
  }

  function panelCard(children) { return el("div", { class: "tl-card tl-card--plain", style: "display:grid;gap:14px;justify-items:start" }, children); }
  function bigText(text, small) { return el("div", { class: "tl-big", style: small ? "font-size:28px;line-height:34px" : null, text: text }); }

  function renderSlot() {
    var node = $("slot");
    if (S.unavailable) {
      fill(node, [el("div", { class: "tl-panel", style: "display:grid;gap:14px;justify-items:start;padding:28px" }, [
        bigText("Die Lead-Queue ist gerade nicht verfügbar.", true),
        el("p", { class: "tl-muted", style: "margin:0", text: (S.lastCheck ? "Zuletzt geprüft um " + fmt.time(S.lastCheck) + " Uhr. " : "") + "Bis dahin direkt in HubSpot weiterarbeiten." }),
        el("button", { class: "tl-btn", type: "button", onclick: function () { window.location.reload(); } }, ["Neu laden"]),
      ])]);
      return;
    }
    if (S.loading || !S.state || (S.busy && !lead())) {
      fill(node, [el("div", { class: "tl-card tl-card--plain", "aria-busy": "true", "aria-label": "Lead wird geladen", style: "display:grid;gap:14px" }, [
        el("span", { class: "tl-skel", style: "width:120px;height:24px;border-radius:999px" }),
        el("span", { class: "tl-skel", style: "width:70%;height:48px" }),
        el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:12px" }, [1, 2, 3, 4].map(function () { return el("span", { class: "tl-skel", style: "height:44px" }); })),
      ])]);
      return;
    }
    var st = status(), q = S.state.queue;
    if (lead()) { fill(node, [renderCard(lead())]); return; }
    if (st.reason === "paused") {
      fill(node, [panelCard([bigText("Du machst Pause.", true),
        el("p", { class: "tl-muted", style: "margin:0", text: "Dein Lead ist zurück in der Warteschlange. Du bekommst keine neuen Leads, bis du weitermachst." }),
        el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: resume }, ["Weitermachen"])])]);
      return;
    }
    if (S.reminder || st.reason === "mail_reminder") {
      var reminded = S.reminder ? S.reminder.data.contact_name : "";
      fill(node, [panelCard([el("span", { class: "tl-badge tl-badge--neutral", text: "Erledigt" }), bigText(reminded),
        el("p", { class: "tl-muted", style: "margin:0", text: "Nächster Lead wird erst nach dem Schließen reserviert." })])]);
      return;
    }
    if (st.reason === "expired" && st.expired_lead) {
      var exp = st.expired_lead;
      fill(node, [panelCard([bigText("Deine Reservierung ist abgelaufen.", true),
        el("p", { class: "tl-muted", style: "margin:0", text: exp.name + " ist zurück in der Warteschlange. Telefonierst du noch? Dann hol " + (exp.name ? "den Lead" : "ihn") + " dir zurück." }),
        el("div", { class: "tl-row", style: "flex-wrap:wrap" }, [
          el("button", { class: "tl-btn", type: "button", onclick: function () { reclaim(exp.lead_id); } }, ["Zurückholen"]),
          el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: takeLead }, ["Nächster Lead"]),
        ]),
        el("span", { class: "tl-muted", style: "font-size:13px", text: "Zurückholen geht nur, solange niemand anderes ihn hat." })])]);
      return;
    }
    if (st.reason === "filtered_empty") {
      var removed = st.removed_by || {};
      var f = filters();
      fill(node, [el("div", { class: "tl-panel", style: "display:grid;gap:14px;justify-items:start;padding:28px 32px" }, [
        bigText("Keine Leads für deine Filter.", true),
        el("p", { class: "tl-muted", style: "margin:0", text: "Ohne Filter wären " + plural(q.available, "Lead", "Leads") + " verfügbar. Lockere einen Filter:" }),
        el("div", { class: "tl-row", style: "flex-wrap:wrap;gap:8px" }, Object.keys(removed).map(function (dim) {
          return el("button", { class: "tl-fchip", type: "button", onclick: function () { saveFilters(withoutDimension(f, dim)); } },
            ["Ohne „" + chipLabel(dim, f) + "“, " + plural(removed[dim], "Lead", "Leads")]);
        })),
        el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: clearFilters }, ["Alle Filter zurücksetzen"]),
      ])]);
      return;
    }
    if (st.reason === "empty") {
      var hour = fmt.hour(Date.now());
      var cutoff = Number((settings().evening_cutoff || "16:00").split(":")[0]);
      var parts = ["0 verfügbar", q.cooling_down + " in Abkühlung"];
      if (q.scheduled) parts.push(q.scheduled + " geplant");
      fill(node, [panelCard([bigText("Gerade ist niemand dran."),
        el("p", { class: "tl-muted", style: "margin:0", text: parts.join(", ") + "." + (hour < cutoff ? " Ab " + cutoff + " Uhr kommen Abendversuche dazu." : "") }),
        el("button", { class: "tl-btn", type: "button", onclick: takeLead }, ["Nochmal prüfen"])])]);
      return;
    }
    var fresh = q.available_by_group.new_leads || 0;
    fill(node, [panelCard([bigText("Bereit für den ersten Lead?"),
      el("p", { class: "tl-muted", style: "margin:0", text: plural(q.available, "Lead wartet", "Leads warten") + (fresh ? ", " + fresh + " davon neu." : ".") }),
      el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: takeLead }, ["Lead holen ", el("kbd", { text: "N" })])])]);
  }

  function availability(l) {
    var r = l.reachability || {};
    var nowHour = fmt.hour(Date.now());
    var slots = (r.slots || []).map(function (s) { return Number(s.start.split(":")[0]); }).sort(function (a, b) { return a - b; });
    var ranges = [];
    slots.forEach(function (h) {
      var last = ranges[ranges.length - 1];
      if (last && last[1] === h) last[1] = h + 1; else ranges.push([h, h + 1]);
    });
    var slotText = ranges.length ? ranges.map(function (x) { return x[0] + " bis " + x[1]; }).join(", ") + " Uhr" : "";
    var slotNow = slots.indexOf(nowHour) >= 0;
    var chip = function (cls, kindChildren, time) {
      return el("span", { class: "tl-avail" + (cls ? " tl-avail--" + cls : "") }, [el("span", { class: "tl-avail__kind" }, kindChildren), el("span", { class: "tl-avail__time", text: time })]);
    };
    if (r.callback_at) {
      var at = new Date(r.callback_at), now = Date.now();
      var sameHour = isToday(at) && fmt.hour(at) === nowHour;
      var sub = slotText ? "Täglich " + slotText : null;
      if (sameHour) return [chip("now", [el("span", { class: "tl-dot tl-dot--live" }), dayLabel(at)], fmt.time(at) + ", jetzt"), sub || "Fester Termin"];
      if (at.getTime() < now) return [chip("missed", [icon("calendar"), dayLabel(at)], fmt.time(at)), sub || "Fester Termin, verpasst"];
      return [chip("date", [icon("calendar"), dayLabel(at)], fmt.time(at)), sub || "Fester Termin, " + inMinutes(at.getTime() - now)];
    }
    if (slotText) {
      var kind = slotNow ? [el("span", { class: "tl-dot tl-dot--live" }), "Täglich"] : [icon("repeat"), "Täglich"];
      if (ranges.length === 1) return [chip(slotNow ? "now" : null, kind, slotText + (slotNow ? ", jetzt" : "")), "Jeden Tag, ohne Datum"];
      // Several ranges: day strip from 9 to 18 Uhr (lead_anruf_erreichbarkeit has no other hours), the current range teal, a line for now.
      var pct = function (hour) { return Math.max(0, Math.min(100, (hour - 9) / 9 * 100)); };
      var d = new Date(), nowPos = d.getHours() + d.getMinutes() / 60;
      var bars = ranges.filter(function (x) { return x[1] > 9 && x[0] < 18; }).map(function (x) {
        return el("span", { class: nowHour >= x[0] && nowHour < x[1] ? "cur" : "", style: "left:" + pct(x[0]).toFixed(1) + "%;width:" + (pct(x[1]) - pct(x[0])).toFixed(1) + "%" });
      });
      if (nowPos >= 9 && nowPos <= 18) bars.push(el("b", { style: "left:" + pct(nowPos).toFixed(1) + "%", title: "Jetzt" }));
      var current = ranges.filter(function (x) { return nowHour >= x[0] && nowHour < x[1]; })[0];
      var next = ranges.filter(function (x) { return x[0] > nowHour; })[0];
      var hint = current ? "Jetzt erreichbar bis " + current[1] + " Uhr"
        : next ? "Nächstes Zeitfenster ab " + next[0] + " Uhr"
        : "Nächstes Zeitfenster morgen ab " + ranges[0][0] + " Uhr";
      var label = "Erreichbar täglich " + ranges.map(function (x) { return x[0] + " bis " + x[1] + " Uhr"; }).join(", ");
      return [el("div", null, [
        chip(slotNow ? "now" : null, kind, slotText),
        el("div", { class: "tl-daybar", role: "img", "aria-label": label }, bars),
        el("div", { class: "tl-daybar__scale", "aria-hidden": "true" }, ["9", "12", "15", "18"].map(function (t) { return el("span", { text: t }); })),
      ]), hint];
    }
    return [el("span", { class: "tl-avail tl-avail--none" }, [el("span", { class: "tl-avail__time", style: "padding-left:0", text: "Keine Angabe" })]), null];
  }

  function renderCard(l) {
    var g = group(l.group);
    var res = reservation();
    var field = function (label, value, sub) {
      return el("div", null, [el("div", { class: "tl-field__label", text: label }), value, sub ? el("div", { class: "tl-field__sub", text: sub }) : null]);
    };
    var avail = availability(l);
    var steps = reminderSteps();
    var segments = [];
    for (var i = 0; i < l.max_calls; i++) {
      segments.push(el("span", { class: i < l.unreached_calls ? "on" : i === l.unreached_calls ? "next" : "" }, [el("i"), steps[i + 1] ? icon("mail") : null]));
    }
    var nextMail = steps[l.unreached_calls + 1];
    var mailCalls = Object.keys(steps).join(", ");
    var timer = el("span", { class: "tl-timer", id: "timer", title: "Verlängert sich automatisch, wenn du den Kontakt in HubSpot öffnest." }, [
      el("span", { id: "timer-label", text: "reserviert" }),
      el("span", { class: "tl-timer__bar" }, [el("span", { id: "timer-bar", style: "width:100%" })]),
      el("span", { class: "tl-timer__time", id: "timer-time", text: res ? countdown(new Date(res.return_at) - Date.now()) : "" }),
    ]);
    var st = status();
    return el("article", { class: "tl-card tl-card--" + (g ? g.cls : "plain"), "aria-label": "Aktiver Lead" }, [
      el("div", { class: "tl-card__head" }, [
        g ? el("span", { class: "tl-badge tl-badge--" + g.cls, text: g.label }) : el("span", { class: "tl-badge tl-badge--plain", text: "Geplant" }),
        el("span", { class: "tl-badge tl-badge--plain", text: l.stage }),
        timer,
      ]),
      el("a", { class: "tl-name", href: l.hubspot_url, target: "_blank", rel: "noopener", title: "Kontakt in HubSpot öffnen",
        onclick: function () { keep("hubspot_opened"); } }, [l.name || "Kontakt ohne Namen", " ", icon("link")]),
      st.stale ? el("div", { class: "lq-card-notes" }, [el("span", { class: "tl-notice" }, [icon("clock"), "HubSpot nicht erreichbar, Stand " + (st.data_as_of ? fmt.time(st.data_as_of) : "?") + " Uhr"])]) : null,
      el("div", { class: "tl-fields" }, [
        field("Erreichbarkeit", avail[0], avail[1]),
        field("Lead-Alter", el("div", { class: "tl-field__value", text: l.age_days === 1 ? "1 Tag" : l.age_days + " Tage" }), "seit " + fmt.dayYear(l.created_at).replace(/^(\w+)\.?,?\s*/, "$1, ")),
        field("Anrufe", el("div", null, [
          el("div", { class: "tl-field__value", text: l.unreached_calls + " von " + l.max_calls }),
          el("div", { class: "tl-segments", "aria-label": l.unreached_calls + " von " + l.max_calls + " Anrufen" + (mailCalls ? ", Mails nach Anruf " + mailCalls : "") }, segments),
        ]), nextMail ? "Nach Anruf " + (l.unreached_calls + 1) + ": " + nextMail : null),
        field("Letzter Anruf", el("div", { class: "tl-field__value", text: l.last_contacted_at ? shortDay(l.last_contacted_at) + ", " + fmt.time(l.last_contacted_at) : "Noch nie" }),
          l.last_contacted_at ? relative(l.last_contacted_at) : null),
      ]),
    ]);
  }

  function nextMeetingSoon() {
    var section = S.state && S.state.meetings;
    if (!section || section.status !== "ok") return null;
    var lease = (settings().lease_minutes || 10) * 60000, now = Date.now();
    return section.data.meetings.filter(function (m) {
      var start = new Date(m.start_at).getTime();
      return start > now && start - now <= lease;
    })[0] || null;
  }

  function renderActions() {
    var node = $("actions");
    var l = lead();
    if (!l || S.unavailable) { fill(node, []); return; }
    var res = reservation();
    var warnAt = res ? new Date(res.warn_at).getTime() : Infinity;
    var still = Date.now() >= warnAt
      ? el("div", { class: "tl-stillthere", role: "alert", style: "margin-bottom:10px" }, [
          el("span", null, ["Noch dran? Der Lead geht in ", el("span", { class: "tl-num", id: "still-time", text: countdown(new Date(res.return_at) - Date.now()) }), " zurück."]),
          el("button", { class: "tl-btn tl-btn--sm", type: "button", onclick: function () { keep("keep"); } }, ["Behalten ", el("kbd", { text: "B" })]),
        ])
      : null;
    var meeting = nextMeetingSoon();
    var bar = meeting
      ? el("div", { class: "tl-actions tl-actions--warn", role: "region", "aria-label": "Aktionen" }, [
          el("div", { class: "tl-actions__info" }, ["Termin mit " + (meeting.guest || meeting.title || "Kunde") + " " + inMinutes(new Date(meeting.start_at) - Date.now()),
            el("small", { text: "Ein neuer Lead wäre " + (settings().lease_minutes || 10) + " Min für dich reserviert." })]),
          el("button", { class: "tl-btn", type: "button", disabled: S.busy, title: "Nicht angerufen. Der Lead geht sofort an andere zurück.", onclick: skip }, ["Überspringen ", el("kbd", { text: "S" })]),
          el("button", { class: "tl-btn", type: "button", disabled: S.busy, title: "Lead erledigt, trotzdem den nächsten holen.", onclick: function () { finish(false); } }, ["Erledigt, weiter"]),
          el("button", { class: "tl-btn tl-btn--primary", type: "button", style: "flex:1", disabled: S.busy, onclick: function () { finish(true); } }, ["Erledigt, Pause bis Termin"]),
        ])
      : el("div", { class: "tl-actions", role: "region", "aria-label": "Aktionen" }, [
          el("button", { class: "tl-btn", type: "button", disabled: S.busy, title: "Nicht angerufen. Der Lead geht sofort an andere zurück.", onclick: skip }, ["Überspringen (nicht angerufen) ", el("kbd", { text: "S" })]),
          el("button", { class: "tl-btn tl-btn--primary", type: "button", style: "flex:1", disabled: S.busy, onclick: function () { finish(false); } },
            [S.busy ? "Wird geladen" : "Erledigt, nächster Lead ", S.busy ? null : el("kbd", { text: "N" })]),
        ]);
    fill(node, [still, bar]);
  }

  function renderTasks() {
    var node = $("tasks");
    var section = S.state && S.state.tasks;
    if (!lead() || !section) { fill(node, []); return; }
    if (section.status !== "ok") {
      fill(node, [el("section", { class: "tl-panel", "aria-label": "Aufgaben in HubSpot" }, [
        el("h3", { class: "tl-panel__title", text: "Aufgaben in HubSpot" }),
        el("p", { class: "tl-muted", style: "margin:0 4px 8px", text: "Aufgaben gerade nicht verfügbar." })])]);
      return;
    }
    var tasks = section.data;
    var done = tasks.filter(function (t) { return t.done; }).length;
    fill(node, [el("section", { class: "tl-panel", "aria-label": "Aufgaben in HubSpot" }, [
      el("h3", { class: "tl-panel__title" }, ["Aufgaben in HubSpot ", el("small", { text: (tasks.length - done) + " offen, " + done + " erledigt" })]),
      tasks.length ? el("ul", { class: "tl-tasks" }, tasks.map(function (t, index) {
        var meta;
        if (S.errorTasks[t.task_id]) meta = el("span", { text: "HubSpot nicht erreichbar. Nochmal versuchen?" });
        else if (t.done) meta = el("span", { class: "done", text: "Erledigt um " + fmt.time(S.doneAt[t.task_id] || new Date()) });
        else if (t.due_at) meta = el("span", { class: t.overdue ? "overdue" : "", text: t.overdue ? "Überfällig seit " + shortDay(t.due_at) : isToday(t.due_at) ? "Heute" : "Fällig " + shortDay(t.due_at) });
        else meta = el("span", { text: "Ohne Termin" });
        return el("li", null, [el("label", { class: "tl-task" + (t.done ? " is-done" : "") + (S.pendingTasks[t.task_id] ? " is-pending" : "") + (S.errorTasks[t.task_id] ? " is-error" : "") }, [
          el("input", { type: "checkbox", checked: t.done, disabled: !!S.pendingTasks[t.task_id], "aria-keyshortcuts": index < 9 ? String(index + 1) : null, onchange: function () { toggleTask(t); } }),
          el("span", { class: "tl-task__body" }, [el("div", { class: "tl-task__title", text: t.title || "Ohne Titel" }),
            el("div", { class: "tl-task__meta" }, [meta, el("span", { text: TASK_TYPES[t.type] || t.type || "" })])]),
        ])]);
      })) : el("p", { class: "tl-muted", style: "margin:0 4px 8px", text: "Keine offenen Aufgaben." }),
    ])]);
  }

  function renderToday() {
    var node = $("today");
    if (!S.state || S.unavailable) { fill(node, []); return; }
    var now = Date.now(), lease = (settings().lease_minutes || 10) * 60000;
    var items = [];
    var meetings = S.state.meetings;
    var meetingNote = null;
    if (meetings && meetings.status === "ok") {
      meetings.data.meetings.forEach(function (m) { items.push({ at: new Date(m.start_at).getTime(), kind: "meeting", m: m }); });
    } else if (meetings && meetings.status === "error") {
      meetingNote = "Termine gerade nicht verfügbar.";
    }
    (S.state.callbacks || []).forEach(function (c) { items.push({ at: new Date(c.callback_at).getTime(), kind: "callback", c: c }); });
    items.sort(function (a, b) { return a.at - b.at; });
    var nextFound = false;
    var rows = items.map(function (item) {
      if (item.kind === "meeting") {
        var m = item.m, end = m.end_at ? new Date(m.end_at).getTime() : item.at;
        var past = end < now || (item.at < now && !m.end_at);
        var cls = "tl-meet", sub = null;
        if (past) cls += " tl-meet--past";
        else if (!nextFound && item.at > now) {
          nextFound = true;
          sub = inMinutes(item.at - now);
          cls += item.at - now <= lease ? " tl-meet--soon" : " tl-meet--next";
        }
        return el("div", { class: cls }, [el("span", { class: "tl-meet__time", text: fmt.time(item.at) }),
          sub ? el("span", null, [el("div", { class: "tl-meet__guest", text: m.guest || m.title }), el("div", { class: "tl-meet__sub", text: sub })])
              : el("span", { class: "tl-meet__guest", text: m.guest || m.title })]);
      }
      var c = item.c;
      var state = c.state === "now" ? " tl-meet--now" : c.state === "missed" ? " tl-meet--missed" : "";
      var subText = c.state === "now" ? "Rückruf, jetzt" : c.state === "missed" ? "Rückruf, verpasst" : "Rückruf, " + inMinutes(item.at - now);
      if (c.reserved && c.state !== "missed") subText += ", in Bearbeitung";
      return el("div", { class: "tl-meet" + state }, [el("span", { class: "tl-meet__time", text: fmt.time(item.at) }),
        el("span", null, [el("div", { class: "tl-meet__guest", text: c.name || "Kontakt" }), el("div", { class: "tl-meet__sub lq-meet__kind" }, [icon("phone"), subText])])]);
    });
    var remaining = items.some(function (i) { return i.kind === "meeting" ? new Date(i.m.end_at || i.m.start_at).getTime() >= now : i.c.state !== "missed"; });
    var children = [el("h3", { class: "tl-panel__title" }, ["Heute ", el("small", { text: shortDay(now) })])];
    if (meetings && meetings.status === "no_owner") children.push(el("p", { class: "tl-muted", style: "margin:0 4px 8px;font-size:14px", text: "Kein Hubspot-Nutzer verknüpft." }));
    if (meetingNote) children.push(el("p", { class: "tl-muted", style: "margin:0 4px 8px;font-size:14px", text: meetingNote }));
    children = children.concat(rows);
    if (!remaining) children.push(el("div", { class: "tl-empty", html: ICON.calendar }, [el("b", { text: "Heute keine Termine mehr." }), el("span", { text: "Volle Zeit für Anrufe." })]));
    fill(node, [el("section", { class: "tl-panel", "aria-label": "Termine heute" }, children)]);
  }

  function renderToast() {
    var node = $("toast");
    if (!S.toast || S.toast.until <= Date.now()) { S.toast = null; fill(node, []); return; }
    fill(node, [el("div", { class: "tl-toast", role: "status" }, [
      el("span", { text: S.toast.name + " erledigt." }),
      el("button", { type: "button", onclick: undo }, ["Rückgängig"]),
      el("span", { class: "tl-toast__count", id: "toast-count", text: Math.ceil((S.toast.until - Date.now()) / 1000) + " s" }),
    ])]);
  }

  function renderModal() {
    var node = $("modal");
    if (!S.reminder) { if (!node.dataset.static) fill(node, []); return; }
    delete node.dataset.static;
    var r = S.reminder.data, max = maxCalls(), steps = reminderSteps();
    var last = r.call_number >= max;
    var dots = [];
    for (var i = 1; i <= max; i++) dots.push(el("span", { class: i < r.call_number ? "on" : i === r.call_number ? "now" : "" }, [el("i"), steps[i] ? icon("mail") : " "]));
    fill(node, [el("div", { class: "tl-scrim" }, [el("div", { class: "tl-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "mr-title" }, [
      el("div", { class: "tl-row", style: "justify-content:space-between" }, [
        el("span", { class: "tl-badge " + (last ? "tl-badge--last" : "tl-badge--neutral"), text: "Anruf " + r.call_number + " von " + max + (last ? ", letzter Versuch" : "") }),
        el("div", { class: "tl-mailsteps", "aria-label": "Anruf " + r.call_number + " von " + max }, dots),
      ]),
      el("h2", { class: "tl-modal__title", id: "mr-title", text: r.mail_name + " an " + r.contact_name + " senden?" }),
      el("div", { class: "tl-mailrow" }, [icon("mail"), el("span", { class: "tl-mailrow__name", text: "Vorlage: " + r.mail_name }),
        el("a", { href: r.hubspot_email_url, target: "_blank", rel: "noopener", title: "Öffnet das E-Mail-Fenster des Kontakts in HubSpot" }, ["E-Mail in HubSpot schreiben ", icon("link")])]),
      el("div", { class: "tl-modal__actions" }, [el("button", { class: "tl-btn tl-btn--primary", type: "button", id: "mr-ok", onclick: closeReminder }, ["Verstanden"])]),
    ])])]);
    var ok = $("mr-ok"); if (ok) ok.focus();
  }

  function showShortcuts() {
    S.menuOpen = false;
    renderHeader();
    var node = $("modal");
    node.dataset.static = "1";
    var close = function () { delete node.dataset.static; fill(node, []); };
    var rows = [["N", "Erledigt, nächster Lead (oder Lead holen)"], ["S", "Überspringen"], ["B", "Behalten"], ["F", "Filter Gruppe öffnen"], ["1 bis 9", "Aufgabe abhaken"], ["Esc", "Panel oder Fenster schließen"]];
    var dl = el("dl", { class: "lq-shortcuts" });
    rows.forEach(function (r) { dl.appendChild(el("dt", null, [el("kbd", { text: r[0] })])); dl.appendChild(el("dd", { text: r[1] })); });
    fill(node, [el("div", { class: "tl-scrim", onclick: function (e) { if (e.target === e.currentTarget) close(); } }, [el("div", { class: "tl-modal", role: "dialog", "aria-modal": "true", "aria-label": "Tastenkürzel" }, [
      el("h2", { class: "tl-modal__title", text: "Tastenkürzel" }), dl,
      el("div", { class: "tl-modal__actions" }, [el("button", { class: "tl-btn tl-btn--primary", type: "button", onclick: close }, ["Schließen"])]),
    ])])]);
  }

  // --- the clock: timer, warning, expiry, toast countdown ------------------------------------------

  var lastWarnState = null;
  function tick() {
    var res = reservation();
    if (res && lead()) {
      var now = Date.now();
      var claimed = new Date(res.claimed_at).getTime(), back = new Date(res.return_at).getTime(), warn = new Date(res.warn_at).getTime();
      var left = back - now;
      var timer = $("timer");
      if (timer) {
        var warning = now >= warn;
        timer.classList.toggle("tl-timer--warn", warning);
        $("timer-label").textContent = warning ? "Noch dran?" : "reserviert";
        $("timer-time").textContent = countdown(left);
        $("timer-bar").style.width = Math.max(0, Math.min(100, (left / Math.max(1, back - claimed)) * 100)) + "%";
        var still = $("still-time");
        if (still) still.textContent = countdown(left);
        if (warning !== lastWarnState) { lastWarnState = warning; renderActions(); }
      }
      if (left <= 0) expire();
    } else {
      lastWarnState = null;
    }
    if (S.toast) {
      var count = $("toast-count");
      if (S.toast.until <= Date.now()) renderToast();
      else if (count) count.textContent = Math.ceil((S.toast.until - Date.now()) / 1000) + " s";
    }
    if (S.notice && S.notice.until <= Date.now()) { S.notice = null; renderAlerts(); }
  }

  // --- events -------------------------------------------------------------------------------------

  document.addEventListener("click", function () {
    var changed = false;
    if (S.menuOpen) { S.menuOpen = false; changed = true; renderHeader(); }
    if (S.panel) { closePanel(); changed = true; }
    return changed;
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      if (S.panel) closePanel();
      if (S.menuOpen) { S.menuOpen = false; renderHeader(); }
      var node = $("modal");
      if (node.dataset.static) { delete node.dataset.static; fill(node, []); }
      return;
    }
    var target = event.target;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    if (S.reminder || $("modal").dataset.static) return;
    var key = event.key.toLowerCase();
    if (key === "n") { event.preventDefault(); if (lead()) finish(false); else if (!status().paused) takeLead(); }
    else if (key === "s" && lead()) { event.preventDefault(); skip(); }
    else if (key === "b" && lead()) { event.preventDefault(); keep("keep"); }
    else if (key === "f" && S.state) { event.preventDefault(); openPanel("groups"); }
    else if (/^[1-9]$/.test(key) && lead()) {
      var tasks = S.state.tasks && S.state.tasks.data;
      var task = tasks && tasks[Number(key) - 1];
      if (task && !S.pendingTasks[task.task_id]) { event.preventDefault(); toggleTask(task); }
    }
  });

  // Closing or reloading the tab: the API keeps the lead briefly so a reload gets it back.
  window.addEventListener("pagehide", function () {
    var l = lead();
    if (!l || !navigator.sendBeacon) return;
    navigator.sendBeacon("/api/lead/leave", new Blob([JSON.stringify({ lead_id: l.lead_id })], { type: "application/json" }));
  });

  // Light refreshes while visible; catch up when the tab comes back.
  var lastPulse = Date.now(), lastMeetings = Date.now();
  setInterval(function () {
    tick();
    if (document.hidden || !S.state || S.busy) return;
    var now = Date.now();
    if (now - lastPulse >= (settings().refresh ? settings().refresh.pulse_seconds : 60) * 1000) { lastPulse = now; loadPulse(); }
    if (now - lastMeetings >= (settings().refresh ? settings().refresh.meetings_seconds : 900) * 1000) { lastMeetings = now; loadMeetings(); }
    if (now % 30000 < 1000) renderToday(); // keep "in X Min" current
  }, 1000);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || !S.state) return;
    lastPulse = Date.now();
    loadState();
  });

  // --- start ----------------------------------------------------------------------------------------

  api("GET", "/session").then(function (data) { S.email = data.email; renderHeader(); }, function () {});
  loadState();
})();
