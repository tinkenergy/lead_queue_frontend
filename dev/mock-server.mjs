// Local preview of the page without the Worker, the API or HubSpot: serves ./public and
// answers /api/* like the lead queue v2 API, from made-up data in memory (one rep).
//
//   npm run mock            # http://localhost:8790
//   MOCK_LEASE_SECONDS=90 npm run mock   # a short reservation, to see warning and expiry
//
// Development only. The real behaviour lives in reonic-sync-api; this only mimics its
// answers well enough to look at every screen.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8790);
const LEASE = Number(process.env.MOCK_LEASE_SECONDS || 600) * 1000;
const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const EMAIL = "anna@tink.io";
const MAX_CALLS = 4;
const GROUPS = ["new_leads", "evening_retry", "reachable", "hot_leads", "backlog", "called_today"];
const SOURCES = [
  { value: "Uplane_Lead", label: "Uplane" },
  { value: "Website_Ersparnis", label: "Webseite Ersparnis" },
  { value: "tink_core", label: "tink" },
  { value: "Partner_TapTapHome", label: "TapTapHome" },
];
const URL_BASE = "https://app-eu1.hubspot.com/contacts/146396046/record/0-1/";

const now = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();
const hourStart = () => { const d = new Date(); d.setMinutes(0, 0, 0); return d.getTime(); };
const days = (n) => n * 86400000;

function mkLead(id, name, group, extra = {}) {
  const [firstname, ...rest] = name.split(" ");
  return {
    lead_id: id, contact_id: "c" + id, name, firstname, lastname: rest.join(" "), zip: "10115",
    source: { value: SOURCES[Number(id) % 4].value, label: SOURCES[Number(id) % 4].label },
    hubspot_url: URL_BASE + "c" + id, group, stage_id: "attempting-stage-id", stage: "02 | Angerufen, nie erreicht",
    created_at: iso(now() - days(extra.age ?? 10)), age_days: extra.age ?? 10,
    unreached_calls: extra.calls ?? 1, max_calls: MAX_CALLS,
    last_contacted_at: extra.last === null ? null : iso(now() - days(extra.last ?? 3)),
    reachability: { slots: extra.slots ?? [], callback_at: extra.callback ?? null },
    ...extra.override,
  };
}

const h = new Date().getHours();
const leads = [
  mkLead("500", "Gerald Kasten", "reachable", { calls: 2, slots: [12, 13, 18].map((x) => ({ start: `${x}:00`, end: `${x + 1}:00` })), age: 15 }),
  mkLead("501", "Martina Hölscher", "new_leads", { calls: 0, last: null, age: 1, slots: [{ start: "8:00", end: "9:00" }, { start: "12:00", end: "13:00" }], override: { stage: "01 | Neu", stage_id: "new-stage-id" } }),
  mkLead("502", "Jana Beispiel", "hot_leads", { calls: 1, age: 4, slots: [{ start: "18:00", end: "19:00" }] }),
  mkLead("503", "Ralf Opp", "backlog", { calls: 3, age: 40, slots: [8, 9, 12, 16].map((x) => ({ start: `${x}:00`, end: `${x + 1}:00` })) }),
  mkLead("506", "Petra Lindner", "called_today", { calls: 1, age: 0, last: 1 / 24 }),
  mkLead("504", "Karin Melcher", "backlog", { calls: 2, age: 22, callback: iso(now() - 3 * 3600000) }),
  mkLead("505", "Sabine Ortmann", null, { calls: 1, age: 6, callback: iso(hourStart() + 2 * 3600000 + 30 * 60000) }),
];
const tasksOf = {
  500: [
    { task_id: "981", title: "Rückruf: Dachausrichtung und Verschattung klären", type: "CALL", due_at: iso(now() - days(3)), overdue: true, done: false },
    { task_id: "982", title: "Letzte Stromrechnung anfordern", type: "EMAIL", due_at: iso(now() + 3600000), overdue: false, done: false },
  ],
};
const meetings = [
  { meeting_id: "8001", start_at: iso(hourStart() - 2 * 3600000), end_at: iso(hourStart() - 3600000), title: "Sales Call 1", guest: "Familie Brandt" },
  { meeting_id: "8002", start_at: iso(now() + 42 * 60000), end_at: iso(now() + 102 * 60000), title: "Sales Call 1", guest: "Thomas Weiler" },
  { meeting_id: "8003", start_at: iso(hourStart() + 4 * 3600000), end_at: null, title: "Sales Call 2", guest: "Jörg und Anja Petersen" },
];

const me = { lease: null, paused: false, filters: { groups: [], min_unreached_calls: null, age: null, sources: [] },
  finished: null, expired: null, skips: new Set(), cooldown: new Set(), calls: 23, extended: false, reminded: new Set() };

const heldBack = (l) => !l.group;
function available() {
  return leads.filter((l) => !heldBack(l) && !me.cooldown.has(l.lead_id) && !me.skips.has(l.lead_id) && me.lease?.lead_id !== l.lead_id);
}
function week(ms) {
  const d = new Date(ms); const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const w = Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(w).padStart(2, "0")}`;
}
function matches(l, f, ignore) {
  if (ignore !== "groups" && f.groups.length && !f.groups.includes(l.group)) return false;
  if (ignore !== "min_unreached_calls" && f.min_unreached_calls !== null && l.unreached_calls < f.min_unreached_calls) return false;
  if (ignore !== "sources" && f.sources.length && !f.sources.includes(l.source ? l.source.value : null)) return false;
  if (ignore !== "age" && f.age) {
    const v = f.age.unit === "days" ? l.age_days : week(new Date(l.created_at).getTime());
    if (f.age.from !== null && v < f.age.from) return false;
    if (f.age.to !== null && v > f.age.to) return false;
  }
  return true;
}
const active = (f) => ["groups", "min_unreached_calls", "age", "sources"].filter((d) =>
  d === "groups" ? f.groups.length : d === "sources" ? f.sources.length : d === "age" ? f.age : f[d] !== null);

function reachableByHour(pool) {
  const counts = {};
  for (const l of pool) for (const s of l.reachability.slots) {
    const hour = Number(s.start.split(":")[0]);
    counts[hour] = (counts[hour] || 0) + 1;
  }
  return counts;
}
function queue() {
  const pool = available();
  const by = (list) => Object.fromEntries(GROUPS.map((g) => [g, list.filter((l) => l.group === g).length]));
  return {
    total: leads.length, by_group: by(leads.filter((l) => !heldBack(l))), scheduled: leads.filter(heldBack).length,
    cooling_down: me.cooldown.size, active_reps: me.lease ? 1 : 0, synced_at: iso(now() - 600000),
    available: pool.length, available_by_group: by(pool), matching_filters: pool.filter((l) => matches(l, me.filters)).length,
    reachable_by_hour: reachableByHour(pool),
  };
}
function callbacks() {
  return leads.filter((l) => l.reachability.callback_at).map((l) => {
    const at = new Date(l.reachability.callback_at).getTime();
    const state = at >= hourStart() + 3600000 ? "upcoming" : at >= hourStart() ? "now" : "missed";
    return { lead_id: l.lead_id, contact_id: l.contact_id, name: l.name, callback_at: l.reachability.callback_at, state, reserved: me.lease?.lead_id === l.lead_id, hubspot_url: l.hubspot_url };
  }).sort((a, b) => a.callback_at.localeCompare(b.callback_at));
}
function reservation() {
  if (!me.lease) return null;
  const r = { lead_id: me.lease.lead_id, claimed_at: iso(me.lease.claimed), warn_at: iso(me.lease.back - 60000),
    return_at: iso(me.lease.back), expires_at: iso(me.lease.back + 120000), just_extended: me.extended };
  me.extended = false;
  return r;
}
function status(extra = {}) {
  const pool = available();
  let reason = null, removed = null;
  if (!me.lease) {
    if (me.paused) reason = "paused";
    else if (extra.reminder) reason = "mail_reminder";
    else if (me.expired) reason = "expired";
    else if (!pool.length) reason = "empty";
    else if (!pool.some((l) => matches(l, me.filters))) {
      reason = "filtered_empty";
      removed = Object.fromEntries(active(me.filters).map((d) => [d, pool.filter((l) => matches(l, me.filters, d)).length]));
    }
  }
  return { stale: false, data_as_of: me.lease ? iso(me.lease.claimed) : null, paused: me.paused, reason, removed_by: removed,
    expired_lead: !me.lease && me.expired ? { lead_id: me.expired.lead_id, name: me.expired.name } : null };
}
const stats = () => ({ status: "ok", detail: null, data: { date: iso(now()).slice(0, 10), cached_at: iso(now()), calls: me.calls, qualified: 3,
  goals: { calls: 40, qualified: 5 }, calls_by_hour: [{ hour: 9, calls: 6 }, { hour: 10, calls: 8 }, { hour: h, calls: 4 }] } });
const meetingsSection = () => ({ status: "ok", detail: null, data: { cached_at: iso(now()), meetings } });
function state(extra = {}) {
  const lead = me.lease ? leads.find((l) => l.lead_id === me.lease.lead_id) : null;
  return {
    as_of: iso(now()),
    settings: extra.settings ? {
      max_calls: MAX_CALLS, lease_minutes: Math.round(LEASE / 60000) || 1, warning_minutes: 1, hubspot_open_minutes: 20, undo_seconds: 5,
      hot_lead_max_age_days: 14, evening_cutoff: "16:00", timezone: "Europe/Berlin", refresh: { pulse_seconds: 60, meetings_seconds: 900 },
      mail_reminders: [{ call_number: 1, mail_name: "NE Mail" }, { call_number: 3, mail_name: "NE Mail" }, { call_number: 4, mail_name: "Abschiedsmail" }],
      lead_sources: SOURCES,
    } : null,
    lead, reservation: reservation(),
    tasks: lead ? { status: "ok", detail: null, data: tasksOf[lead.lead_id] || [] } : null,
    queue: queue(), stats: stats(), meetings: meetingsSection(), callbacks: callbacks(), filters: me.filters,
    status: status(extra), mail_reminder: extra.reminder || null,
    undo: me.finished && me.finished.until > now() ? { lead_id: me.finished.lead.lead_id, until: iso(me.finished.until) } : null,
  };
}
function claim() {
  const next = available().filter((l) => matches(l, me.filters)).sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))[0];
  if (next) me.lease = { lead_id: next.lead_id, claimed: now(), back: now() + LEASE };
}
function fail(res, status, code, detail) { send(res, status, { detail, hint: null, matches: [], code }); }
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
function held(res, body) {
  if (!me.lease || me.lease.lead_id !== body.lead_id) { fail(res, 409, "not_reserved", "This lead is no longer reserved for you."); return null; }
  return leads.find((l) => l.lead_id === me.lease.lead_id);
}

async function api(req, res, path, body) {
  const route = `${req.method} ${path}`;
  if (route === "GET /session") return send(res, 200, { email: EMAIL });
  if (route === "GET /state") return send(res, 200, state({ settings: true }));
  if (route === "GET /pulse") return send(res, 200, { as_of: iso(now()), reservation: reservation(), queue: queue(), stats: stats(), callbacks: callbacks(), status: status() });
  if (route === "GET /meetings") return send(res, 200, meetingsSection());
  if (route === "POST /lead") {
    if (!me.lease) {
      if (me.paused) return fail(res, 409, "paused", "You are paused.");
      me.expired = null; claim();
    }
    return send(res, 200, state());
  }
  if (route === "POST /lead/done" || route === "POST /lead/skip") {
    const lead = held(res, body); if (!lead) return;
    me.lease = null;
    if (route.endsWith("skip")) { me.skips.add(lead.lead_id); claim(); return send(res, 200, state()); }
    me.cooldown.add(lead.lead_id); me.calls += 1;
    me.finished = { lead, until: now() + 10000, pause: !!body.pause };
    const number = lead.unreached_calls + 1;
    const names = { 1: "NE Mail", 3: "NE Mail", 4: "Abschiedsmail" };
    const reminder = names[number] && !me.reminded.has(lead.lead_id)
      ? { lead_id: lead.lead_id, contact_name: lead.name, call_number: number, mail_name: names[number], hubspot_email_url: lead.hubspot_url + "?interaction=email" } : null;
    if (reminder) me.reminded.add(lead.lead_id);
    if (body.pause) me.paused = true; else if (!reminder) claim();
    return send(res, 200, state({ reminder }));
  }
  if (route === "POST /lead/extend") {
    if (!held(res, body)) return;
    me.lease.back = body.reason === "hubspot_opened" ? Math.max(me.lease.back, now() + 20 * 60000) : now() + LEASE;
    me.extended = true;
    return send(res, 200, state());
  }
  if (route === "POST /lead/expire") {
    if (me.lease && me.lease.lead_id === body.lead_id) { me.expired = leads.find((l) => l.lead_id === body.lead_id); me.lease = null; }
    return send(res, 200, state());
  }
  if (route === "POST /lead/leave") return send(res, 204);
  if (route === "POST /lead/reclaim") {
    if (!me.expired || me.expired.lead_id !== body.lead_id) return fail(res, 409, "not_reserved", "Nothing to take back.");
    me.lease = { lead_id: body.lead_id, claimed: now(), back: now() + LEASE }; me.expired = null;
    return send(res, 200, state());
  }
  if (route === "POST /lead/undo") {
    if (!me.finished || me.finished.lead.lead_id !== body.lead_id || me.finished.until < now()) return fail(res, 409, "undo_closed", "This can no longer be undone.");
    me.cooldown.delete(body.lead_id);
    if (me.finished.pause) me.paused = false;
    me.lease = { lead_id: body.lead_id, claimed: now(), back: now() + LEASE }; me.finished = null;
    return send(res, 200, state());
  }
  if (route === "POST /pause") { if (me.lease) { me.cooldown.add(me.lease.lead_id); me.lease = null; } me.paused = true; return send(res, 200, state()); }
  if (route === "POST /resume") { me.paused = false; return send(res, 200, state()); }
  if (route === "POST /logout") { me.lease = null; me.paused = false; me.finished = null; me.expired = null; return send(res, 200, state()); }
  if (route === "POST /skips/reset") { const n = me.skips.size; me.skips.clear(); return send(res, 200, { reset: n }); }
  if (route === "POST /filters/preview" || route === "PUT /filters") {
    const f = body.filters;
    if (f.groups.some((g) => !GROUPS.includes(g))) return fail(res, 422, "invalid_filter", "Unknown group.");
    if (route === "PUT /filters") { me.filters = f; return send(res, 200, state()); }
    const pool = available();
    const count = (dim) => pool.filter((l) => matches(l, f, dim));
    const weeks = {}; count("age").forEach((l) => { const w = week(new Date(l.created_at).getTime()); weeks[w] = (weeks[w] || 0) + 1; });
    const sources = {}; count("sources").forEach((l) => { const k = l.source ? l.source.value : null; sources[k] = (sources[k] || 0) + 1; });
    return send(res, 200, {
      total: pool.filter((l) => matches(l, f)).length,
      by_group: Object.fromEntries(GROUPS.map((g) => [g, count("groups").filter((l) => l.group === g).length])),
      by_unreached_calls: Object.fromEntries([...Array(MAX_CALLS).keys()].map((n) => [String(n), count("min_unreached_calls").filter((l) => l.unreached_calls === n).length])),
      by_week: Object.entries(weeks).sort().reverse().map(([w, c]) => ({ week: w, count: c })),
      by_source: Object.entries(sources).map(([v, c]) => ({ value: v === "null" ? null : v, count: c })),
    });
  }
  if (route === "DELETE /filters") { me.filters = { groups: [], min_unreached_calls: null, age: null, sources: [] }; return send(res, 200, state()); }
  const task = /^PATCH \/tasks\/(\d+)$/.exec(route);
  if (task) {
    const list = me.lease ? tasksOf[me.lease.lead_id] || [] : [];
    const t = list.find((x) => x.task_id === task[1]);
    if (!t) return fail(res, 404, "task_not_found", "This task does not belong to your lead.");
    t.done = !!body.done; t.overdue = !t.done && new Date(t.due_at).getTime() < now();
    return send(res, 200, t);
  }
  fail(res, 404, null, "Not found.");
}

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    return api(req, res, url.pathname.slice(4), body);
  }
  const file = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}).listen(PORT, () => console.log(`Mock lead queue on http://localhost:${PORT}`));
