import type { Config, Context } from "@netlify/functions";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type Coleccion, type Estado, leerEstado, guardarEstado, leerLogo, datos, copias,
  conBloqueo, crearCopia, listarCopias, tocaCopia, aCopia,
} from "../lib/datos.mts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const error = (code: string, message: string, status: number) => json({ error: code, message }, status);

const hash = (s: string) => createHash("sha256").update(s).digest();
function autorizado(req: Request): "ok" | "sin_clave" | "no" {
  const clave = Netlify.env.get("ADMIN_PASSWORD");
  if (!clave) return "sin_clave";
  const dada = req.headers.get("x-clave") || "";
  return timingSafeEqual(hash(clave), hash(dada)) ? "ok" : "no";
}

const COLS: Coleccion[] = ["reservas", "estudiantes", "historial", "config"];
const ID_OK = /^[A-Za-z0-9_\-.:@+~]{1,120}$/;
type Op = { col: Coleccion; id: string; body: Record<string, unknown> | null };

function validar(ops: unknown): Op[] {
  if (!Array.isArray(ops) || !ops.length || ops.length > 500) throw new Error("operaciones inválidas");
  return ops.map((o: any) => {
    if (!COLS.includes(o?.col) || typeof o?.id !== "string" || !ID_OK.test(o.id)) throw new Error("operación inválida");
    if (o.body !== null && (typeof o.body !== "object" || Array.isArray(o.body))) throw new Error("contenido inválido");
    const tam = o.body ? JSON.stringify(o.body).length : 0;
    if (tam > (o.col === "config" && o.id === "logo" ? 400_000 : 50_000)) throw new Error("contenido demasiado grande");
    return { col: o.col, id: o.id, body: o.body };
  });
}

async function escribir(ops: Op[]) {
  return conBloqueo(async () => {
    const e = await leerEstado();
    // Una silla ocupada no se le puede asignar a otra estudiante
    const tomadas = ops.filter((o) => {
      if (o.col !== "reservas" || !o.body || o.body.estado !== "reservado") return false;
      const actual = e.reservas[o.id];
      return actual?.estado && !(actual.estado === "reservado" && actual.estudianteId === o.body.estudianteId);
    }).map((o) => o.id);
    if (tomadas.length) return { tomadas };
    for (const o of ops) {
      if (o.col === "config" && o.id === "logo") {
        if (o.body?.data) await datos().setJSON("logo", { data: o.body.data });
        else await datos().delete("logo");
        e.logoVersion = (e.logoVersion || 0) + 1;
        continue;
      }
      const bucket = e[o.col] as Record<string, unknown>;
      if (o.body) bucket[o.id] = o.body; else delete bucket[o.id];
    }
    e.version += 1;
    e.meta.cambiosDesdeCopia += ops.filter((o) => !(o.col === "config" && o.id === "respaldo")).length;
    if (tocaCopia(e)) { try { await crearCopia(e, "auto"); } catch { /* la copia nunca bloquea un cambio */ } }
    await guardarEstado(e);
    return { version: e.version, logoVersion: e.logoVersion };
  });
}

function sinMeta(e: Estado) {
  return { reservas: e.reservas, estudiantes: e.estudiantes, historial: e.historial, config: e.config };
}

async function restaurar(copia: any, origen: string) {
  if (copia?.app !== "bailarte-auditorio-getsemani" || typeof copia.reservas !== "object") throw new Error("no es una copia de este sistema");
  return conBloqueo(async () => {
    const e = await leerEstado();
    await crearCopia(e, "antes-de-restaurar");
    const obj = (o: any) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
    e.reservas = obj(copia.reservas); e.estudiantes = obj(copia.estudiantes); e.historial = obj(copia.historial);
    e.config = { ...e.config };
    if (copia.evento) e.config.evento = copia.evento;
    if (copia.secciones) e.config.secciones = copia.secciones;
    if (typeof copia.logo === "string" && copia.logo.startsWith("data:image/")) await datos().setJSON("logo", { data: copia.logo });
    else await datos().delete("logo");
    e.logoVersion = (e.logoVersion || 0) + 1;
    e.version += 1;
    e.meta.cambiosDesdeCopia = 0;
    await guardarEstado(e);
    return { version: e.version, origen };
  });
}

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const auth = autorizado(req);
  if (auth === "sin_clave") return error("no_password", "Falta configurar la clave del sistema en Netlify (variable ADMIN_PASSWORD).", 503);
  if (auth === "no") return error("auth", "Clave incorrecta.", 401);

  try {
    if (req.method === "GET" && ruta === "ping") return json({ ok: true });

    if (req.method === "GET" && ruta === "state") {
      const e = await leerEstado();
      const v = Number(url.searchParams.get("v"));
      if (v === e.version) return json({ version: e.version, same: true });
      return json({ version: e.version, logoVersion: e.logoVersion || 0, data: sinMeta(e), ultimaCopiaNube: e.meta.ultimaCopia });
    }

    if (req.method === "GET" && ruta === "logo") return json({ data: await leerLogo() });

    if (req.method === "POST" && ruta === "write") {
      let ops: Op[];
      try { ops = validar((await req.json())?.ops); } catch (err: any) { return error("invalid_argument", err.message, 400); }
      const r = await escribir(ops);
      if ("tomadas" in r) return error("taken", `Ya están ocupadas: ${r.tomadas.join(", ")}.`, 409);
      return json(r);
    }

    if (req.method === "GET" && ruta === "backups") return json({ copias: (await listarCopias()).slice(0, 40) });

    if (req.method === "GET" && ruta.startsWith("backups/")) {
      const key = decodeURIComponent(ruta.slice(8));
      if (!key.startsWith("copia/")) return error("invalid_argument", "Copia inválida.", 400);
      const c = await copias().get(key, { type: "json" });
      return c ? json(c) : error("not_found", "No existe esa copia.", 404);
    }

    if (req.method === "POST" && ruta === "backup") {
      const key = await conBloqueo(async () => { const e = await leerEstado(); const k = await crearCopia(e, "manual"); await guardarEstado(e); return k; });
      return json({ key });
    }

    if (req.method === "GET" && ruta === "export") {
      const e = await leerEstado();
      return json(aCopia(e, await leerLogo()));
    }

    if (req.method === "POST" && ruta === "restore") {
      const body = await req.json();
      let copia = body?.data;
      if (body?.key) {
        if (!String(body.key).startsWith("copia/")) return error("invalid_argument", "Copia inválida.", 400);
        copia = await copias().get(body.key, { type: "json" });
        if (!copia) return error("not_found", "No existe esa copia.", 404);
      }
      try { return json(await restaurar(copia, body?.key || "archivo")); }
      catch (err: any) { if (err.message === "ocupado") throw err; return error("invalid_argument", err.message, 400); }
    }

    return error("not_found", "Ruta desconocida.", 404);
  } catch (err: any) {
    if (err?.message === "ocupado") return error("unavailable", "El sistema está guardando otro cambio. Intenta de nuevo.", 503);
    console.error(err);
    return error("unavailable", "Error del servidor. Intenta de nuevo.", 500);
  }
};

export const config: Config = { path: "/api/*" };
