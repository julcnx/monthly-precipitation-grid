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

function colorForValue(value, max) {
  const t = Math.max(0, Math.min(1, value / max));
  const scaled = t * (RAMP.length - 1);
  const i = Math.floor(scaled);
  const frac = scaled - i;
  if (i >= RAMP.length - 1) return RAMP[RAMP.length - 1];
  return lerpColor(RAMP[i], RAMP[i + 1], frac);
}

const map = L.map("map", { worldCopyJump: true }).setView([15, 20], 2);
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
  const gradientCss = `linear-gradient(to right, ${RAMP.join(",")})`;
  legend.innerHTML = `
    <div class="gradient" style="background:${gradientCss}"></div>
    <div class="ticks"><span>0 mm/day</span><span>${max.toFixed(1)} mm/day</span></div>
  `;
}

async function loadMonth(month) {
  monthLabel.textContent = MONTH_NAMES[month - 1];
  const res = await fetch(`/api/cells?month=${month}`);
  const geojson = await res.json();

  currentMax = geojson.features.reduce(
    (m, f) => Math.max(m, f.properties.precip_mm_day || 0),
    0.001
  );
  renderLegend(currentMax);

  if (gridLayer) map.removeLayer(gridLayer);
  gridLayer = L.geoJSON(geojson, {
    style: (feature) => {
      const t = Math.max(0, Math.min(1, feature.properties.precip_mm_day / currentMax));
      return {
        fillColor: colorForValue(feature.properties.precip_mm_day, currentMax),
        fillOpacity: 0.12 + 0.6 * t,
        color: "#00000022",
        weight: 0.5,
      };
    },
    onEachFeature: (feature, layer) => {
      layer.on("mouseover", () => {
        cellInfo.textContent = `Cell ${feature.properties.cell_id}: ${feature.properties.precip_mm_day.toFixed(2)} mm/day (${MONTH_NAMES[month - 1]})`;
      });
    },
  }).addTo(map);
}

monthInput.addEventListener("input", () => loadMonth(Number(monthInput.value)));
monthInput.value = new Date().getMonth() + 1;
loadMonth(Number(monthInput.value));

// --- Routing demo (calls a public Valhalla instance by default) ---

let pointA = null;
let pointB = null;
let markerA = null;
let markerB = null;
let routeLayer = null;

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
    routeStatus.textContent = `Route: ${(data.trip.summary.length).toFixed(1)} km`;
  } catch (err) {
    routeStatus.textContent = `Could not reach Valhalla: ${err.message}`;
  }
}

map.on("click", (e) => {
  if (!pointA || (pointA && pointB)) {
    if (markerA) map.removeLayer(markerA);
    if (markerB) map.removeLayer(markerB);
    if (routeLayer) map.removeLayer(routeLayer);
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
  routeStatus.textContent = "Click map to pick start point.";
});
