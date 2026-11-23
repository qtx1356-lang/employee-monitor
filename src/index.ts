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
    if (!env.ENROLLMENT_CODE || env.ENROLLMENT_CODE.length < 16) {
      return json({ detail: "Enrollment is not configured securely." }, 503);
    }
    let body: any;
    try { body = await request.json(); } catch { return json({ detail: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object" ||
        !secureEqual(String(body.enrollment_code || ""), env.ENROLLMENT_CODE)) {
      return json({ detail: "Invalid enrollment code" }, 403);
    }
    if (!validText(body.device_name, 160) || !validText(body.employee_name, 160)) {
      return json({ detail: "device_name and employee_name are required (max 160 characters)." }, 422);
    }
    const token = `dev_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    try {
      const result = await env.DB.prepare(
        "INSERT INTO devices (device_name, employee_name, device_token, created_at, is_active) VALUES (?, ?, ?, ?, 1)"
      ).bind(body.device_name.trim(), body.employee_name.trim(), token, now).run();
      return json({ device_id: result.meta.last_row_id, device_token: token, message: "Device enrolled. Store the token securely." });
    } catch (error) {
      const message = String(error);
      if (message.toLowerCase().includes("unique")) return json({ detail: "Device name already enrolled" }, 409);
      return json({ detail: "Could not enroll device." }, 500);
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
        "SELECT id, device_name, employee_name, last_seen FROM devices WHERE is_active = 1 ORDER BY employee_name, device_name"
      ).all<{id:number;device_name:string;employee_name:string;last_seen:string|null}>();
      const devices = rows.results.map(d => {
        const online = !!d.last_seen && now - Date.parse(d.last_seen) <= 3 * 60 * 1000;
        return { ...d, status: online ? "Online" : "Offline" };
      });
      return json({
        registered: devices.length,
        online: devices.filter(d => d.status === "Online").length,
        offline: devices.filter(d => d.status === "Offline").length,
        devices
      });
    }

    if (method === "GET" && path === "/api/admin/activities") {
      const raw = Number(url.searchParams.get("limit") || 100);
      const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 500)) : 100;
      const rows = await env.DB.prepare(
        "SELECT d.employee_name AS employee, d.device_name AS device, a.event_type, a.app_name, a.file_name, a.details, a.idle, a.occurred_at FROM activities a JOIN devices d ON d.id = a.device_id ORDER BY a.occurred_at DESC LIMIT ?"
      ).bind(limit).all();
      return json(rows.results);
    }

    const revokeMatch = path.match(/^\/api\/admin\/devices\/(\d+)\/revoke$/);
    if (method === "POST" && revokeMatch) {
      const id = Number(revokeMatch[1]);
      const result = await env.DB.prepare("UPDATE devices SET is_active = 0 WHERE id = ?").bind(id).run();
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
