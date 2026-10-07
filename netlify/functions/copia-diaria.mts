import type { Config } from "@netlify/functions";
import { leerEstado, guardarEstado, crearCopia, conBloqueo } from "../lib/datos.mts";

// Copia de seguridad diaria en la nube (3:00 a. m. hora de Colombia = 08:00 UTC).
// Solo se crea si hubo cambios desde la última copia.
export default async () => {
  await conBloqueo(async () => {
    const e = await leerEstado();
    if (e.version === 0 || e.meta.cambiosDesdeCopia === 0) return;
    await crearCopia(e, "diaria");
    await guardarEstado(e);
  });
};

export const config: Config = { schedule: "0 8 * * *" };
