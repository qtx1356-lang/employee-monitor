export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
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
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24) return false;
  return secureEqual(bearer(request), env.ADMIN_TOKEN);
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


  if (method === "POST" && path === "/api/session") {
    const device = await activeDevice(request, env);
    if (!device) return json({ detail: "Unknown, missing, or revoked device token." }, 401);
    let body: any;
    try { body = await request.json(); } catch { return json({ detail: "Invalid JSON body." }, 400); }
    if (!body || !validText(body.session_id, 100) || !["start", "tick", "end"].includes(body.action)) {
      return json({ detail: "session_id and action (start, tick, end) are required." }, 422);
    }
    const now = new Date().toISOString();
    if (body.action === "start") {
      const started = body.started_at && !Number.isNaN(Date.parse(body.started_at)) ? new Date(body.started_at).toISOString() : now;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO employee_sessions (id, device_id, started_at, last_activity_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(body.session_id, device.id, started, started, now, now).run();
      await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id).run();
      return json({ ok: true, session_id: body.session_id });
    }
    const session = await env.DB.prepare(
      "SELECT id FROM employee_sessions WHERE id = ? AND device_id = ? AND ended_at IS NULL"
    ).bind(body.session_id, device.id).first();
    if (!session) return json({ detail: "Active session not found." }, 404);
    if (body.action === "tick") {
      const active = Number.isInteger(body.active_seconds) ? Math.max(0, Math.min(body.active_seconds, 120)) : 0;
      const idle = Number.isInteger(body.idle_seconds) ? Math.max(0, Math.min(body.idle_seconds, 120)) : 0;
      const activityAt = body.last_activity_at && !Number.isNaN(Date.parse(body.last_activity_at)) ? new Date(body.last_activity_at).toISOString() : now;
      await env.DB.batch([
        env.DB.prepare("UPDATE employee_sessions SET active_seconds = active_seconds + ?, idle_seconds = idle_seconds + ?, last_activity_at = ?, updated_at = ? WHERE id = ? AND device_id = ? AND ended_at IS NULL")
          .bind(active, idle, activityAt, now, body.session_id, device.id),
        env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id)
      ]);
      return json({ ok: true });
    }
    const ended = body.ended_at && !Number.isNaN(Date.parse(body.ended_at)) ? new Date(body.ended_at).toISOString() : now;
    const reason = validText(body.end_reason, 40) ? body.end_reason.slice(0, 40) : "user_logoff";
    await env.DB.prepare(
      "UPDATE employee_sessions SET ended_at = ?, end_reason = ?, updated_at = ? WHERE id = ? AND device_id = ? AND ended_at IS NULL"
    ).bind(ended, reason, now, body.session_id, device.id).run();
    await env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(now, device.id).run();
    return json({ ok: true });
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


    if (method === "GET" && path === "/api/admin/sessions") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return json({ detail: "date must be YYYY-MM-DD." }, 422);
      const rows = await env.DB.prepare(
        "SELECT s.id, d.employee_name, d.device_name, s.started_at, s.ended_at, s.active_seconds, s.idle_seconds, s.end_reason FROM employee_sessions s JOIN devices d ON d.id = s.device_id WHERE substr(s.started_at, 1, 10) = ? ORDER BY s.started_at DESC"
      ).bind(date).all();
      const sessions = rows.results;
      const totals = sessions.reduce((acc: any, s: any) => {
        const start = Date.parse(String(s.started_at));
        const end = s.ended_at ? Date.parse(String(s.ended_at)) : Date.now();
        acc.session_seconds += Math.max(0, Math.floor((end - start) / 1000));
        acc.active_seconds += Number(s.active_seconds || 0);
        acc.idle_seconds += Number(s.idle_seconds || 0);
        return acc;
      }, { session_seconds: 0, active_seconds: 0, idle_seconds: 0 });
      return json({ date, totals, sessions });
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
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Device-Token",
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
    return env.ASSETS.fetch(request);
  }
};
