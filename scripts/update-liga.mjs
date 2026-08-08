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

  const table = (standingsData.standings || []).find((s) => s.type === "TOTAL")?.table || [];
  const rows = table.map((row) => ({
    pos: row.position,
    name: teamName(row.team),
    pj: row.playedGames,
    g: row.won,
    e: row.draw,
    p: row.lost,
    gf: row.goalsFor,
    gc: row.goalsAgainst,
    dg: row.goalDifference,
    pts: row.points,
  }));

  let matchesCurrent = await getMatchday(currentMatchday);
  let finishedCurrent = matchesCurrent.filter((m) => m.status === "FINISHED");

  let resultsMatchday = currentMatchday;
  let resultsMatches = finishedCurrent;
  let nextStart = currentMatchday + 1;

  if (finishedCurrent.length === 0 && currentMatchday > 1) {
    // La jornada actual aún no se ha jugado: mostramos la anterior como "resultados".
    resultsMatchday = currentMatchday - 1;
    resultsMatches = (await getMatchday(resultsMatchday)).filter((m) => m.status === "FINISHED");
    nextStart = currentMatchday;
  }

  const now = Date.now();
  const resultados = {
    label: `Jornada ${resultsMatchday}`,
    updatedAt: now,
    matches: resultsMatches.map(toResultMatch),
  };

  const proximas = [];
  for (let md = nextStart; md < nextStart + 2; md++) {
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
