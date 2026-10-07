// Almacenamiento del sistema de reservas en Netlify Blobs.
// Todo el estado vive en un solo documento ("state") y el logo aparte ("logo").
// Las copias de seguridad automáticas van a otro store ("bailarte-copias").
import { getStore } from "@netlify/blobs";

export type Coleccion = "reservas" | "estudiantes" | "historial" | "config";
export interface Estado {
  version: number;
  actualizado: string;
  logoVersion: number;
  reservas: Record<string, any>;
  estudiantes: Record<string, any>;
  historial: Record<string, any>;
  config: Record<string, any>;
  meta: { ultimaCopia: string; cambiosDesdeCopia: number };
}

const esProduccion = () => {
  const ctx = (globalThis as any).Netlify?.context?.deploy?.context;
  return !ctx || ctx === "production";
};
// Los datos de pruebas (deploy previews) nunca se mezclan con los reales
const nombre = (base: string) => (esProduccion() ? base : `${base}-pruebas`);
export const datos = () => getStore({ name: nombre("bailarte-datos"), consistency: "strong" });
export const copias = () => getStore({ name: nombre("bailarte-copias"), consistency: "strong" });

export const vacio = (): Estado => ({
  version: 0, actualizado: new Date().toISOString(), logoVersion: 0,
  reservas: {}, estudiantes: {}, historial: {}, config: {},
  meta: { ultimaCopia: "", cambiosDesdeCopia: 0 },
});

export async function leerEstado(): Promise<Estado> {
  const e = (await datos().get("state", { type: "json" })) as Estado | null;
  if (!e) return vacio();
  e.meta ||= { ultimaCopia: "", cambiosDesdeCopia: 0 };
  return e;
}
export async function guardarEstado(e: Estado) {
  e.actualizado = new Date().toISOString();
  await datos().setJSON("state", e);
}
export async function leerLogo(): Promise<string | null> {
  const l = (await datos().get("logo", { type: "json" })) as { data?: string } | null;
  return l?.data || null;
}

// Bloqueo cooperativo para que dos cambios simultáneos no se pisen
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function conBloqueo<T>(fn: () => Promise<T>): Promise<T> {
  const store = datos(), id = crypto.randomUUID(), limite = Date.now() + 8000;
  let mio = false;
  while (Date.now() < limite) {
    const cur = (await store.get("lock", { type: "json" })) as { id: string; exp: number } | null;
    if (!cur || cur.exp < Date.now()) {
      await store.setJSON("lock", { id, exp: Date.now() + 6000 });
      const chk = (await store.get("lock", { type: "json" })) as { id: string } | null;
      if (chk?.id === id) { mio = true; break; }
    }
    await sleep(60 + Math.random() * 120);
  }
  if (!mio) throw new Error("ocupado");
  try { return await fn(); }
  finally {
    const cur = (await store.get("lock", { type: "json" })) as { id: string } | null;
    if (cur?.id === id) await store.delete("lock");
  }
}

// ---------- Copias de seguridad ----------
export function aCopia(e: Estado, logo: string | null) {
  return {
    app: "bailarte-auditorio-getsemani", version: 1, fecha: new Date().toISOString(),
    evento: e.config.evento || null, secciones: e.config.secciones || null, logo,
    estudiantes: e.estudiantes, reservas: e.reservas, historial: e.historial,
  };
}
const MAX_COPIAS = 150;
export async function crearCopia(e: Estado, tipo: string) {
  const logo = await leerLogo();
  const ocupadas = Object.values(e.reservas).filter((r: any) => r?.estado === "reservado").length;
  const fecha = new Date().toISOString();
  const key = `copia/${fecha}__${tipo}__r${ocupadas}_e${Object.keys(e.estudiantes).length}_h${Object.keys(e.historial).length}`;
  await copias().setJSON(key, aCopia(e, logo));
  e.meta.ultimaCopia = fecha;
  e.meta.cambiosDesdeCopia = 0;
  // conservar solo las más recientes
  const { blobs } = await copias().list({ prefix: "copia/" });
  const viejas = blobs.map((b) => b.key).sort().reverse().slice(MAX_COPIAS);
  for (const k of viejas) await copias().delete(k);
  return key;
}
export async function listarCopias() {
  const { blobs } = await copias().list({ prefix: "copia/" });
  return blobs.map((b) => b.key).sort().reverse().map((key) => {
    const [fecha, tipo, cuentas] = key.slice(6).split("__");
    const m = /r(\d+)_e(\d+)_h(\d+)/.exec(cuentas || "") || [];
    return { key, fecha, tipo, reservas: +(m[1] || 0), estudiantes: +(m[2] || 0), historial: +(m[3] || 0) };
  });
}

// Copia automática cuando hay muchos cambios o pasó una hora desde la última
export function tocaCopia(e: Estado) {
  const pasado = e.meta.ultimaCopia ? Date.now() - Date.parse(e.meta.ultimaCopia) : Infinity;
  return e.meta.cambiosDesdeCopia >= 25 || (e.meta.cambiosDesdeCopia > 0 && pasado > 60 * 60 * 1000);
}
