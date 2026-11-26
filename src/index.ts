export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN?: string;
  DASHBOARD_KEY: string;
  ENROLLMENT_CODE: string;
}

type Device = {
  id: number;
  device_name: string;
  employee_name: string;
  device_token: string;
  created_at: string;
  last_seen: string | null;
  is_active: number;
};

type EventInput = {
  event_type: string;
  app_name?: string | null;
  file_name?: string | null;
  details?: string | null;
  idle?: boolean | null;
  occurred_at?: string | null;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

function secureEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  let diff = aa.length ^ bb.length;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function bearer(request: Request): string {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

async function adminOK(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get("X-Dashboard-Key") || "";
  if (!env.DASHBOARD_KEY || env.DASHBOARD_KEY.length < 32) return false;
  return secureEqual(supplied, env.DASHBOARD_KEY);
}

async function activeDevice(request: Request, env: Env): Promise<Device | null> {
  const token = request.headers.get("X-Device-Token") || "";
  if (!token) return null;
  return await env.DB.prepare(
    "SELECT id, device_name, employee_name, device_token, created_at, last_seen, is_active FROM devices WHERE device_token = ? AND is_active = 1"
  ).bind(token).first<Device>();
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (method === "GET" && path === "/health") {
    try {
      await env.DB.prepare("SELECT 1 AS ok").first();
      return json({ status: "ok", version: "1.0.0-cloudflare", database: "connected" });
    } catch {
      return json({ status: "error", database: "unavailable" }, 503);
    }
  }

  if (method === "POST" && path === "/api/enroll") {
    let body: any;
    try { body = await request.json(); } catch { return json({ detail: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object" || !validText(body.employee_name, 160)) {
      return json({ detail: "employee_name is required (max 160 characters)." }, 422);
    }
    const deviceName = validText(body.device_name, 160) ? body.device_name.trim() : "PC-" + crypto.randomUUID().slice(0, 8);
    const token = `dev_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    try {
      const result = await env.DB.prepare(
        "INSERT INTO devices (device_name, employee_name, device_token, created_at, is_active, approval_status) VALUES (?, ?, ?, ?, 0, 'pending')"
      ).bind(deviceName, body.employee_name.trim(), token, now).run();
      return json({ device_id: result.meta.last_row_id, device_token: token, approval_status: "pending", message: "Registration request submitted. An administrator must approve this device." });
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("unique")) return json({ detail: "Device name already enrolled. Ask an administrator to check the existing device." }, 409);
      return json({ detail: "Could not enroll device." }, 500);
    }
  }

  // Employee login session accounting. Active time is accumulated only while the
  // interactive agent reports recent user activity; missing shutdown events are
  // bounded by the last successful session heartbeat.
  if (method === "POST" && path.startsWith("/api/session/")) {
    const device = await activeDevice(request, env);
    if (!device) return json({ detail: "Unknown, missing, or revoked device token." }, 401);
    const now = new Date().toISOString();
    if (path === "/api/session/start") {
      await env.DB.batch([
        env.DB.prepare("UPDATE sessions SET ended_at = COALESCE(ended_at, last_heartbeat), end_reason = COALESCE(end_reason, 'recovered') WHERE device_id = ? AND ended_at IS NULL").bind(device.id),
        env.DB.prepare("INSERT INTO sessions (device_id, started_at, last_heartbeat, active_seconds) VALUES (?, ?, ?, 0)").bind(device.id, now, now),
        env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id)
      ]);
      return json({ started: true, started_at: now });
    }
    if (path === "/api/session/heartbeat") {
      let body: any;
      try { body = await request.json(); } catch { return json({ detail: "Invalid JSON body." }, 400); }
      const row = await env.DB.prepare("SELECT id, last_heartbeat FROM sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").bind(device.id).first<{id:number;last_heartbeat:string}>();
      if (!row) return json({ detail: "No active session." }, 409);
      const elapsed = Math.max(0, Math.min(120, Math.floor((Date.parse(now) - Date.parse(row.last_heartbeat)) / 1000)));
      const addActive = body && body.idle === false ? elapsed : 0;
      await env.DB.batch([
        env.DB.prepare("UPDATE sessions SET active_seconds = active_seconds + ?, last_heartbeat = ? WHERE id = ?").bind(addActive, now, row.id),
        env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id)
      ]);
      return json({ ok: true, active_seconds_added: addActive });
    }
    if (path === "/api/session/end") {
      let body: any = {};
      try { body = await request.json(); } catch {}
      const row = await env.DB.prepare("SELECT id, last_heartbeat FROM sessions WHERE device_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").bind(device.id).first<{id:number;last_heartbeat:string}>();
      if (!row) return json({ ended: false, message: "No active session." });
      const elapsed = Math.max(0, Math.min(120, Math.floor((Date.parse(now) - Date.parse(row.last_heartbeat)) / 1000)));
      const addActive = body && body.idle === false ? elapsed : 0;
      await env.DB.batch([
        env.DB.prepare("UPDATE sessions SET active_seconds = active_seconds + ?, ended_at = ?, end_reason = 'logout' WHERE id = ?").bind(addActive, now, row.id),
        env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id)
      ]);
      return json({ ended: true, ended_at: now });
    }
  }

  if (method === "POST" && (path === "/api/heartbeat" || path === "/api/events")) {
    const device = await activeDevice(request, env);
    if (!device) return json({ detail: "Unknown, missing, or revoked device token." }, 401);
    const now = new Date().toISOString();

    if (path === "/api/heartbeat") {
      await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id).run();
      return json({ ok: true, server_time: now });
    }

    let body: any;
    try { body = await request.json(); } catch { return json({ detail: "Invalid JSON body." }, 400); }
    if (!body || !Array.isArray(body.events) || body.events.length > 100) {
      return json({ detail: "events must be an array containing at most 100 items." }, 422);
    }
    const statements: D1PreparedStatement[] = [
      env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id)
    ];
    for (const item of body.events as EventInput[]) {
      if (!item || !validText(item.event_type, 60)) return json({ detail: "Each event needs a valid event_type." }, 422);
      const occurred = item.occurred_at && !Number.isNaN(Date.parse(item.occurred_at))
        ? new Date(item.occurred_at).toISOString() : now;
      statements.push(env.DB.prepare(
        "INSERT INTO activities (device_id, event_type, app_name, file_name, details, idle, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        device.id,
        item.event_type.slice(0, 60),
        typeof item.app_name === "string" ? item.app_name.slice(0, 200) : null,
        typeof item.file_name === "string" ? item.file_name.slice(0, 1024) : null,
        typeof item.details === "string" ? item.details.slice(0, 2000) : null,
        typeof item.idle === "boolean" ? (item.idle ? 1 : 0) : null,
        occurred
      ));
    }
    await env.DB.batch(statements);
    return json({ accepted: body.events.length });
  }

  if (path.startsWith("/api/admin/")) {
    if (!await adminOK(request, env)) return json({ detail: "Admin authentication required" }, 401);

    if (method === "GET" && path === "/api/admin/overview") {
      const now = Date.now();
      const rows = await env.DB.prepare(
        "SELECT id, device_name, employee_name, last_seen FROM devices WHERE is_active = 1 AND approval_status = 'approved' ORDER BY employee_name, device_name"
      ).all<{id:number;device_name:string;employee_name:string;last_seen:string|null}>();
      const pendingRows = await env.DB.prepare(
        "SELECT id, device_name, employee_name, created_at FROM devices WHERE approval_status = 'pending' ORDER BY created_at DESC"
      ).all();
      const devices = rows.results.map(d => {
        const online = !!d.last_seen && now - Date.parse(d.last_seen) <= 3 * 60 * 1000;
        return { ...d, status: online ? "Online" : "Offline" };
      });
      return json({
        registered: devices.length,
        online: devices.filter(d => d.status === "Online").length,
        offline: devices.filter(d => d.status === "Offline").length,
        devices,
        pending: pendingRows.results
      });
    }

    const recoveryMatch = path.match(/^\/api\/admin\/devices\/(\d+)\/recovery-token$/);
    if (method === "GET" && recoveryMatch) {
      const id = Number(recoveryMatch[1]);
      const device = await env.DB.prepare(
        "SELECT id, device_name, employee_name, device_token FROM devices WHERE id = ? AND is_active = 1 AND approval_status = 'approved'"
      ).bind(id).first<{id:number;device_name:string;employee_name:string;device_token:string}>();
      if (!device) return json({ detail: "Approved active device not found." }, 404);
      // This endpoint is available only after ADMIN_TOKEN authentication.
      // It returns the existing token; it does not rotate credentials or change history.
      return json({ device_id: device.id, device_name: device.device_name, employee_name: device.employee_name, device_token: device.device_token });
    }

    if (method === "GET" && path === "/api/admin/sessions") {
      const day = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) return json({ detail: "date must be YYYY-MM-DD" }, 400);
      const rows = await env.DB.prepare(
        "SELECT s.id, d.employee_name AS employee, d.device_name AS device, s.started_at, s.ended_at, s.last_heartbeat, s.active_seconds, s.end_reason FROM sessions s JOIN devices d ON d.id = s.device_id WHERE substr(s.started_at, 1, 10) = ? ORDER BY s.started_at DESC"
      ).bind(day).all();
      const sessions = rows.results.map((r: any) => {
        const stop = r.ended_at || r.last_heartbeat;
        const sessionSeconds = Math.max(0, Math.floor((Date.parse(stop) - Date.parse(r.started_at)) / 1000));
        return { ...r, session_seconds: sessionSeconds, active_seconds: Math.min(sessionSeconds, Number(r.active_seconds || 0)), status: r.ended_at ? "Ended" : "In progress (last heartbeat)" };
      });
      return json({ date: day, sessions });
    }

    if (method === "GET" && path === "/api/admin/activities") {
      const raw = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 500)) : 100;
      const rows = await env.DB.prepare(
        "SELECT d.employee_name AS employee, d.device_name AS device, a.event_type, a.app_name, a.file_name, a.details, a.idle, a.occurred_at FROM activities a JOIN devices d ON d.id = a.device_id ORDER BY a.occurred_at DESC LIMIT ?"
      ).bind(limit).all();
      return json(rows.results);
    }

    const approveMatch = path.match(/^\/api\/admin\/devices\/(\d+)\/approve$/);
    if (method === "POST" && approveMatch) {
      const id = Number(approveMatch[1]);
      const result = await env.DB.prepare("UPDATE devices SET is_active = 1, approval_status = 'approved' WHERE id = ? AND approval_status = 'pending'").bind(id).run();
      if (!result.meta.changes) return json({ detail: "Pending device not found" }, 404);
      return json({ approved: true });
    }

    const revokeMatch = path.match(/^\/api\/admin\/devices\/(\d+)\/revoke$/);
    if (method === "POST" && revokeMatch) {
      const id = Number(revokeMatch[1]);
      const result = await env.DB.prepare("UPDATE devices SET is_active = 0, approval_status = 'revoked' WHERE id = ?").bind(id).run();
      if (!result.meta.changes) return json({ detail: "Device not found" }, 404);
      return json({ revoked: true });
    }
  }

  return json({ detail: "Not found" }, 404);
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("Origin");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Device-Token, X-Dashboard-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (origin) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const response = await handleApi(request, env);
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders(request))) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    }

    // The dashboard is available only through its private, unguessable URL.
    // The same key is checked again on every admin API request.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/admin/")) {
      const match = url.pathname.match(/^\/admin\/([^/]+)\/?$/);
      const supplied = match ? decodeURIComponent(match[1]) : "";
      if (!env.DASHBOARD_KEY || env.DASHBOARD_KEY.length < 32 || !secureEqual(supplied, env.DASHBOARD_KEY)) {
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
      }
      const assetUrl = new URL(request.url);
      assetUrl.pathname = "/index.html";
      assetUrl.search = "";
      const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
      const assetHeaders = new Headers(assetResponse.headers);
      assetHeaders.set("Cache-Control", "no-store");
      assetHeaders.set("Referrer-Policy", "no-referrer");
      return new Response(assetResponse.body, { status: assetResponse.status, headers: assetHeaders });
    }
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
};
