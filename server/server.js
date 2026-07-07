const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");

const DB_PATH = process.env.PRECIP_DB || path.join(__dirname, "..", "data", "precip_grid.sqlite");
// Defaults to FOSSGIS/OpenStreetMap Germany's public Valhalla demo instance,
// good enough to show the grid alongside a real route with zero local setup.
// Point VALHALLA_URL at http://localhost:8002 if you're running your own
// (see docker/docker-compose.yml) for a specific region or heavier use.
const VALHALLA_URL = process.env.VALHALLA_URL || "https://valhalla1.openstreetmap.de";
const PORT = process.env.PORT || 3000;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const GRID = db.prepare("SELECT value FROM meta WHERE key = 'grid_shape'").get().value;
const [N_LAT, N_LON] = GRID.split("x").map(Number);
const CELL_SIZE = Number(db.prepare("SELECT value FROM meta WHERE key = 'cell_size_deg'").get().value);

function cellIdFor(lat, lon) {
  const row = Math.min(N_LAT - 1, Math.max(0, Math.floor((90 - lat) / CELL_SIZE)));
  const lonAdj = ((lon % 360) + 360) % 360;
  const col = Math.min(N_LON - 1, Math.max(0, Math.floor(lonAdj / CELL_SIZE)));
  return row * N_LON + col;
}

const precipStmt = db.prepare(
  `SELECT c.id, c.lat_center, c.lon_center, c.lat_min, c.lat_max, c.lon_min, c.lon_max,
          p.precip_mm_day, p.precip_mm_month, p.valid_yr_count
   FROM cells c LEFT JOIN monthly_precip p ON p.cell_id = c.id AND p.month = ?
   WHERE c.id = ?`
);

const cellsStmt = db.prepare(
  `SELECT c.id, c.lat_min, c.lat_max, c.lon_min, c.lon_max, p.precip_mm_day, p.precip_mm_month
   FROM cells c LEFT JOIN monthly_precip p ON p.cell_id = c.id AND p.month = ?`
);

// Fixed across all months (not recomputed per-request) so the color scale is
// directly comparable as you move the month slider: per-month maxes range
// from ~430 to ~784 mm, autoscaling each month to its own max would make a
// dry month look just as saturated as a wet one.
const GLOBAL_MAX_PRECIP_MM_MONTH = db
  .prepare("SELECT MAX(precip_mm_month) AS max FROM monthly_precip")
  .get().max;

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/precip", (req, res) => {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const month = Number(req.query.month);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || month < 1 || month > 12) {
    return res.status(400).json({ error: "lat, lon, month (1-12) are required" });
  }
  const row = precipStmt.get(month, cellIdFor(lat, lon));
  if (!row) return res.status(404).json({ error: "no cell found" });
  res.json({
    cell_id: row.id,
    lat_center: row.lat_center,
    lon_center: row.lon_center,
    bbox: [row.lon_min, row.lat_min, row.lon_max, row.lat_max],
    month,
    precip_mm_month: row.precip_mm_month,
    precip_mm_day: row.precip_mm_day,
    valid_yr_count: row.valid_yr_count,
  });
});

app.get("/api/cells", (req, res) => {
  const month = Number(req.query.month) || 1;
  const rows = cellsStmt.all(month);
  const features = rows
    .filter((r) => r.precip_mm_month !== null)
    .map((r) => ({
      type: "Feature",
      properties: { cell_id: r.id, precip_mm_month: r.precip_mm_month, precip_mm_day: r.precip_mm_day },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [r.lon_min, r.lat_min],
            [r.lon_max, r.lat_min],
            [r.lon_max, r.lat_max],
            [r.lon_min, r.lat_max],
            [r.lon_min, r.lat_min],
          ],
        ],
      },
    }));
  res.json({
    type: "FeatureCollection",
    features,
    global_max_precip_mm_month: GLOBAL_MAX_PRECIP_MM_MONTH,
  });
});

app.get("/api/route", async (req, res) => {
  const { lat1, lon1, lat2, lon2, costing } = req.query;
  if (!lat1 || !lon1 || !lat2 || !lon2) {
    return res.status(400).json({ error: "lat1, lon1, lat2, lon2 are required" });
  }
  const body = {
    locations: [
      { lat: Number(lat1), lon: Number(lon1) },
      { lat: Number(lat2), lon: Number(lon2) },
    ],
    costing: costing || "auto",
  };
  try {
    const upstream = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `could not reach Valhalla at ${VALHALLA_URL}`, detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`monthly-precipitation-grid demo server on http://localhost:${PORT}`);
  console.log(`  precip DB: ${DB_PATH}`);
  console.log(`  Valhalla:  ${VALHALLA_URL}`);
});
