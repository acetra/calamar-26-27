// Genera data/liga.json a partir de la API de football-data.org (LaLiga = competición "PD").
// Se ejecuta 2 veces al día (00:05 y 12:05 UTC) desde .github/workflows/update-liga.yml.
// Si algo falla, el script termina con código de error y NO toca el liga.json existente,
// para no reemplazar datos buenos por un fallo puntual de la API.

import { writeFile } from "node:fs/promises";

const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const OUT_PATH = new URL("../data/liga.json", import.meta.url);
const BASE = "https://api.football-data.org/v4";
const COMPETITION = "PD"; // LaLiga (Primera División)

if (!API_KEY) {
  console.error("Falta la variable de entorno FOOTBALL_DATA_API_KEY.");
  process.exit(1);
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "X-Auth-Token": API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function teamName(team) {
  return team?.shortName || team?.name || "?";
}

function fmtKickoff(utcDate) {
  try {
    return new Date(utcDate).toLocaleString("es-ES", {
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Madrid",
    });
  } catch {
    return "";
  }
}

// Cada partido se formatea según su propio estado (marcador si ya se jugó, hora
// si no), en vez de asumir que todos los partidos de una jornada comparten
// estado: el calendario a veces mezcla partidos adelantados/aplazados y una
// misma jornada puede tener partidos jugados y por jugar a la vez.
function toMatch(m) {
  const team1 = teamName(m.homeTeam);
  const team2 = teamName(m.awayTeam);
  const home = m.score?.fullTime?.home;
  const away = m.score?.fullTime?.away;
  const finished = m.status === "FINISHED" && home != null && away != null;
  const extra = finished ? `${home}-${away}` : fmtKickoff(m.utcDate);
  const raw = finished ? `${team1} ${extra} ${team2}`.trim() : `${extra} ${team1} - ${team2}`.trim();
  return { team1, team2, extra, raw };
}

async function getMatchday(n) {
  if (n < 1) return [];
  try {
    const data = await apiGet(`/competitions/${COMPETITION}/matches?matchday=${n}`);
    return data.matches || [];
  } catch (e) {
    console.warn(`No se pudo leer la jornada ${n}: ${e.message}`);
    return [];
  }
}

async function main() {
  const standingsData = await apiGet(`/competitions/${COMPETITION}/standings`);
  const currentMatchday = standingsData?.season?.currentMatchday || 1;

  // La API a veces devuelve la tabla completa de la temporada anterior como
  // placeholder hasta que se juega el primer partido de la nueva. Si la fecha
  // de inicio de temporada todavía no ha llegado, no confiamos en esos
  // números y publicamos la tabla a cero para no mostrar datos engañosos.
  const seasonStartDate = standingsData?.season?.startDate ? new Date(standingsData.season.startDate) : null;
  const seasonNotStartedYet = seasonStartDate ? Date.now() < seasonStartDate.getTime() : false;

  const table = (standingsData.standings || []).find((s) => s.type === "TOTAL")?.table || [];
  const rows = table.map((row) => ({
    pos: row.position,
    name: teamName(row.team),
    pj: seasonNotStartedYet ? 0 : row.playedGames,
    g: seasonNotStartedYet ? 0 : row.won,
    e: seasonNotStartedYet ? 0 : row.draw,
    p: seasonNotStartedYet ? 0 : row.lost,
    gf: seasonNotStartedYet ? 0 : row.goalsFor,
    gc: seasonNotStartedYet ? 0 : row.goalsAgainst,
    dg: seasonNotStartedYet ? 0 : row.goalDifference,
    pts: seasonNotStartedYet ? 0 : row.points,
  }));

  // Ventana de jornadas a publicar en esta pasada: unas cuantas hacia atrás
  // (por si el calendario ha dejado partidos aplazados de jornadas ya
  // "cerradas" sin jugar todavía) y varias hacia delante. El sitio conserva
  // aparte cualquier jornada anterior que ya se le hubiera enviado en una
  // pasada previa, así que no hace falta —ni conviene— repetirla aquí.
  const LOOKBACK = 4;
  const FIXTURE_WINDOW = 5;
  const startMatchday = Math.max(1, currentMatchday - LOOKBACK);
  const endMatchday = currentMatchday + FIXTURE_WINDOW;

  const now = Date.now();
  const jornadas = [];
  for (let md = startMatchday; md <= endMatchday; md++) {
    const matches = await getMatchday(md);
    if (!matches.length) continue;
    jornadas.push({
      id: `md-${md}`,
      matchday: md,
      label: `Jornada ${md}`,
      updatedAt: now,
      matches: matches.map(toMatch),
    });
  }

  const seed = {
    generatedAt: now,
    jornadas,
    clasificacion: { updatedAt: now, rows },
  };

  await writeFile(OUT_PATH, JSON.stringify(seed, null, 2) + "\n", "utf8");
  console.log(`data/liga.json actualizado. Jornada actual: ${currentMatchday}. Jornadas publicadas: ${jornadas.length}. Equipos en tabla: ${rows.length}.`);
}

main().catch((e) => {
  console.error("Fallo actualizando la liga:", e.message);
  process.exit(1);
});
