const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Sequential blue ramp, light -> dark (see dataviz skill reference palette).
const RAMP = [
  "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7",
  "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b",
];

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpColor(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const bl = Math.round(b1 + (b2 - b1) * t);
  return `rgb(${r},${g},${bl})`;
}

// Precipitation is right-skewed: a handful of tropical monsoon cells sit far
// above the rest of the globe. Normalizing linearly against the monthly max
// crushes every temperate value (Europe, most of the US, etc.) into the
// bottom ~15% of the range, which reads as "no rain" year-round. A sqrt
// scale keeps the tropics clearly highest while giving low/mid values (most
// of the planet, most of the year) real visual separation.
function normalize(value, max) {
  const t = Math.max(0, Math.min(1, value / max));
  return Math.sqrt(t);
}

function colorForT(t) {
  const scaled = t * (RAMP.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  if (i >= RAMP.length - 1) return RAMP[RAMP.length - 1];
  return lerpColor(RAMP[i], RAMP[i + 1], frac);
}

const map = L.map("map", { worldCopyJump: true }).setView([15, 20], 2);
map.attributionControl.setPrefix(false); // drop Leaflet's own branding, keep tile attribution below
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  subdomains: "abcd",
  maxZoom: 19,
}).addTo(map);

let gridLayer = null;
let currentMax = 1;

const monthInput = document.getElementById("month");
const monthLabel = document.getElementById("month-label");
const legend = document.getElementById("legend");
const cellInfo = document.getElementById("cell-info");
const routeStatus = document.getElementById("route-status");

function renderLegend(max) {
  // Sample colorForT across the *value* domain (not evenly in t) so the
  // gradient bar shows the same sqrt compression the cells are rendered
  // with, rather than a plain linear ramp that would misrepresent it.
  const stops = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const value = (i / steps) * max;
    const pct = (i / steps) * 100;
    stops.push(`${colorForT(normalize(value, max))} ${pct}%`);
  }
  legend.innerHTML = `
    <div class="gradient" style="background:linear-gradient(to right, ${stops.join(",")})"></div>
    <div class="ticks">
      <span>0</span>
      <span>${(max * 0.25).toFixed(0)}</span>
      <span>${(max * 0.5).toFixed(0)}</span>
      <span>${(max * 0.75).toFixed(0)}</span>
      <span>${max.toFixed(0)} mm/month</span>
    </div>
  `;
}

async function loadMonth(month) {
  monthLabel.textContent = MONTH_NAMES[month - 1];
  const res = await fetch(`/api/cells?month=${month}`);
  const geojson = await res.json();

  // Fixed across all months so color intensity is directly comparable as
  // the slider moves, rather than autoscaling each month to its own max.
  currentMax = geojson.global_max_precip_mm_month;
  renderLegend(currentMax);

  if (gridLayer) map.removeLayer(gridLayer);
  gridLayer = L.geoJSON(geojson, {
    style: (feature) => {
      const t = normalize(feature.properties.precip_mm_month, currentMax);
      return {
        fillColor: colorForT(t),
        fillOpacity: 0.25 + 0.7 * t,
        color: "#00000030",
        weight: 0.5,
      };
    },
    onEachFeature: (feature, layer) => {
      layer.on("mouseover", () => {
        cellInfo.textContent = `Cell ${feature.properties.cell_id}: ${feature.properties.precip_mm_month.toFixed(0)} mm/month (${MONTH_NAMES[month - 1]})`;
        layer.setStyle({ color: "#0b0b0b", weight: 2.5 });
        layer.bringToFront();
      });
      layer.on("mouseout", () => {
        cellInfo.textContent = "Hover a cell to see its monthly value.";
        gridLayer.resetStyle(layer);
      });
    },
  }).addTo(map);
}

monthInput.addEventListener("input", () => loadMonth(Number(monthInput.value)));
monthInput.value = new Date().getMonth() + 1;
loadMonth(Number(monthInput.value));

// --- Play through months ---

const playButton = document.getElementById("play-month");
let playTimer = null;

function stopPlaying() {
  clearInterval(playTimer);
  playTimer = null;
  playButton.textContent = "▶"; // ▶
  playButton.setAttribute("aria-label", "Play through months");
}

playButton.addEventListener("click", () => {
  if (playTimer) {
    stopPlaying();
    return;
  }
  playButton.textContent = "⏹"; // ⏹
  playButton.setAttribute("aria-label", "Stop");
  playTimer = setInterval(() => {
    const next = (Number(monthInput.value) % 12) + 1; // wraps Dec (12) -> Jan (1)
    monthInput.value = next;
    loadMonth(next);
  }, 1000);
});

// --- Routing demo (calls a public Valhalla instance by default) ---

let pointA = null;
let pointB = null;
let markerA = null;
let markerB = null;
let routeLayer = null;
let routeBboxLayer = null;

function decodePolyline6(str) {
  let index = 0, lat = 0, lon = 0;
  const coords = [];
  while (index < str.length) {
    let shift = 0, result = 0, byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / 1e6, lon / 1e6]);
  }
  return coords;
}

// Highlights the grid cells within a route's bounding box, using the same
// /api/cells?bbox= endpoint a router would call once per route (see the
// README's "Integration guide for routers"), not a demo-only shortcut.
// Note: this is the bbox's cells, not necessarily every cell the route
// polyline itself crosses, a diagonal route's rectangular bbox can include
// corner cells the path never actually passes through.
async function highlightRouteCells(summary) {
  if (routeBboxLayer) map.removeLayer(routeBboxLayer);
  const bbox = [summary.min_lon, summary.min_lat, summary.max_lon, summary.max_lat].join(",");
  const res = await fetch(`/api/cells?month=${monthInput.value}&bbox=${bbox}`);
  const geojson = await res.json();
  routeBboxLayer = L.geoJSON(geojson, {
    style: { fillOpacity: 0, color: "#e34948", weight: 2.5 },
    interactive: false,
  }).addTo(map);
  return geojson.features.length;
}

async function requestRoute() {
  routeStatus.textContent = "Requesting route from Valhalla…";
  const params = new URLSearchParams({
    lat1: pointA.lat, lon1: pointA.lng,
    lat2: pointB.lat, lon2: pointB.lng,
  });
  try {
    const res = await fetch(`/api/route?${params}`);
    const data = await res.json();
    if (!res.ok) {
      routeStatus.textContent = `Route failed: ${data.error || res.status}`;
      return;
    }
    const leg = data.trip.legs[0];
    const coords = decodePolyline6(leg.shape);
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(coords, { color: "#2a78d6", weight: 4 }).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [40, 40] });
    const cellCount = await highlightRouteCells(data.trip.summary);
    routeStatus.textContent = `Route: ${data.trip.summary.length.toFixed(1)} km, spans ${cellCount} grid cell${cellCount === 1 ? "" : "s"}`;
  } catch (err) {
    routeStatus.textContent = `Could not reach Valhalla: ${err.message}`;
  }
}

map.on("click", (e) => {
  if (!pointA || (pointA && pointB)) {
    if (markerA) map.removeLayer(markerA);
    if (markerB) map.removeLayer(markerB);
    if (routeLayer) map.removeLayer(routeLayer);
    if (routeBboxLayer) map.removeLayer(routeBboxLayer);
    pointA = e.latlng;
    pointB = null;
    markerA = L.marker(pointA).addTo(map).bindTooltip("A", { permanent: true });
    routeStatus.textContent = "Click map to pick end point.";
  } else {
    pointB = e.latlng;
    markerB = L.marker(pointB).addTo(map).bindTooltip("B", { permanent: true });
    requestRoute();
  }
});

document.getElementById("clear-route").addEventListener("click", () => {
  pointA = null;
  pointB = null;
  if (markerA) map.removeLayer(markerA);
  if (markerB) map.removeLayer(markerB);
  if (routeLayer) map.removeLayer(routeLayer);
  if (routeBboxLayer) map.removeLayer(routeBboxLayer);
  routeStatus.textContent = "Click map to pick start point.";
});
