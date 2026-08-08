// Genera data/liga.json a partir de la API de football-data.org (LaLiga = competición "PD").
// Se ejecuta una vez al día desde .github/workflows/update-liga.yml.
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

function toResultMatch(m) {
  const team1 = teamName(m.homeTeam);
  const team2 = teamName(m.awayTeam);
  const home = m.score?.fullTime?.home;
  const away = m.score?.fullTime?.away;
  const extra = home != null && away != null ? `${home}-${away}` : "";
  return { team1, team2, extra, raw: `${team1} ${extra} ${team2}`.trim() };
}

function toFixtureMatch(m) {
  const team1 = teamName(m.homeTeam);
  const team2 = teamName(m.awayTeam);
  const extra = fmtKickoff(m.utcDate);
  return { team1, team2, extra, raw: `${extra} ${team1} - ${team2}`.trim() };
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

  const FIXTURE_WINDOW = 5; // cuántas próximas jornadas mostrar por delante (ventana deslizante)

  const finishedCurrent = (await getMatchday(currentMatchday)).filter((m) => m.status === "FINISHED");

  let resultsMatchday, resultsMatches, nextStart;
  if (finishedCurrent.length > 0) {
    // La jornada actual ya tiene partidos jugados: es la que se muestra como "resultados".
    resultsMatchday = currentMatchday;
    resultsMatches = finishedCurrent;
    nextStart = currentMatchday + 1;
  } else if (currentMatchday > 1) {
    // La jornada actual todavía no se ha jugado: mostramos la anterior como "resultados".
    resultsMatchday = currentMatchday - 1;
    resultsMatches = (await getMatchday(resultsMatchday)).filter((m) => m.status === "FINISHED");
    nextStart = currentMatchday;
  } else {
    // Pretemporada: todavía no hay ninguna jornada jugada.
    resultsMatchday = null;
    resultsMatches = [];
    nextStart = currentMatchday; // empieza la ventana de próximos partidos en la Jornada 1
  }

  const now = Date.now();
  const resultados = {
    label: resultsMatchday ? `Jornada ${resultsMatchday}` : "Sin resultados todavía",
    updatedAt: now,
    matches: resultsMatches.map(toResultMatch),
  };

  // Ventana deslizante de FIXTURE_WINDOW jornadas por delante de la última jugada.
  // Al terminar una jornada, esta ventana avanza sola (nextStart sube) y añade la siguiente;
  // cerca del final de temporada, las jornadas que no existen devuelven 0 partidos y se omiten.
  const proximas = [];
  for (let md = nextStart; md < nextStart + FIXTURE_WINDOW; md++) {
    const matches = (await getMatchday(md)).filter(
      (m) => m.status === "SCHEDULED" || m.status === "TIMED" || m.status === "POSTPONED"
    );
    if (matches.length) {
      proximas.push({
        id: `md-${md}`,
        label: `Jornada ${md}`,
        updatedAt: now,
        matches: matches.map(toFixtureMatch),
      });
    }
  }

  const seed = {
    generatedAt: now,
    resultados,
    proximas,
    clasificacion: { updatedAt: now, rows },
  };

  await writeFile(OUT_PATH, JSON.stringify(seed, null, 2) + "\n", "utf8");
  console.log(`data/liga.json actualizado. Jornada actual: ${currentMatchday}. Equipos en tabla: ${rows.length}.`);
}

main().catch((e) => {
  console.error("Fallo actualizando la liga:", e.message);
  process.exit(1);
});
