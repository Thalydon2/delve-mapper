// Delve Mapper editor, mounted into an Obsidian view.
import MARKUP from "./markup.html";
export function mountEditor(root, opts) {
root.innerHTML = MARKUP;
const $ = n => root.querySelector('[data-dm="' + n + '"]');
const appEl = root.querySelector(".app");

const CELL = 32;               // world units per grid square
const PAPER = "#f6f4ef";
const INK = "#1f1b18";

// ---------- deterministic noise ----------
function h(x, y, k) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(k | 0, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
const key = (x, y) => x + "," + y;

// ---------- state ----------
// Layers, bottom to top. Each has its own floor squares and its own wall/surroundings style.
let layers = [];           // {id, name, visible, style: {bg, depth, wallW, shadow}, cells: Map "x,y" -> texture, cache}
let activeId = 0, nextLayerId = 1;
let cells = new Map();     // the selected layer's squares (editing tools write here)
let walls = new Set();     // interior wall edges "h:x:y" / "v:x:y"
let doors = new Set();
const DEFAULT_STYLE = { bg: "hatch", depth: 1, wallW: 0.18, grid: true, shadow: true, over: false, ppc: opts.ppc || 70, ...(opts.defaultStyle || {}) };
let style = { ...DEFAULT_STYLE };   // map-wide: grid, ppc
const LAYER_KEYS = ["bg", "depth", "wallW", "shadow", "over"];
const layerStyle = (src = DEFAULT_STYLE) => { const o = {}; for (const k of LAYER_KEYS) o[k] = src[k] ?? DEFAULT_STYLE[k]; return o; };
const mapStyle = () => style;
function makeLayer(name, st) { return { id: nextLayerId++, name, visible: true, style: layerStyle(st), cells: new Map(), cache: null }; }
const activeLayer = () => layers.find(L => L.id === activeId) || layers[layers.length - 1];
function setActive(id) { activeId = id; const L = activeLayer(); cells = L ? L.cells : new Map(); }
let props = [];            // {id, t, x, y (cell units, centre), r (radians), s (scale)}
let nextId = 1;
let curProp = "table";
let selected = null;
let ghostRot = 0;
let curTex = "flag";
let tool = "room";
const undoStack = [], redoStack = [];

// derived
let floorList = [], doorEdges = [];   // all layers combined (bounds, doors)
const isFloor = (x, y) => { const k = key(x, y); for (const L of layers) if (L.cells.has(k)) return true; return false; };
function edgeCells(e) { // returns [ax,ay,bx,by]
  const [o, xs, ys] = e.split(":"); const x = +xs, y = +ys;
  return o === "h" ? [x, y - 1, x, y] : [x - 1, y, x, y];
}
function edgeTouchesFloor(e) { const [a, b, c, d] = edgeCells(e); return isFloor(a, b) || isFloor(c, d); }

function rebuild() {
  // prune orphans
  for (const e of [...walls]) { const [a,b,c,d] = edgeCells(e); if (!(isFloor(a,b) && isFloor(c,d))) walls.delete(e); }
  for (const e of [...doors]) if (!edgeTouchesFloor(e)) doors.delete(e);
  floorList = [];
  for (const L of layers) { buildLayer(L); for (const f of L.cache.floorList) floorList.push(f); }
  doorEdges = [];
  for (const e of doors) { const [o, x, y] = e.split(":"); doorEdges.push({ o, x: +x, y: +y }); }
}

function buildLayer(L) {
  const cells = L.cells, style = L.style;
  const isFloor = (x, y) => cells.has(key(x, y));
  let floorList, nearList, wallEdges, shoreEdges, boundary, hatchClusters, roughClusters, rockPolys;

  floorList = [];
  for (const [k, t] of cells) { const i = k.indexOf(","); floorList.push({ x: +k.slice(0, i), y: +k.slice(i + 1), t }); }

  const isIn = isFloor; // every square in the layer casts the surroundings band

  // indoor boundary squares define the hatched band
  boundary = [];
  for (const f of floorList) {
    let inner = true;
    for (let dy = -1; dy <= 1 && inner; dy++) for (let dx = -1; dx <= 1; dx++) if (!isIn(f.x + dx, f.y + dy)) { inner = false; break; }
    if (!inner) boundary.push(f);
  }
  const D = style.depth, Dc = Math.ceil(D) + 1, near = new Map();
  const rectDist = (px, py, fx, fy) => Math.hypot(Math.max(fx - px, 0, px - fx - 1), Math.max(fy - py, 0, py - fy - 1));
  for (const b of boundary) for (let dy = -Dc; dy <= Dc; dy++) for (let dx = -Dc; dx <= Dc; dx++) {
    const x = b.x + dx, y = b.y + dy;
    if (isFloor(x, y)) continue;
    const d = rectDist(x + 0.5, y + 0.5, b.x, b.y); if (d > D + 0.75) continue;
    const k = key(x, y), p = near.get(k);
    if (!p || d < p.d) near.set(k, { x, y, d });
  }
  nearList = [...near.values()];

  // pre-baked hatch clusters: 2x2 per square, kept only inside the band
  hatchClusters = [];
  for (const n of nearList) {
    for (let i = 0; i < 4; i++) {
      const px = n.x + (i & 1 ? 0.75 : 0.25) + (h(n.x, n.y, 500 + i) - 0.5) * 0.3;
      const py = n.y + (i & 2 ? 0.75 : 0.25) + (h(n.x, n.y, 510 + i) - 0.5) * 0.3;
      if (n.d > D - 0.75) {
        let md = Infinity;
        for (let dy = -Dc; dy <= Dc; dy++) for (let dx = -Dc; dx <= Dc; dx++) if (isIn(n.x + dx, n.y + dy)) md = Math.min(md, rectDist(px, py, n.x + dx, n.y + dy));
        if (md > D - 0.12) continue;
      }
      const a = h(n.x, n.y, 520 + i) * Math.PI, lines = 3 + ((h(n.x, n.y, 530 + i) * 3) | 0);
      const len = 0.42 + 0.2 * h(n.x, n.y, 540 + i), gap = 0.095;
      const dx = Math.cos(a), dy = Math.sin(a), qx = -dy, qy = dx, segs = [];
      for (let l = 0; l < lines; l++) {
        const o = (l - (lines - 1) / 2) * gap, hl = len * (0.75 + 0.25 * h(n.x * 4 + i, n.y, 550 + l)) / 2;
        const mx = px + qx * o, my = py + qy * o;
        segs.push((mx - dx * hl) * CELL, (my - dy * hl) * CELL, (mx + dx * hl) * CELL, (my + dy * hl) * CELL);
      }
      hatchClusters.push({ x: n.x, y: n.y, segs });
    }
  }

  // "rough" surroundings: darker, uneven strokes scattered unevenly through a slightly wider band
  roughClusters = [];
  for (const n of nearList) {
    for (let i = 0; i < 4; i++) {
      const r = k => h(n.x * 3 + i, n.y * 7 - i, 800 + k);
      const keep = n.d <= 0.8 ? 0.97 : Math.max(0.12, 1.05 - n.d / (D + 0.6));
      if (r(0) > keep) continue;
      const px = n.x + r(1), py = n.y + r(2), a = r(3) * Math.PI;
      const lines = 2 + ((r(4) * 5) | 0), len = 0.35 + 0.6 * r(5), gap = 0.1 + 0.07 * r(6);
      const dx = Math.cos(a), dy = Math.sin(a), qx = -dy, qy = dx, segs = [];
      for (let l = 0; l < lines; l++) {
        const o = (l - (lines - 1) / 2) * gap, hl = len * (0.55 + 0.45 * h(n.x * 9 + i, n.y + l, 830)) / 2, sh = (h(n.x, n.y * 5 + l, 840 + i) - 0.5) * 0.2;
        const mx = px + qx * o + dx * sh, my = py + qy * o + dy * sh;
        segs.push((mx - dx * hl) * CELL, (my - dy * hl) * CELL, (mx + dx * hl) * CELL, (my + dy * hl) * CELL);
      }
      roughClusters.push({ x: n.x, y: n.y, heavy: r(7) < 0.4, segs });
    }
  }

  // "rocks" surroundings: packed irregular stones (Voronoi cells on a jittered half-square lattice)
  rockPolys = [];
  if (style.bg === "rocks") {
    const L = 0.5, inner = Math.max(0.5, D * 0.5), sites = new Map();
    const site = (i, j) => [(i + 0.5 + (h(i, j, 1201) - 0.5) * 0.8) * L, (j + 0.5 + (h(i, j, 1202) - 0.5) * 0.8) * L];
    const want = [];
    const consider = (cx, cy) => { for (let j = 2 * cy; j <= 2 * cy + 1; j++) for (let i = 2 * cx; i <= 2 * cx + 1; i++) { const k = i + "," + j; if (!sites.has(k)) { sites.set(k, 1); want.push([i, j]); } } };
    for (const n of nearList) consider(n.x, n.y);
    for (const f of boundary) consider(f.x, f.y);
    for (const [i, j] of want) {
      const [sx, sy] = site(i, j), cx = Math.floor(sx), cy = Math.floor(sy);
      let md = Infinity;
      for (let dy = -Dc; dy <= Dc; dy++) for (let dx = -Dc; dx <= Dc; dx++) if (isIn(cx + dx, cy + dy)) md = Math.min(md, rectDist(sx, sy, cx + dx, cy + dy));
      if (md > D + 0.05) continue;
      // cell polygon: start from a square, clip by the bisector with each nearby site
      let poly = [[sx - 1.5 * L, sy - 1.5 * L], [sx + 1.5 * L, sy - 1.5 * L], [sx + 1.5 * L, sy + 1.5 * L], [sx - 1.5 * L, sy + 1.5 * L]];
      for (let nj = j - 2; nj <= j + 2 && poly.length; nj++) for (let ni = i - 2; ni <= i + 2; ni++) {
        if (ni === i && nj === j) continue;
        const [qx, qy] = site(ni, nj), ux = qx - sx, uy = qy - sy, mx = (sx + qx) / 2, my = (sy + qy) / 2;
        const side = p => (p[0] - mx) * ux + (p[1] - my) * uy;
        const out = [];
        for (let k = 0; k < poly.length; k++) {
          const a = poly[k], b = poly[(k + 1) % poly.length], da = side(a), db = side(b);
          if (da <= 0) out.push(a);
          if ((da < 0) !== (db < 0) && da !== db) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
        }
        poly = out;
      }
      if (poly.length < 3) continue;
      const pts = []; for (const p of poly) pts.push(p[0] * CELL, p[1] * CELL);
      rockPolys.push({ x: cx, y: cy, dark: md <= inner, tone: h(i, j, 1203), pts });
    }
  }

  // walls: indoor floor against empty or outdoor ground; thin edges for outdoor ground
  wallEdges = []; shoreEdges = [];
  const seen = new Set(), seenShore = new Set();
  const add = (o, x, y, rough) => { const e = o + ":" + x + ":" + y; if (seen.has(e)) return; seen.add(e); wallEdges.push({ o, x, y, door: doors.has(e), rough: !!rough }); };
  const shore = (o, x, y) => { const e = o + ":" + x + ":" + y; if (seenShore.has(e)) return; seenShore.add(e); shoreEdges.push({ o, x, y }); };
  for (const f of floorList) {
    const out = !!TEX[f.t].outdoor;
    const side = (nx, ny, o, ex, ey) => {
      const nt = cells.get(key(nx, ny)), rough = f.t === "cave" || nt === "cave";
      if (nt === undefined) add(o, ex, ey, rough);                                     // edge of the layer: a wall
      else if (nt !== f.t && (out || TEX[nt].outdoor)) shore(o, ex, ey);              // outdoor ground meeting another floor in the same layer
    };
    side(f.x, f.y - 1, "h", f.x, f.y);
    side(f.x, f.y + 1, "h", f.x, f.y + 1);
    side(f.x - 1, f.y, "v", f.x, f.y);
    side(f.x + 1, f.y, "v", f.x + 1, f.y);
  }
  for (const e of walls) { const [o, x, y] = e.split(":"), [a, b, c, d] = edgeCells(e); if (isFloor(a, b) && isFloor(c, d)) add(o, +x, +y, cells.get(key(a, b)) === "cave" || cells.get(key(c, d)) === "cave"); }
  L.cache = { floorList, nearList, wallEdges, shoreEdges, boundary, hatchClusters, roughClusters, rockPolys, isFloor };
}

// ---------- textures ----------
function lp(i, j) { // jittered half-square lattice; points on square borders only slide along the border
  const s2 = CELL / 2, J = CELL * 0.085;
  let px = i * s2, py = j * s2;
  if (i & 1) px += (h(i, j, 11) - 0.5) * 2 * J;
  if (j & 1) py += (h(i, j, 12) - 0.5) * 2 * J;
  return [px, py];
}
function poly(ctx, pts) { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }

const TEX = {
  plain: { name: "Plain", draw(ctx, x, y) { ctx.fillStyle = "#fcfbf8"; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); } },
  flag: {
    name: "Flagstone",
    draw(ctx, x, y) {
      const I = 2 * x, J = 2 * y, P = (a, b) => lp(I + a, J + b);
      ctx.fillStyle = "#e3ded3"; ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      const r = h(x, y, 7); let slabs;
      const q = (a, b) => [P(a, b), P(a + 1, b), P(a + 1, b + 1), P(a, b + 1)];
      const top = [P(0,0), P(1,0), P(2,0), P(2,1), P(1,1), P(0,1)];
      const bot = [P(0,1), P(1,1), P(2,1), P(2,2), P(1,2), P(0,2)];
      const left = [P(0,0), P(1,0), P(1,1), P(1,2), P(0,2), P(0,1)];
      const right = [P(1,0), P(2,0), P(2,1), P(2,2), P(1,2), P(1,1)];
      if (r < 0.28) slabs = [q(0,0), q(1,0), q(0,1), q(1,1)];
      else if (r < 0.52) slabs = [top, bot];
      else if (r < 0.76) slabs = [left, right];
      else if (r < 0.88) slabs = [top, q(0,1), q(1,1)];
      else slabs = [left, q(1,0), q(1,1)];
      slabs.forEach((s, i) => {
        const L = 80 + h(x * 4 + i, y, 9) * 9;
        ctx.fillStyle = `hsl(36 9% ${L}%)`;
        ctx.beginPath(); poly(ctx, s); ctx.fill();
      });
      ctx.strokeStyle = "#8c8274"; ctx.lineWidth = 0.9; ctx.lineJoin = "round";
      ctx.beginPath(); slabs.forEach(s => poly(ctx, s)); ctx.stroke();
      // wear marks
      ctx.fillStyle = "rgba(90,80,66,.45)";
      ctx.beginPath();
      for (let i = 0; i < 3; i++) { const px = (x + 0.15 + h(x, y, 40 + i) * 0.7) * CELL, py = (y + 0.15 + h(x, y, 50 + i) * 0.7) * CELL; ctx.moveTo(px + 0.6, py); ctx.arc(px, py, 0.6, 0, 6.283); }
      ctx.fill();
    }
  },
  wood: {
    name: "Wood",
    draw(ctx, x, y) {
      const n = 4, sh = CELL / n, X = x * CELL;
      ctx.lineWidth = 0.5;
      for (let i = 0; i < n; i++) {
        const r = y * n + i, o = Math.floor(h(r, 77, 3) * 3), k = x + o, p = Math.floor(k / 3);
        const Y = y * CELL + i * sh;
        ctx.fillStyle = `hsl(31 36% ${63 + h(p, r, 5) * 11}%)`;
        ctx.fillRect(X, Y, CELL, sh);
        ctx.strokeStyle = "rgba(110,72,40,.38)";
        ctx.beginPath();
        for (let g = 0; g < 2; g++) {
          const gy = Y + sh * (0.28 + 0.44 * h(p, r, 6 + g));
          const wob = (h(p, r, 8 + g) - 0.5) * 1.4;
          ctx.moveTo(X, gy + wob * Math.sin(k * 1.7)); ctx.lineTo(X + CELL, gy + wob * Math.sin((k + 1) * 1.7));
        }
        ctx.stroke();
        if (h(k, r, 9) < 0.07) { ctx.beginPath(); ctx.ellipse(X + CELL * (0.3 + 0.4 * h(k, r, 10)), Y + sh / 2, 2.2, 1.1, 0, 0, 6.283); ctx.stroke(); }
        if (((k % 3) + 3) % 3 === 0) { ctx.strokeStyle = "#6a4a2f"; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y + sh); ctx.stroke(); ctx.lineWidth = 0.5; }
      }
      ctx.strokeStyle = "#6a4a2f"; ctx.lineWidth = 0.8; ctx.beginPath();
      for (let i = 1; i < n; i++) { const Y = y * CELL + i * sh; ctx.moveTo(X, Y); ctx.lineTo(X + CELL, Y); }
      ctx.stroke();
    }
  },
  dirt: {
    name: "Dirt",
    draw(ctx, x, y) {
      const X = x * CELL, Y = y * CELL;
      ctx.fillStyle = "#d7c8aa"; ctx.fillRect(X, Y, CELL, CELL);
      ctx.fillStyle = "rgba(96,74,46,.5)"; ctx.beginPath();
      for (let i = 0; i < 9; i++) { const px = X + h(x, y, 60 + i) * CELL, py = Y + h(x, y, 80 + i) * CELL, rr = 0.35 + h(x, y, 100 + i) * 0.6; ctx.moveTo(px + rr, py); ctx.arc(px, py, rr, 0, 6.283); }
      ctx.fill();
      const pebbles = h(x, y, 120) < 0.45 ? 1 + (h(x, y, 121) < 0.3 ? 1 : 0) : 0;
      for (let i = 0; i < pebbles; i++) {
        const px = X + (0.2 + 0.6 * h(x, y, 130 + i)) * CELL, py = Y + (0.2 + 0.6 * h(x, y, 140 + i)) * CELL;
        const rx = 1.6 + h(x, y, 150 + i) * 1.8, ry = rx * (0.6 + 0.3 * h(x, y, 160 + i));
        ctx.beginPath(); ctx.ellipse(px, py, rx, ry, h(x, y, 170 + i) * 3.14, 0, 6.283);
        ctx.fillStyle = "#c8b897"; ctx.fill(); ctx.strokeStyle = "#7a684c"; ctx.lineWidth = 0.6; ctx.stroke();
      }
    }
  }
};
TEX.grass = {
  name: "Grass", outdoor: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#b9cc98"; ctx.fillRect(X, Y, CELL, CELL);
    ctx.fillStyle = "rgba(150,180,110,.55)"; ctx.beginPath();
    for (let i = 0; i < 3; i++) { const px = X + h(x, y, 600 + i) * CELL, py = Y + h(x, y, 610 + i) * CELL, r = 2.5 + h(x, y, 620 + i) * 3; ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 6.283); }
    ctx.fill();
    ctx.strokeStyle = "rgba(62,92,44,.7)"; ctx.lineWidth = 0.7; ctx.lineCap = "round"; ctx.beginPath();
    for (let i = 0; i < 3; i++) {
      const px = X + (0.12 + 0.76 * h(x, y, 630 + i)) * CELL, py = Y + (0.2 + 0.7 * h(x, y, 640 + i)) * CELL;
      ctx.moveTo(px - 2, py - 3); ctx.lineTo(px, py); ctx.lineTo(px + 0.4, py - 4); ctx.moveTo(px, py); ctx.lineTo(px + 2.4, py - 2.6);
    }
    ctx.stroke();
  }
};
TEX.water = {
  name: "Water", outdoor: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#a6c8d2"; ctx.fillRect(X, Y, CELL, CELL);
    ctx.lineCap = "round"; ctx.lineWidth = 0.8;
    for (let i = 0; i < 2; i++) {
      const px = X + (0.15 + 0.6 * h(x, y, 700 + i)) * CELL, py = Y + (0.2 + 0.6 * h(x, y, 710 + i)) * CELL, w = 6 + h(x, y, 720 + i) * 6;
      ctx.strokeStyle = i ? "rgba(255,255,255,.75)" : "rgba(52,100,118,.45)";
      ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + w / 2, py - 2.2, px + w, py); ctx.stroke();
    }
  }
};
TEX.cave = {
  name: "Cave",
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#b8b1a4"; ctx.fillRect(X, Y, CELL, CELL);
    for (let i = 0; i < 3; i++) { // mottled rock
      const px = X + h(x, y, 900 + i) * CELL, py = Y + h(x, y, 910 + i) * CELL, r = 7 + h(x, y, 920 + i) * 9;
      ctx.fillStyle = h(x, y, 930 + i) < 0.5 ? "rgba(80,72,62,.07)" : "rgba(255,250,240,.08)";
      ctx.beginPath(); ctx.arc(px, py, r, 0, 6.283); ctx.fill();
    }
    ctx.strokeStyle = "rgba(60,52,44,.55)"; ctx.lineWidth = 0.7; ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (h(x, y, 940) < 0.55) { // crack
      let px = X + (0.15 + 0.7 * h(x, y, 941)) * CELL, py = Y + (0.15 + 0.7 * h(x, y, 942)) * CELL, a = h(x, y, 943) * 6.283;
      ctx.beginPath(); ctx.moveTo(px, py);
      for (let k = 0; k < 3; k++) { a += (h(x, y, 944 + k) - 0.5) * 1.6; px += Math.cos(a) * 4; py += Math.sin(a) * 4; ctx.lineTo(px, py); }
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(60,52,44,.5)"; ctx.beginPath();
    for (let i = 0; i < 6; i++) { const px = X + h(x, y, 950 + i) * CELL, py = Y + h(x, y, 960 + i) * CELL, r = 0.4 + h(x, y, 970 + i) * 0.6; ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 6.283); }
    ctx.fill();
    if (h(x, y, 980) < 0.3) { const px = X + (0.2 + 0.6 * h(x, y, 981)) * CELL, py = Y + (0.2 + 0.6 * h(x, y, 982)) * CELL; ctx.beginPath(); ctx.ellipse(px, py, 2.2, 1.5, h(x, y, 983) * 3, 0, 6.283); ctx.fillStyle = "#a59d8f"; ctx.fill(); ctx.strokeStyle = "rgba(40,34,28,.7)"; ctx.lineWidth = 0.6; ctx.stroke(); }
  }
};
TEX.brick = {
  name: "Brick",
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL, n = 4, bh = CELL / n, bw = CELL / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(X, Y, CELL, CELL); ctx.clip();
    ctx.fillStyle = "#d8cdbf"; ctx.fillRect(X, Y, CELL, CELL);
    for (let i = 0; i < n; i++) {
      const r = y * n + i, off = (r & 1) ? bw / 2 : 0;
      for (let j = 0; j < 3; j++) {
        const k = 2 * x + j, bx = X - off + j * bw, by = Y + i * bh;
        ctx.fillStyle = `hsl(${10 + h(k, r, 33) * 10} ${32 + h(k, r, 34) * 14}% ${42 + h(k, r, 35) * 14}%)`;
        ctx.fillRect(bx + 0.6, by + 0.6, bw - 1.2, bh - 1.2);
        if (h(k, r, 36) < 0.25) { ctx.fillStyle = "rgba(40,20,12,.18)"; ctx.fillRect(bx + 0.6, by + bh - 2.2, bw - 1.2, 1.6); }
      }
    }
    ctx.restore();
  }
};
TEX.marble = {
  name: "Marble",
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL, t = CELL / 2;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const gx = 2 * x + i, gy = 2 * y + j, dark = (gx + gy) & 1;
      ctx.fillStyle = dark ? `hsl(35 6% ${66 + h(gx, gy, 1300) * 5}%)` : `hsl(40 14% ${90 + h(gx, gy, 1301) * 4}%)`;
      ctx.fillRect(X + i * t, Y + j * t, t, t);
      if (h(gx, gy, 1302) < 0.45) { // vein
        ctx.strokeStyle = dark ? "rgba(255,255,255,.28)" : "rgba(110,100,90,.22)"; ctx.lineWidth = 0.5; ctx.beginPath();
        const a = h(gx, gy, 1303) * t, b2 = h(gx, gy, 1304) * t;
        ctx.moveTo(X + i * t, Y + j * t + a); ctx.bezierCurveTo(X + i * t + t * 0.4, Y + j * t + a - 4, X + i * t + t * 0.6, Y + j * t + b2 + 4, X + i * t + t, Y + j * t + b2); ctx.stroke();
      }
    }
    ctx.strokeStyle = "rgba(60,52,44,.35)"; ctx.lineWidth = 0.5; ctx.beginPath();
    ctx.moveTo(X + t, Y); ctx.lineTo(X + t, Y + CELL); ctx.moveTo(X, Y + t); ctx.lineTo(X + CELL, Y + t); ctx.stroke();
  }
};
TEX.cobble = {
  name: "Cobblestone", outdoor: true, clip: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL, n = 3, cs = CELL / n;
    ctx.fillStyle = "#857d70"; ctx.fillRect(X, Y, CELL, CELL);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gx = n * x + i, gy = n * y + j;
      const cx = X + (i + 0.5) * cs + (h(gx, gy, 1310) - 0.5) * cs * 0.18, cy = Y + (j + 0.5) * cs + (h(gx, gy, 1311) - 0.5) * cs * 0.18;
      const rx = cs * (0.4 + 0.06 * h(gx, gy, 1312)), ry = cs * (0.38 + 0.06 * h(gx, gy, 1313));
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, h(gx, gy, 1314) * 3, 0, 6.283);
      ctx.fillStyle = `hsl(32 7% ${62 + h(gx, gy, 1315) * 14}%)`; ctx.fill();
      ctx.strokeStyle = "rgba(45,38,32,.55)"; ctx.lineWidth = 0.6; ctx.stroke();
    }
  }
};
TEX.sand = {
  name: "Sand", outdoor: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#e4d3a7"; ctx.fillRect(X, Y, CELL, CELL);
    ctx.strokeStyle = "rgba(160,125,70,.38)"; ctx.lineWidth = 0.7; ctx.lineCap = "round"; ctx.beginPath();
    for (let i = 0; i < 2; i++) { // ripples line up across squares: same phase per row
      const py = Y + (0.25 + 0.5 * i) * CELL + Math.sin((x + i) * 1.3) * 2;
      ctx.moveTo(X, py); ctx.quadraticCurveTo(X + CELL / 2, py - 3 + h(x, y, 1320 + i) * 2, X + CELL, py + Math.sin((x + 1 + i) * 1.3) * 2 - Math.sin((x + i) * 1.3) * 2);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(140,110,60,.4)"; ctx.beginPath();
    for (let i = 0; i < 6; i++) { const px = X + h(x, y, 1330 + i) * CELL, py = Y + h(x, y, 1340 + i) * CELL; ctx.moveTo(px + 0.45, py); ctx.arc(px, py, 0.45, 0, 6.283); }
    ctx.fill();
  }
};
TEX.snow = {
  name: "Snow", outdoor: true, clip: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#eef2f5"; ctx.fillRect(X, Y, CELL, CELL);
    for (let i = 0; i < 2; i++) { const px = X + h(x, y, 1350 + i) * CELL, py = Y + h(x, y, 1355 + i) * CELL; ctx.fillStyle = "rgba(150,175,200,.10)"; ctx.beginPath(); ctx.ellipse(px, py, 6 + h(x, y, 1360 + i) * 5, 3 + h(x, y, 1365 + i) * 2, 0.3, 0, 6.283); ctx.fill(); }
    ctx.strokeStyle = "rgba(120,150,180,.35)"; ctx.lineWidth = 0.6; ctx.lineCap = "round"; ctx.beginPath();
    if (h(x, y, 1370) < 0.5) { const px = X + h(x, y, 1371) * CELL * 0.7, py = Y + (0.2 + h(x, y, 1372) * 0.6) * CELL; ctx.moveTo(px, py); ctx.quadraticCurveTo(px + 5, py - 2, px + 10, py); }
    ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.beginPath();
    for (let i = 0; i < 4; i++) { const px = X + h(x, y, 1380 + i) * CELL, py = Y + h(x, y, 1385 + i) * CELL; ctx.moveTo(px + 0.7, py); ctx.arc(px, py, 0.7, 0, 6.283); }
    ctx.fill();
  }
};
TEX.swamp = {
  name: "Swamp", outdoor: true, clip: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#7c875a"; ctx.fillRect(X, Y, CELL, CELL);
    for (let i = 0; i < 2; i++) {
      const px = X + h(x, y, 1400 + i) * CELL, py = Y + h(x, y, 1405 + i) * CELL;
      ctx.fillStyle = "rgba(62,82,72,.55)"; ctx.beginPath(); ctx.ellipse(px, py, 6 + h(x, y, 1410 + i) * 6, 3 + h(x, y, 1415 + i) * 3, h(x, y, 1420 + i) * 3, 0, 6.283); ctx.fill();
    }
    ctx.fillStyle = "rgba(170,185,110,.7)"; ctx.beginPath();
    for (let i = 0; i < 5; i++) { const px = X + h(x, y, 1430 + i) * CELL, py = Y + h(x, y, 1435 + i) * CELL, r = 0.6 + h(x, y, 1440 + i) * 0.8; ctx.moveTo(px + r, py); ctx.arc(px, py, r, 0, 6.283); }
    ctx.fill();
    ctx.strokeStyle = "rgba(55,70,40,.7)"; ctx.lineWidth = 0.6; ctx.lineCap = "round"; ctx.beginPath();
    if (h(x, y, 1450) < 0.5) { const px = X + (0.2 + 0.6 * h(x, y, 1451)) * CELL, py = Y + (0.3 + 0.6 * h(x, y, 1452)) * CELL; ctx.moveTo(px, py); ctx.lineTo(px - 1.5, py - 5); ctx.moveTo(px, py); ctx.lineTo(px + 1, py - 6); ctx.moveTo(px, py); ctx.lineTo(px + 3, py - 4); }
    ctx.stroke();
  }
};
TEX.lava = {
  name: "Lava", outdoor: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL, I = 2 * x, J = 2 * y, P = (a, b) => lp(I + a, J + b);
    ctx.fillStyle = "#f07a2a"; ctx.fillRect(X, Y, CELL, CELL);
    const r = h(x, y, 1460);
    const q = (a, b) => [P(a, b), P(a + 1, b), P(a + 1, b + 1), P(a, b + 1)];
    const plates = r < 0.5 ? [q(0, 0), q(1, 0), q(0, 1), q(1, 1)] : [[P(0,0), P(1,0), P(2,0), P(2,1), P(1,1), P(0,1)], q(0, 1), q(1, 1)];
    plates.forEach((pl, i) => {
      if (h(x * 4 + i, y, 1461) < 0.18) return; // open molten patch
      const c = pl.reduce((s, p) => [s[0] + p[0] / pl.length, s[1] + p[1] / pl.length], [0, 0]);
      const shrunk = pl.map(p => [c[0] + (p[0] - c[0]) * 0.8, c[1] + (p[1] - c[1]) * 0.8]);
      ctx.beginPath(); poly(ctx, shrunk); ctx.fillStyle = `hsl(14 18% ${17 + h(x * 4 + i, y, 1462) * 8}%)`; ctx.fill();
      ctx.strokeStyle = "rgba(255,210,110,.55)"; ctx.lineWidth = 0.7; ctx.stroke();
    });
    ctx.fillStyle = "rgba(255,230,140,.75)"; ctx.beginPath();
    for (let i = 0; i < 3; i++) { const px = X + h(x, y, 1470 + i) * CELL, py = Y + h(x, y, 1475 + i) * CELL; ctx.moveTo(px + 0.8, py); ctx.arc(px, py, 0.8, 0, 6.283); }
    ctx.fill();
  }
};
TEX.carpet = {
  name: "Carpet", clip: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL, t = CELL / 2;
    ctx.fillStyle = "#8a2f33"; ctx.fillRect(X, Y, CELL, CELL);
    ctx.strokeStyle = "rgba(226,180,110,.38)"; ctx.lineWidth = 0.8; ctx.beginPath(); // diamond lattice, continuous across squares
    for (let k = 0; k <= 2; k++) { ctx.moveTo(X + k * t, Y); ctx.lineTo(X + k * t - t, Y + t); ctx.lineTo(X + k * t, Y + CELL); ctx.moveTo(X + k * t, Y); ctx.lineTo(X + k * t + t, Y + t); ctx.lineTo(X + k * t, Y + CELL); }
    ctx.stroke();
    ctx.fillStyle = "rgba(226,180,110,.45)"; ctx.beginPath();
    for (const [a, b2] of [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]]) { ctx.moveTo(X + a * CELL + 1.2, Y + b2 * CELL); ctx.arc(X + a * CELL, Y + b2 * CELL, 1.2, 0, 6.283); }
    ctx.fill();
  }
};
TEX.forest = {
  name: "Forest floor", outdoor: true, clip: true,
  draw(ctx, x, y) {
    const X = x * CELL, Y = y * CELL;
    ctx.fillStyle = "#7d6c4c"; ctx.fillRect(X, Y, CELL, CELL);
    const cols = ["#9a7a45", "#6f7a42", "#a4683a", "#5f5233", "#8c8a4c"];
    for (let i = 0; i < 7; i++) {
      const px = X + h(x, y, 1500 + i) * CELL, py = Y + h(x, y, 1510 + i) * CELL;
      ctx.beginPath(); ctx.ellipse(px, py, 2.4, 1.2, h(x, y, 1520 + i) * 3.14, 0, 6.283);
      ctx.fillStyle = cols[(h(x, y, 1530 + i) * 5) | 0]; ctx.fill();
    }
    ctx.strokeStyle = "rgba(50,38,25,.6)"; ctx.lineWidth = 0.7; ctx.lineCap = "round"; ctx.beginPath();
    if (h(x, y, 1540) < 0.45) { const px = X + h(x, y, 1541) * CELL * 0.7, py = Y + h(x, y, 1542) * CELL, a = h(x, y, 1543) * 3; ctx.moveTo(px, py); ctx.lineTo(px + Math.cos(a) * 8, py + Math.sin(a) * 8); }
    ctx.stroke();
  }
};
const TEX_ORDER = ["plain", "flag", "wood", "dirt", "grass", "water", "cave", "brick", "marble", "cobble", "sand", "snow", "swamp", "lava", "carpet", "forest"]; // order is saved in map files; append only

// ---------- props ----------
const PROP_INK = INK;
function box(g, x, y, w, hh, fill, lw = 1.2) { g.beginPath(); g.rect(x, y, w, hh); g.fillStyle = fill; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = lw; g.lineJoin = "round"; g.stroke(); }
function disc(g, x, y, r, fill, lw = 1.2) { g.beginPath(); g.arc(x, y, r, 0, 6.283); if (fill) { g.fillStyle = fill; g.fill(); } if (lw) { g.strokeStyle = PROP_INK; g.lineWidth = lw; g.stroke(); } }
function lines(g, pts, lw = 0.8, col = PROP_INK) { g.beginPath(); for (let i = 0; i < pts.length; i += 4) { g.moveTo(pts[i], pts[i + 1]); g.lineTo(pts[i + 2], pts[i + 3]); } g.strokeStyle = col; g.lineWidth = lw; g.lineCap = "round"; g.stroke(); }
function blobPath(g, r, seed, lobes, k = 0) {
  const pts = [];
  for (let i = 0; i < lobes; i++) { const a = (i / lobes) * 6.283 + (h(seed, i, 1 + k) - 0.5) * 0.35; pts.push([a, r * (0.84 + 0.16 * h(seed, i, 2 + k))]); }
  g.beginPath(); g.moveTo(Math.cos(pts[0][0]) * pts[0][1], Math.sin(pts[0][0]) * pts[0][1]);
  for (let i = 0; i < lobes; i++) {
    const p = pts[i], q = pts[(i + 1) % lobes], qa = i === lobes - 1 ? q[0] + 6.283 : q[0], m = (p[0] + qa) / 2, cr = Math.max(p[1], q[1]) * 1.2;
    g.quadraticCurveTo(Math.cos(m) * cr, Math.sin(m) * cr, Math.cos(qa) * q[1], Math.sin(qa) * q[1]);
  }
  g.closePath();
}
const C = CELL;
const PROPS = {
  table: { name: "Table", cat: "furn", w: 2, h: 1, draw(g) { box(g, -0.92 * C, -0.38 * C, 1.84 * C, 0.76 * C, "#bd9064"); lines(g, [-0.92 * C, -0.13 * C, 0.92 * C, -0.13 * C, -0.92 * C, 0.12 * C, 0.92 * C, 0.12 * C], 0.6, "rgba(80,50,25,.6)"); } },
  roundtable: { name: "Round table", cat: "furn", w: 1, h: 1, draw(g) { disc(g, 0, 0, 0.4 * C, "#bd9064"); disc(g, 0, 0, 0.3 * C, null, 0.6); } },
  chair: { name: "Chair", cat: "furn", w: 1, h: 1, draw(g) { box(g, -0.2 * C, -0.17 * C, 0.4 * C, 0.4 * C, "#c49a6c"); box(g, -0.22 * C, -0.3 * C, 0.44 * C, 0.12 * C, "#8d6440"); } },
  bed: { name: "Bed", cat: "furn", w: 1, h: 2, draw(g) {
    box(g, -0.4 * C, -0.92 * C, 0.8 * C, 1.84 * C, "#9b7048");
    box(g, -0.32 * C, -0.84 * C, 0.64 * C, 0.36 * C, "#f4f1ea", 1);
    box(g, -0.36 * C, -0.38 * C, 0.72 * C, 1.24 * C, "#7d9bb5", 1);
    lines(g, [-0.36 * C, -0.2 * C, 0.36 * C, -0.2 * C], 0.8);
  } },
  chest: { name: "Chest", cat: "furn", w: 1, h: 1, draw(g) { box(g, -0.36 * C, -0.24 * C, 0.72 * C, 0.48 * C, "#a7743f"); lines(g, [-0.36 * C, -0.04 * C, 0.36 * C, -0.04 * C, -0.2 * C, -0.24 * C, -0.2 * C, 0.24 * C, 0.2 * C, -0.24 * C, 0.2 * C, 0.24 * C], 0.8); box(g, -0.05 * C, -0.08 * C, 0.1 * C, 0.1 * C, "#d8b45a", 0.8); } },
  barrel: { name: "Barrel", cat: "furn", w: 1, h: 1, draw(g) { disc(g, 0, 0, 0.34 * C, "#ad7f4f"); disc(g, 0, 0, 0.27 * C, null, 0.9); lines(g, [-0.27 * C, 0, 0.27 * C, 0, 0, -0.27 * C, 0, 0.27 * C], 0.5, "rgba(60,35,15,.6)"); } },
  crate: { name: "Crate", cat: "furn", w: 1, h: 1, draw(g) { box(g, -0.37 * C, -0.37 * C, 0.74 * C, 0.74 * C, "#c9a26b"); box(g, -0.28 * C, -0.28 * C, 0.56 * C, 0.56 * C, "#c9a26b", 0.7); lines(g, [-0.28 * C, -0.28 * C, 0.28 * C, 0.28 * C, -0.28 * C, 0.28 * C, 0.28 * C, -0.28 * C], 0.7); } },
  shelf: { name: "Bookshelf", cat: "furn", w: 2, h: 1, draw(g, seed) {
    box(g, -0.95 * C, -0.48 * C, 1.9 * C, 0.42 * C, "#8a5f3b");
    const cols = ["#7a3b2e", "#3f5f7a", "#5d7a3f", "#a08a3e", "#6b4a7a"];
    let x = -0.9 * C;
    for (let i = 0; x < 0.86 * C; i++) { const w = (0.07 + 0.06 * h(seed, i, 3)) * C; g.fillStyle = cols[(h(seed, i, 4) * 5) | 0]; g.fillRect(x, -0.43 * C, Math.min(w, 0.9 * C - x), 0.3 * C); x += w + 0.015 * C; }
    g.strokeStyle = PROP_INK; g.lineWidth = 1.2; g.strokeRect(-0.95 * C, -0.48 * C, 1.9 * C, 0.42 * C);
  } },
  stairs: { name: "Stairs", cat: "furn", w: 1, h: 2, draw(g) {
    box(g, -0.5 * C, -C, C, 2 * C, "#f2efe8", 1.2);
    for (let i = 1; i < 8; i++) { const y = -C + i * 0.25 * C; g.fillStyle = `rgba(40,32,26,${0.04 * i})`; g.fillRect(-0.5 * C, y, C, 0.25 * C); }
    const p = []; for (let i = 1; i < 8; i++) p.push(-0.5 * C, -C + i * 0.25 * C, 0.5 * C, -C + i * 0.25 * C); lines(g, p, 0.9);
  } },
  pillar: { name: "Pillar", cat: "furn", w: 1, h: 1, draw(g) { disc(g, 0, 0, 0.4 * C, "#d3cec3", 1.6); disc(g, 0, 0, 0.29 * C, "#dedad1", 0.7); } },
  brazier: { name: "Brazier", cat: "furn", w: 1, h: 1, draw(g) { disc(g, 0, 0, 0.3 * C, "#6d655c"); disc(g, 0, 0, 0.2 * C, "#e8903a", 0.6); disc(g, 0.02 * C, -0.02 * C, 0.09 * C, "#f8d26a", 0); } },
  rug: { name: "Rug", cat: "furn", w: 2, h: 3, draw(g) { box(g, -0.85 * C, -1.35 * C, 1.7 * C, 2.7 * C, "#9a4b3c", 1); box(g, -0.68 * C, -1.18 * C, 1.36 * C, 2.36 * C, "#b8644f", 0.6); g.beginPath(); g.moveTo(0, -0.8 * C); g.lineTo(0.45 * C, 0); g.lineTo(0, 0.8 * C); g.lineTo(-0.45 * C, 0); g.closePath(); g.fillStyle = "#d8b45a"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 0.6; g.stroke(); } },

  tree: { name: "Tree", cat: "fol", w: 2, h: 2, draw(g, seed) {
    g.save(); g.translate(0.08 * C, 0.1 * C); blobPath(g, 0.95 * C, seed, 9); g.fillStyle = "rgba(30,40,22,.28)"; g.fill(); g.restore();
    blobPath(g, 0.92 * C, seed, 9); g.fillStyle = "#7fa25d"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.3; g.stroke();
    g.save(); g.translate(-0.18 * C, -0.2 * C); blobPath(g, 0.5 * C, seed + 7, 7, 3); g.fillStyle = "#9cbd77"; g.fill(); g.restore();
    g.beginPath();
    for (let i = 0; i < 6; i++) { const a = h(seed, i, 30) * 6.283, r = (0.25 + 0.45 * h(seed, i, 31)) * C; const x = Math.cos(a) * r, y = Math.sin(a) * r; g.moveTo(x - 0.1 * C, y); g.quadraticCurveTo(x, y - 0.1 * C, x + 0.1 * C, y); }
    g.strokeStyle = "rgba(40,60,28,.7)"; g.lineWidth = 0.8; g.stroke();
  } },
  pine: { name: "Small tree", cat: "fol", w: 1, h: 1, draw(g, seed) {
    g.save(); g.translate(0.05 * C, 0.07 * C); blobPath(g, 0.48 * C, seed, 7); g.fillStyle = "rgba(30,40,22,.28)"; g.fill(); g.restore();
    blobPath(g, 0.46 * C, seed, 7); g.fillStyle = "#678f52"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.stroke();
    g.save(); g.translate(-0.08 * C, -0.1 * C); blobPath(g, 0.22 * C, seed + 3, 5, 3); g.fillStyle = "#86ab68"; g.fill(); g.restore();
  } },
  bush: { name: "Bush", cat: "fol", w: 1, h: 1, draw(g, seed) {
    blobPath(g, 0.38 * C, seed, 6); g.fillStyle = "#8db36a"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1; g.stroke();
    g.save(); g.translate(-0.07 * C, -0.08 * C); blobPath(g, 0.18 * C, seed + 5, 5, 3); g.fillStyle = "#a9c986"; g.fill(); g.restore();
  } },
  grass: { name: "Grass tuft", cat: "fol", w: 1, h: 1, draw(g, seed) {
    g.beginPath();
    for (let i = 0; i < 7; i++) { const a = -Math.PI / 2 + (i - 3) * 0.32 + (h(seed, i, 40) - 0.5) * 0.2, l = (0.18 + 0.14 * h(seed, i, 41)) * C; g.moveTo(0, 0.15 * C); g.quadraticCurveTo(Math.cos(a) * l * 0.4, 0.15 * C + Math.sin(a) * l * 0.6, Math.cos(a) * l, 0.15 * C + Math.sin(a) * l); }
    g.strokeStyle = "#47663a"; g.lineWidth = 1; g.lineCap = "round"; g.stroke();
  } },
  rock: { name: "Rock", cat: "fol", w: 1, h: 1, draw(g, seed) {
    g.beginPath();
    for (let i = 0; i < 7; i++) { const a = i / 7 * 6.283 + h(seed, i, 50) * 0.4, r = (0.26 + 0.12 * h(seed, i, 51)) * C; i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fillStyle = "#bcb5a6"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.lineJoin = "round"; g.stroke();
    lines(g, [-0.1 * C, -0.05 * C, 0.05 * C, 0.02 * C, 0.05 * C, 0.02 * C, 0.08 * C, 0.14 * C], 0.6, "rgba(40,32,26,.6)");
  } },
  log: { name: "Log", cat: "fol", w: 2, h: 1, draw(g) {
    g.beginPath(); g.roundRect ? g.roundRect(-0.85 * C, -0.2 * C, 1.7 * C, 0.4 * C, 0.2 * C) : g.rect(-0.85 * C, -0.2 * C, 1.7 * C, 0.4 * C);
    g.fillStyle = "#9a7048"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.stroke();
    lines(g, [-0.5 * C, -0.07 * C, 0.2 * C, -0.07 * C, -0.2 * C, 0.08 * C, 0.5 * C, 0.08 * C], 0.6, "rgba(50,30,15,.6)");
    g.beginPath(); g.ellipse(0.72 * C, 0, 0.12 * C, 0.19 * C, 0, 0, 6.283); g.fillStyle = "#d6b98d"; g.fill(); g.stroke();
  } },
  flowers: { name: "Flowers", cat: "fol", w: 1, h: 1, draw(g, seed) {
    const cols = ["#e9d36a", "#d9776a", "#f4f1ea", "#b48ad0"];
    for (let i = 0; i < 6; i++) { const x = (h(seed, i, 60) - 0.5) * 0.6 * C, y = (h(seed, i, 61) - 0.5) * 0.6 * C; disc(g, x, y, 0.06 * C, cols[(h(seed, i, 62) * 4) | 0], 0.6); }
  } },
};
const ell = (g, x, y, rx, ry, rot, fill, lw = 1.1) => { g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, 6.283); if (fill) { g.fillStyle = fill; g.fill(); } if (lw) { g.strokeStyle = PROP_INK; g.lineWidth = lw; g.stroke(); } };
const polyF = (g, pts, fill, lw = 1.1) => { g.beginPath(); g.moveTo(pts[0] * C, pts[1] * C); for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i] * C, pts[i + 1] * C); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (lw) { g.strokeStyle = PROP_INK; g.lineWidth = lw; g.lineJoin = "round"; g.stroke(); } };
const flame = (g, x, y, r) => { disc(g, x, y, r, "#e8823a", 0.6); disc(g, x, y, r * 0.5, "#fbd66a", 0); };
Object.assign(PROPS, {
  // tavern & town
  bar: { name: "Bar counter", cat: "furn", group: "Tavern & town", w: 3, h: 1, draw(g) {
    box(g, -1.45 * C, -0.32 * C, 2.9 * C, 0.64 * C, "#8b5c37"); box(g, -1.38 * C, -0.24 * C, 2.76 * C, 0.48 * C, "#a06c43", 0.6);
    for (const x of [-1, -0.35, 0.5, 1.1]) disc(g, x * C, -0.05 * C, 0.08 * C, "#d9c48d", 0.8);
  } },
  stool: { name: "Stool", cat: "furn", group: "Tavern & town", w: 1, h: 1, draw(g) { disc(g, 0, 0, 0.2 * C, "#a8774a"); disc(g, 0, 0, 0.12 * C, null, 0.6); } },
  fireplace: { name: "Fireplace", cat: "furn", group: "Tavern & town", w: 2, h: 1, draw(g) {
    box(g, -0.95 * C, -0.5 * C, 1.9 * C, 0.62 * C, "#8c847a", 1.3);
    lines(g, [-0.95 * C, -0.2 * C, -0.6 * C, -0.2 * C, 0.6 * C, -0.2 * C, 0.95 * C, -0.2 * C, -0.75 * C, -0.5 * C, -0.75 * C, -0.2 * C, 0.75 * C, -0.5 * C, 0.75 * C, -0.2 * C], 0.6, "rgba(40,34,28,.6)");
    box(g, -0.55 * C, -0.38 * C, 1.1 * C, 0.42 * C, "#2b2522", 1);
    flame(g, -0.15 * C, -0.15 * C, 0.13 * C); flame(g, 0.15 * C, -0.13 * C, 0.11 * C);
  } },
  well: { name: "Well", cat: "furn", group: "Tavern & town", w: 2, h: 2, draw(g) {
    disc(g, 0, 0, 0.8 * C, "#a59d90", 1.4); disc(g, 0, 0, 0.56 * C, "#4f7f95", 1.2);
    const p = []; for (let i = 0; i < 10; i++) { const a = i / 10 * 6.283; p.push(Math.cos(a) * 0.56 * C, Math.sin(a) * 0.56 * C, Math.cos(a) * 0.8 * C, Math.sin(a) * 0.8 * C); } lines(g, p, 0.7);
    g.strokeStyle = "rgba(255,255,255,.6)"; g.lineWidth = 0.8; g.beginPath(); g.arc(-0.1 * C, -0.1 * C, 0.25 * C, 3.6, 4.6); g.stroke();
    box(g, -0.9 * C, -0.06 * C, 1.8 * C, 0.12 * C, "#7a5536", 0.9);
  } },
  stall: { name: "Market stall", cat: "furn", group: "Tavern & town", w: 2, h: 2, draw(g) {
    for (let i = 0; i < 6; i++) { g.fillStyle = i & 1 ? "#f1e6d2" : "#c45a46"; g.fillRect((-0.9 + i * 0.3) * C, -0.9 * C, 0.3 * C, 1.3 * C); }
    g.strokeStyle = PROP_INK; g.lineWidth = 1.2; g.strokeRect(-0.9 * C, -0.9 * C, 1.8 * C, 1.3 * C);
    box(g, -0.9 * C, 0.45 * C, 1.8 * C, 0.4 * C, "#a8774a");
    const cols = ["#d9a441", "#8fb06c", "#c45a46", "#e8d9a8"];
    for (let i = 0; i < 7; i++) disc(g, (-0.75 + i * 0.25) * C, 0.65 * C, 0.08 * C, cols[i % 4], 0.6);
  } },
  cart: { name: "Cart", cat: "furn", group: "Tavern & town", w: 1, h: 2, draw(g) {
    box(g, -0.48 * C, -0.45 * C, 0.14 * C, 0.4 * C, "#3d332b"); box(g, 0.34 * C, -0.45 * C, 0.14 * C, 0.4 * C, "#3d332b");
    box(g, -0.36 * C, -0.8 * C, 0.72 * C, 1.2 * C, "#a8774a");
    lines(g, [-0.36 * C, -0.4 * C, 0.36 * C, -0.4 * C, -0.36 * C, 0, 0.36 * C, 0, -0.2 * C, 0.4 * C, -0.15 * C, 0.95 * C, 0.2 * C, 0.4 * C, 0.15 * C, 0.95 * C], 0.9);
  } },
  fence: { name: "Fence", cat: "furn", group: "Tavern & town", w: 1, h: 1, draw(g) {
    box(g, -0.5 * C, -0.05 * C, C, 0.1 * C, "#a07a50", 0.8);
    box(g, -0.5 * C, -0.1 * C, 0.14 * C, 0.2 * C, "#6a4a2f", 0.8); box(g, 0.36 * C, -0.1 * C, 0.14 * C, 0.2 * C, "#6a4a2f", 0.8);
  } },
  // temple & crypt
  altar: { name: "Altar", cat: "furn", group: "Temple & crypt", w: 2, h: 1, draw(g) {
    box(g, -0.9 * C, -0.36 * C, 1.8 * C, 0.72 * C, "#dcd6ca", 1.4); box(g, -0.22 * C, -0.36 * C, 0.44 * C, 0.72 * C, "#6e3a63", 0.8);
    flame(g, -0.65 * C, 0, 0.08 * C); flame(g, 0.65 * C, 0, 0.08 * C);
  } },
  statue: { name: "Statue", cat: "furn", group: "Temple & crypt", w: 1, h: 1, draw(g) {
    box(g, -0.42 * C, -0.42 * C, 0.84 * C, 0.84 * C, "#c3bdb1", 1.3);
    ell(g, 0, 0.06 * C, 0.3 * C, 0.15 * C, 0, "#e3ded4"); disc(g, 0, -0.05 * C, 0.13 * C, "#ece8df");
  } },
  pew: { name: "Pew", cat: "furn", group: "Temple & crypt", w: 3, h: 1, draw(g) {
    box(g, -1.4 * C, -0.2 * C, 2.8 * C, 0.32 * C, "#9a6a42"); box(g, -1.4 * C, 0.12 * C, 2.8 * C, 0.12 * C, "#6e4a2c");
    box(g, -1.45 * C, -0.24 * C, 0.08 * C, 0.5 * C, "#6e4a2c", 0.8); box(g, 1.37 * C, -0.24 * C, 0.08 * C, 0.5 * C, "#6e4a2c", 0.8);
  } },
  candelabra: { name: "Candelabra", cat: "furn", group: "Temple & crypt", w: 1, h: 1, draw(g) {
    disc(g, 0, 0, 0.14 * C, "#8a8278", 1); lines(g, [0, 0, 0, -0.22 * C, 0, 0, -0.2 * C, 0.12 * C, 0, 0, 0.2 * C, 0.12 * C], 1.2, "#5d564d");
    flame(g, 0, -0.24 * C, 0.08 * C); flame(g, -0.21 * C, 0.13 * C, 0.08 * C); flame(g, 0.21 * C, 0.13 * C, 0.08 * C);
  } },
  sarcophagus: { name: "Sarcophagus", cat: "furn", group: "Temple & crypt", w: 1, h: 2, draw(g) {
    box(g, -0.42 * C, -0.9 * C, 0.84 * C, 1.8 * C, "#bdb6a8", 1.4); box(g, -0.32 * C, -0.8 * C, 0.64 * C, 1.6 * C, "#cec8bb", 0.7);
    disc(g, 0, -0.5 * C, 0.13 * C, "#d9d3c7", 0.8); ell(g, 0, 0.1 * C, 0.17 * C, 0.5 * C, 0, "#d9d3c7", 0.8);
    lines(g, [-0.15 * C, -0.05 * C, 0.15 * C, -0.05 * C], 0.7);
  } },
  coffin: { name: "Coffin", cat: "furn", group: "Temple & crypt", w: 1, h: 2, draw(g) {
    polyF(g, [-0.24, -0.9, 0.24, -0.9, 0.38, -0.45, 0.28, 0.9, -0.28, 0.9, -0.38, -0.45], "#7a5536", 1.3);
    lines(g, [0, -0.55 * C, 0, 0.05 * C, -0.15 * C, -0.35 * C, 0.15 * C, -0.35 * C], 1.1, "#d9c48d");
  } },
  bones: { name: "Bones", cat: "fol", group: "Temple & crypt", w: 1, h: 1, draw(g, seed) {
    // bone = shaft + two knuckles at each end; drawn twice (ink outline pass, then ivory fill) so the outline is one clean silhouette
    const IVORY = "#ece5d3", parts = [];
    const bone = (x, y, a, len, w) => {
      const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2, px = -Math.sin(a) * w * 0.55, py = Math.cos(a) * w * 0.55;
      parts.push(["seg", x - dx, y - dy, x + dx, y + dy, w]);
      for (const e of [-1, 1]) for (const k of [-1, 1]) parts.push(["dot", x + e * dx + k * px, y + e * dy + k * py, w * 0.62]);
    };
    for (let i = 0; i < 3; i++) {
      const a = h(seed, i, 70) * 6.283, x = (h(seed, i, 71) - 0.5) * 0.45 * C, y = (h(seed, i, 72) - 0.5) * 0.45 * C;
      bone(x, y, a, (0.42 + 0.14 * h(seed, i, 73)) * C, 0.07 * C);
    }
    const paint = (ink) => {
      for (const p of parts) {
        g.fillStyle = g.strokeStyle = ink ? PROP_INK : IVORY;
        if (p[0] === "seg") { g.lineCap = "butt"; g.lineWidth = p[5] + (ink ? 2 : 0); g.beginPath(); g.moveTo(p[1], p[2]); g.lineTo(p[3], p[4]); g.stroke(); }
        else { g.beginPath(); g.arc(p[1], p[2], p[3] + (ink ? 1 : 0), 0, 6.283); g.fill(); }
      }
    };
    paint(true); paint(false);
    // skull, seen from above: cranium, brow, eye sockets, nose, teeth
    const sx = (h(seed, 9, 74) - 0.5) * 0.25 * C, sy = (h(seed, 9, 75) - 0.5) * 0.25 * C;
    g.save(); g.translate(sx, sy); g.rotate((h(seed, 9, 76) - 0.5) * 1.2);
    ell(g, 0, -0.02 * C, 0.17 * C, 0.19 * C, 0, IVORY, 1.1);
    ell(g, 0, 0.15 * C, 0.1 * C, 0.06 * C, 0, IVORY, 1);
    ell(g, -0.065 * C, 0.04 * C, 0.045 * C, 0.04 * C, 0, "#3a332c", 0); ell(g, 0.065 * C, 0.04 * C, 0.045 * C, 0.04 * C, 0, "#3a332c", 0);
    polyF(g, [-0.02, 0.1, 0.02, 0.1, 0, 0.065], "#3a332c", 0);
    lines(g, [-0.05 * C, 0.155 * C, 0.05 * C, 0.155 * C, -0.025 * C, 0.13 * C, -0.025 * C, 0.18 * C, 0.025 * C, 0.13 * C, 0.025 * C, 0.18 * C], 0.5, "#6b5f52");
    g.restore();
  } },
  gravestone: { name: "Gravestone", cat: "furn", group: "Temple & crypt", w: 1, h: 2, draw(g, seed) {
    // grave plot: low dirt mound with a few clods
    g.beginPath(); g.roundRect ? g.roundRect(-0.32 * C, -0.42 * C, 0.64 * C, 1.28 * C, 0.2 * C) : g.rect(-0.32 * C, -0.42 * C, 0.64 * C, 1.28 * C);
    g.fillStyle = "#8f7a5b"; g.fill(); g.strokeStyle = "rgba(40,30,20,.7)"; g.lineWidth = 0.9; g.stroke();
    g.fillStyle = "rgba(60,45,30,.45)"; g.beginPath();
    for (let i = 0; i < 7; i++) { const x = (h(seed, i, 120) - 0.5) * 0.45 * C, y = (-0.3 + h(seed, i, 121) * 1.05) * C, r = 0.6 + h(seed, i, 122) * 0.8; g.moveTo(x + r, y); g.arc(x, y, r, 0, 6.283); }
    g.fill();
    for (let i = 0; i < 3; i++) { const x = (h(seed, i, 123) - 0.5) * 0.4 * C, y = (0.1 + h(seed, i, 124) * 0.6) * C; lines(g, [x - 1.5, y, x, y - 3, x, y, x + 0.4, y - 3.6, x, y, x + 1.8, y - 2.4], 0.6, "#4f6b36"); }
    // headstone: thick slab seen from above, with a shadow and a carved cross on the top edge
    g.fillStyle = "rgba(30,25,20,.3)"; g.fillRect(-0.36 * C, -0.86 * C, 0.78 * C, 0.36 * C);
    box(g, -0.4 * C, -0.92 * C, 0.8 * C, 0.34 * C, "#a7a297", 1.3);
    box(g, -0.4 * C, -0.92 * C, 0.8 * C, 0.1 * C, "#c3beb3", 0.8);
    lines(g, [0, -0.78 * C, 0, -0.62 * C, -0.07 * C, -0.73 * C, 0.07 * C, -0.73 * C], 1, "#5e5a52");
  } },
  // arcane & craft
  circle: { name: "Magic circle", cat: "furn", group: "Arcane & craft", w: 3, h: 3, draw(g) {
    g.fillStyle = "rgba(120,90,180,.10)"; g.beginPath(); g.arc(0, 0, 1.35 * C, 0, 6.283); g.fill();
    g.strokeStyle = "#5e468f"; g.lineWidth = 1.3; g.beginPath(); g.arc(0, 0, 1.35 * C, 0, 6.283); g.stroke(); g.beginPath(); g.arc(0, 0, 1.12 * C, 0, 6.283); g.stroke();
    g.lineWidth = 1; g.beginPath();
    for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * 4 * Math.PI / 5; g[i ? "lineTo" : "moveTo"](Math.cos(a) * 1.1 * C, Math.sin(a) * 1.1 * C); } g.closePath(); g.stroke();
    g.lineWidth = 0.8; g.beginPath();
    for (let i = 0; i < 20; i++) { const a = i / 20 * 6.283, r1 = 1.17 * C, r2 = 1.3 * C, m = i % 3; g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a + (m - 1) * 0.04) * r2, Math.sin(a + (m - 1) * 0.04) * r2); }
    g.stroke();
  } },
  cauldron: { name: "Cauldron", cat: "furn", group: "Arcane & craft", w: 1, h: 1, draw(g) {
    disc(g, 0, 0, 0.35 * C, "#2e2b28", 1.4); disc(g, 0, 0, 0.26 * C, "#5d9a40", 0.8);
    disc(g, -0.08 * C, -0.05 * C, 0.05 * C, "#9fd07a", 0); disc(g, 0.09 * C, 0.06 * C, 0.035 * C, "#9fd07a", 0);
  } },
  desk: { name: "Desk", cat: "furn", group: "Arcane & craft", w: 2, h: 1, draw(g) {
    box(g, -0.9 * C, -0.35 * C, 1.8 * C, 0.7 * C, "#8b5c37");
    g.save(); g.rotate(-0.15); box(g, -0.55 * C, -0.2 * C, 0.36 * C, 0.44 * C, "#f2ecdc", 0.7); g.restore();
    box(g, 0.05 * C, -0.2 * C, 0.42 * C, 0.3 * C, "#3f5f7a", 0.8); lines(g, [0.26 * C, -0.2 * C, 0.26 * C, 0.1 * C], 0.7);
    flame(g, 0.7 * C, -0.15 * C, 0.07 * C);
  } },
  anvil: { name: "Anvil", cat: "furn", group: "Arcane & craft", w: 1, h: 1, draw(g) {
    box(g, -0.18 * C, -0.2 * C, 0.36 * C, 0.4 * C, "#6d5038", 0.9);
    polyF(g, [-0.45, 0, -0.14, -0.13, 0.32, -0.13, 0.32, 0.13, -0.14, 0.13], "#5d6166", 1.2);
  } },
  forge: { name: "Forge", cat: "furn", group: "Arcane & craft", w: 2, h: 2, draw(g) {
    box(g, -0.9 * C, -0.9 * C, 1.8 * C, 1.8 * C, "#8c847a", 1.4); box(g, -0.55 * C, -0.55 * C, 1.1 * C, 1.1 * C, "#2b2522", 1);
    for (let i = 0; i < 9; i++) disc(g, (-0.35 + (i % 3) * 0.35) * C, (-0.35 + ((i / 3) | 0) * 0.35) * C, 0.13 * C, i % 2 ? "#c9471f" : "#f08a2e", 0);
    flame(g, 0, 0, 0.16 * C);
  } },
  rack: { name: "Weapon rack", cat: "furn", group: "Arcane & craft", w: 2, h: 1, draw(g) {
    box(g, -0.9 * C, -0.35 * C, 1.8 * C, 0.14 * C, "#6a4a2f", 1);
    for (const x of [-0.6, -0.2, 0.2]) { lines(g, [x * C, -0.42 * C, x * C, 0.35 * C], 2.2, PROP_INK); lines(g, [x * C, -0.42 * C, x * C, 0.35 * C], 1.1, "#c9ccd1"); lines(g, [(x - 0.1) * C, -0.12 * C, (x + 0.1) * C, -0.12 * C], 1.6, "#8a6a3e"); }
    lines(g, [0.6 * C, -0.42 * C, 0.6 * C, 0.4 * C], 1.4, "#7a5536"); polyF(g, [0.6, 0.15, 0.78, 0.05, 0.8, 0.35, 0.6, 0.3], "#aeb2b8", 0.9);
  } },
  // wilderness
  campfire: { name: "Campfire", cat: "furn", group: "Wilderness", w: 1, h: 1, draw(g) {
    for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; disc(g, Math.cos(a) * 0.32 * C, Math.sin(a) * 0.32 * C, 0.08 * C, "#9b958a", 0.8); }
    lines(g, [-0.2 * C, -0.12 * C, 0.2 * C, 0.12 * C, -0.2 * C, 0.12 * C, 0.2 * C, -0.12 * C], 2.6, "#5c4127");
    flame(g, 0, 0, 0.15 * C);
  } },
  tent: { name: "Tent", cat: "furn", group: "Wilderness", w: 2, h: 2, draw(g) {
    box(g, -0.8 * C, -0.8 * C, 1.6 * C, 1.6 * C, "#bba77f", 1.3);
    g.fillStyle = "rgba(60,45,25,.18)"; g.fillRect(0, -0.8 * C, 0.8 * C, 1.6 * C);
    lines(g, [0, -0.8 * C, 0, 0.8 * C], 1.2);
    polyF(g, [-0.22, 0.8, 0, 0.45, 0.22, 0.8], "#7d6a48", 1);
  } },
  bedroll: { name: "Bedroll", cat: "furn", group: "Wilderness", w: 1, h: 2, draw(g) {
    g.beginPath(); g.roundRect ? g.roundRect(-0.3 * C, -0.8 * C, 0.6 * C, 1.55 * C, 0.12 * C) : g.rect(-0.3 * C, -0.8 * C, 0.6 * C, 1.55 * C);
    g.fillStyle = "#6f7f5a"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.stroke();
    box(g, -0.24 * C, -0.74 * C, 0.48 * C, 0.26 * C, "#e8dfca", 0.8); lines(g, [-0.3 * C, 0.3 * C, 0.3 * C, 0.3 * C, -0.3 * C, 0.5 * C, 0.3 * C, 0.5 * C], 0.8, "#4a3b2e");
  } },
  pit: { name: "Pit", cat: "furn", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    blobPath(g, 0.48 * C, seed, 8); g.fillStyle = "#6a645b"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.stroke();
    blobPath(g, 0.36 * C, seed + 3, 8, 3); g.fillStyle = "#151210"; g.fill();
  } },
  deadtree: { name: "Dead tree", cat: "fol", group: "Wilderness", w: 2, h: 2, draw(g, seed) {
    const br = (x, y, a, len, w, d) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      lines(g, [x, y, x2, y2], w + 1.4, PROP_INK); lines(g, [x, y, x2, y2], w, "#7a6248");
      if (d > 0) for (const s of [-1, 1]) br(x2, y2, a + s * (0.35 + 0.3 * h(seed, d * 7 + s, Math.round(a * 10))), len * 0.6, w * 0.6, d - 1);
    };
    const n = 5; for (let i = 0; i < n; i++) br(0, 0, i / n * 6.283 + h(seed, i, 80) * 0.6, 0.42 * C, 2.4, 2);
    disc(g, 0, 0, 0.14 * C, "#6a5340", 1.2);
  } },
  cactus: { name: "Cactus", cat: "fol", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    disc(g, 0.22 * C, -0.1 * C, 0.1 * C, "#6f9a52", 1); disc(g, -0.2 * C, 0.14 * C, 0.09 * C, "#6f9a52", 1);
    disc(g, 0, 0, 0.2 * C, "#7aa65a", 1.2);
    const p = []; for (let i = 0; i < 8; i++) { const a = i / 8 * 6.283; p.push(Math.cos(a) * 0.05 * C, Math.sin(a) * 0.05 * C, Math.cos(a) * 0.18 * C, Math.sin(a) * 0.18 * C); } lines(g, p, 0.6, "rgba(40,70,30,.8)");
  } },
  reeds: { name: "Reeds", cat: "fol", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI / 2 + (h(seed, i, 90) - 0.5) * 1.6, l = (0.3 + 0.2 * h(seed, i, 91)) * C, x = (h(seed, i, 92) - 0.5) * 0.2 * C;
      lines(g, [x, 0.25 * C, x + Math.cos(a) * l, 0.25 * C + Math.sin(a) * l], 1, "#4f6b36");
      if (i % 2 === 0) ell(g, x + Math.cos(a) * l, 0.25 * C + Math.sin(a) * l, 0.035 * C, 0.07 * C, a + Math.PI / 2, "#6e4a2c", 0.6);
    }
  } },
  mushrooms: { name: "Mushrooms", cat: "fol", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    for (let i = 0; i < 4; i++) {
      const x = (h(seed, i, 100) - 0.5) * 0.55 * C, y = (h(seed, i, 101) - 0.5) * 0.55 * C, r = (0.09 + 0.09 * h(seed, i, 102)) * C;
      disc(g, x, y, r, h(seed, 0, 103) < 0.5 ? "#c4483c" : "#c9a46a", 0.9);
      disc(g, x - r * 0.3, y - r * 0.3, r * 0.22, "#f4ecdc", 0); disc(g, x + r * 0.35, y + r * 0.1, r * 0.16, "#f4ecdc", 0);
    }
  } },
  stalagmite: { name: "Stalagmite", cat: "fol", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    blobPath(g, 0.4 * C, seed, 7); g.fillStyle = "#8e8779"; g.fill(); g.strokeStyle = PROP_INK; g.lineWidth = 1.1; g.stroke();
    blobPath(g, 0.25 * C, seed + 2, 6, 3); g.fillStyle = "#a9a294"; g.fill();
    disc(g, 0.02 * C, -0.02 * C, 0.09 * C, "#c4beb1", 0.7);
  } },
  crystals: { name: "Crystals", cat: "fol", group: "Wilderness", w: 1, h: 1, draw(g, seed) {
    const col = h(seed, 0, 110) < 0.5 ? ["#9fd3e8", "#d8f1fa"] : ["#b79fe8", "#e6dbfb"];
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * 6.283 + h(seed, i, 111) * 0.8, l = (0.25 + 0.15 * h(seed, i, 112)), w = 0.08;
      g.save(); g.rotate(a);
      polyF(g, [0, -w, l - 0.06, -w, l, 0, l - 0.06, w, 0, w], col[0], 1);
      lines(g, [0, 0, (l - 0.02) * C, 0], 0.6, col[1]);
      g.restore();
    }
    disc(g, 0, 0, 0.08 * C, col[0], 1);
  } },
});
const PROP_GROUPS = ["Furniture", "Tavern & town", "Temple & crypt", "Arcane & craft", "Wilderness", "Foliage"];
const propGroup = P => P.group || (P.cat === "fol" ? "Foliage" : "Furniture");
const PROP_ORDER = Object.keys(PROPS);
function drawProp(g, p, alpha = 1) {
  const P = PROPS[p.t]; if (!P) return;
  g.save(); g.globalAlpha = alpha; g.translate(p.x * CELL, p.y * CELL); g.rotate(p.r); g.scale(p.s, p.s); P.draw(g, p.id); g.restore();
}
function propHit(p, u, v) {
  const P = PROPS[p.t], dx = u - p.x, dy = v - p.y, c = Math.cos(-p.r), sn = Math.sin(-p.r);
  const lx = (dx * c - dy * sn) / p.s, ly = (dx * sn + dy * c) / p.s;
  if (P.cat === "fol") return Math.hypot(lx, ly) <= Math.max(P.w, P.h) * 0.45;
  return Math.abs(lx) <= P.w / 2 && Math.abs(ly) <= P.h / 2;
}
function hitProp(u, v) { for (let i = props.length - 1; i >= 0; i--) if (propHit(props[i], u, v)) return props[i]; return null; }
function snapProp(p) {
  const P = PROPS[p.t]; if (P.cat !== "furn") return;
  const qf = p.r / (Math.PI / 2); if (Math.abs(qf - Math.round(qf)) > 0.01) return; // angled furniture moves freely
  const q = Math.round(qf) & 3, ew = q & 1 ? P.h : P.w, eh = q & 1 ? P.w : P.h;
  p.x = Math.round(p.x - ew / 2) + ew / 2; p.y = Math.round(p.y - eh / 2) + eh / 2;
}
function makeProp(t, u, v, free) {
  const P = PROPS[t], fol = P.cat === "fol";
  const p = { id: nextId++, t, x: u, y: v, r: ghostRot, s: 1 };
  if (!free) snapProp(p);
  return p;
}

// ---------- scene ----------
function inB(b, x, y, m = 0) { return x >= b.x0 - m && x <= b.x1 + m && y >= b.y0 - m && y <= b.y1 + m; }

function bandClip(ctx, b, extra, L) {
  const { boundary } = L.cache, D = L.style.depth + extra, s = CELL, r = D * s;
  ctx.beginPath();
  for (const f of boundary) {
    if (!inB(b, f.x, f.y, D + 1)) continue;
    const x = (f.x - D) * s, y = (f.y - D) * s, w = (1 + 2 * D) * s;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    ctx.lineTo(x + w, y + w - r); ctx.arc(x + w - r, y + w - r, r, 0, Math.PI / 2);
    ctx.lineTo(x + r, y + w); ctx.arc(x + r, y + w - r, r, Math.PI / 2, Math.PI);
    ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    ctx.closePath();
  }
  ctx.clip();
}
function drawRocks(ctx, b, L) {
  const { rockPolys } = L.cache;
  ctx.lineJoin = "round"; ctx.lineWidth = 0.9;
  for (const dark of [false, true]) {
    for (const r of rockPolys) {
      if (r.dark !== dark || !inB(b, r.x, r.y, 1)) continue;
      const g = r.pts;
      ctx.beginPath(); ctx.moveTo(g[0], g[1]); for (let i = 2; i < g.length; i += 2) ctx.lineTo(g[i], g[i + 1]); ctx.closePath();
      ctx.fillStyle = dark ? `hsl(30 6% ${30 + r.tone * 6}%)` : `hsl(32 6% ${55 + r.tone * 7}%)`;
      ctx.fill();
      ctx.strokeStyle = dark ? "#2c2925" : "#a9a398"; ctx.stroke();
    }
  }
}
function drawSurroundings(ctx, b, L) {
  const style = L.style, { boundary, nearList, hatchClusters, roughClusters } = L.cache, D = style.depth, s = CELL;
  if (style.bg === "none" || !boundary.length) return;
  if (style.bg === "rocks") { drawRocks(ctx, b, L); return; }
  ctx.save(); bandClip(ctx, b, style.bg === "rough" ? 0.45 : 0, L);
  if (style.bg === "rough") {
    ctx.fillStyle = "rgba(31,27,24,.17)"; ctx.fillRect(b.x0 * s, b.y0 * s, (b.x1 - b.x0 + 1) * s, (b.y1 - b.y0 + 1) * s);
    ctx.strokeStyle = INK; ctx.lineCap = "round";
    for (const heavy of [false, true]) {
      ctx.lineWidth = heavy ? 2.3 : 1.5; ctx.beginPath();
      for (const c of roughClusters) {
        if (c.heavy !== heavy || !inB(b, c.x, c.y, 1)) continue;
        const g = c.segs;
        for (let i = 0; i < g.length; i += 4) { ctx.moveTo(g[i], g[i + 1]); ctx.lineTo(g[i + 2], g[i + 3]); }
      }
      ctx.stroke();
    }
  } else if (style.bg === "hatch") {
    ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.lineCap = "round"; ctx.beginPath();
    for (const c of hatchClusters) {
      if (!inB(b, c.x, c.y, 1)) continue;
      const g = c.segs;
      for (let i = 0; i < g.length; i += 4) { ctx.moveTo(g[i], g[i + 1]); ctx.lineTo(g[i + 2], g[i + 3]); }
    }
    ctx.stroke();
  } else if (style.bg === "stipple") {
    ctx.fillStyle = INK; ctx.beginPath();
    for (const n of nearList) {
      if (!inB(b, n.x, n.y, 1)) continue;
      const count = Math.round(30 * Math.max(0.2, 1 - 0.75 * n.d / (D + 0.75)));
      for (let i = 0; i < count; i++) {
        const px = (n.x + h(n.x, n.y, 200 + i)) * s, py = (n.y + h(n.x, n.y, 300 + i)) * s, rr = 0.45 + h(n.x, n.y, 400 + i) * 0.5;
        ctx.moveTo(px + rr, py); ctx.arc(px, py, rr, 0, 6.283);
      }
    }
    ctx.fill();
  }
  ctx.restore();
}

function drawScene(ctx, b) {
  const vis = layers.filter(L => L.visible && L.cache);
  // Normally every band goes down first, so one layer's band never covers another layer's floor.
  // A layer set to "cover layers below" draws its band just before its own floor instead, on top of lower layers.
  for (const L of vis) if (!L.style.over) drawSurroundings(ctx, b, L);
  for (const L of vis) { if (L.style.over) drawSurroundings(ctx, b, L); drawLayerBody(ctx, b, L); }
  const s = CELL, W = (activeLayer() ? activeLayer().style.wallW : 0.18) * s;
  for (const p of props) if (PROPS[p.t] && PROPS[p.t].cat === "furn" && inB(b, p.x, p.y, 3)) drawProp(ctx, p);
  // doors
  for (const d of doorEdges) {
    if (!inB(b, d.x, d.y, 1)) continue;
    const len = 0.62 * s, th = Math.max(0.26 * s, W * 1.6);
    const cx = d.o === "h" ? (d.x + 0.5) * s : d.x * s, cy = d.o === "h" ? d.y * s : (d.y + 0.5) * s;
    const w = d.o === "h" ? len : th, hh = d.o === "h" ? th : len;
    ctx.fillStyle = "#fcfbf8"; ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.2, W * 0.45); ctx.lineJoin = "miter";
    ctx.beginPath(); ctx.rect(cx - w / 2, cy - hh / 2, w, hh); ctx.fill(); ctx.stroke();
  }
  for (const p of props) if (PROPS[p.t] && PROPS[p.t].cat === "fol" && inB(b, p.x, p.y, 3)) drawProp(ctx, p);
}

function drawLayerBody(ctx, b, L) {
  const s = CELL, style = L.style, { floorList, wallEdges, shoreEdges, isFloor } = L.cache;
  const isIndoor = isFloor;
  for (const f of floorList) {
    if (!inB(b, f.x, f.y)) continue;
    const T = TEX[f.t];
    if (T.clip) { ctx.save(); ctx.beginPath(); ctx.rect(f.x * s, f.y * s, s, s); ctx.clip(); T.draw(ctx, f.x, f.y); ctx.restore(); }
    else T.draw(ctx, f.x, f.y);
  }

  if (mapStyle().grid) {
    ctx.strokeStyle = "rgba(55,45,35,.22)"; ctx.lineWidth = 0.6; ctx.lineCap = "butt"; ctx.beginPath();
    for (const f of floorList) {
      if (!inB(b, f.x, f.y)) continue;
      if (isFloor(f.x + 1, f.y)) { ctx.moveTo((f.x + 1) * s, f.y * s); ctx.lineTo((f.x + 1) * s, (f.y + 1) * s); }
      if (isFloor(f.x, f.y + 1)) { ctx.moveTo(f.x * s, (f.y + 1) * s); ctx.lineTo((f.x + 1) * s, (f.y + 1) * s); }
    }
    ctx.stroke();
  }

  // soft shadow along the inside of walls
  if (style.shadow && style.wallW > 0) {
    const w = 0.22 * s; ctx.fillStyle = "rgba(31,27,24,.16)"; ctx.beginPath();
    for (const e of wallEdges) {
      if (!inB(b, e.x, e.y, 1)) continue;
      if (e.o === "h") {
        if (isIndoor(e.x, e.y)) ctx.rect(e.x * s, e.y * s, s, w);
        if (isIndoor(e.x, e.y - 1)) ctx.rect(e.x * s, e.y * s - w, s, w);
      } else {
        if (isIndoor(e.x, e.y)) ctx.rect(e.x * s, e.y * s, w, s);
        if (isIndoor(e.x - 1, e.y)) ctx.rect(e.x * s - w, e.y * s, w, s);
      }
    }
    ctx.fill("nonzero");
  }

  // outdoor edges
  if (shoreEdges.length) {
    ctx.strokeStyle = "rgba(31,27,24,.75)"; ctx.lineWidth = 1.2; ctx.lineCap = "round"; ctx.beginPath();
    for (const e of shoreEdges) {
      if (!inB(b, e.x, e.y, 1)) continue;
      if (e.o === "h") { ctx.moveTo(e.x * s, e.y * s); ctx.lineTo((e.x + 1) * s, e.y * s); }
      else { ctx.moveTo(e.x * s, e.y * s); ctx.lineTo(e.x * s, (e.y + 1) * s); }
    }
    ctx.stroke();
  }
  // walls
  const W = style.wallW * s;
  if (W <= 0) return;
  ctx.strokeStyle = INK; ctx.lineWidth = W; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.beginPath();
  const seg = (o, x, y, t0, t1) => {
    if (o === "h") { ctx.moveTo((x + t0) * s, y * s); ctx.lineTo((x + t1) * s, y * s); }
    else { ctx.moveTo(x * s, (y + t0) * s); ctx.lineTo(x * s, (y + t1) * s); }
  };
  for (const e of wallEdges) {
    if (!inB(b, e.x, e.y, 1) || (e.rough && !e.door)) continue;
    if (e.door) { seg(e.o, e.x, e.y, 0, 0.18); seg(e.o, e.x, e.y, 0.82, 1); }
    else seg(e.o, e.x, e.y, 0, 1);
  }
  ctx.stroke();
  // cave walls: jagged line; square corners stay fixed so neighbouring edges still meet
  ctx.lineWidth = W * 1.2; ctx.beginPath();
  for (const e of wallEdges) {
    if (!e.rough || e.door || !inB(b, e.x, e.y, 1)) continue;
    const hx = e.o === "h" ? 1 : 0, hy = 1 - hx, kx = e.x * 2 + hy;
    ctx.moveTo(e.x * s, e.y * s);
    for (let i = 1; i <= 5; i++) {
      const t = i / 6, off = (h(kx, e.y, 990 + i) - 0.5) * 0.3 * Math.sin(t * Math.PI) * 1.6 * s;
      ctx.lineTo((e.x + hx * t) * s + hy * off, (e.y + hy * t) * s + hx * off);
    }
    ctx.lineTo((e.x + hx) * s, (e.y + hy) * s);
  }
  ctx.stroke();

}

// ---------- view / canvas ----------
const stage = $("stage");
const canvas = $("map");
const ctx = canvas.getContext("2d");
let dpr = 1, VW = 0, VH = 0;
const view = { x: 0, y: 0, z: 1 };
let needs = false;
function requestRender() { if (!needs) { needs = true; requestAnimationFrame(render); } }

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  VW = r.width; VH = r.height;
  canvas.width = Math.max(1, Math.round(VW * dpr)); canvas.height = Math.max(1, Math.round(VH * dpr));
  requestRender();
}
const ro = new ResizeObserver(resize); ro.observe(stage);

const toWorld = (sx, sy) => [(sx - view.x) / view.z, (sy - view.y) / view.z];

let preview = null; // {kind:'rect', x0,y0,x1,y1, erase} | {kind:'line', ...}
let hover = null;   // {kind:'edge', e} | {kind:'cell', x,y}

function render() {
  needs = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const z = view.z;
  ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * view.x, dpr * view.y);
  const b = {
    x0: Math.floor(-view.x / z / CELL) - 1, y0: Math.floor(-view.y / z / CELL) - 1,
    x1: Math.ceil((VW - view.x) / z / CELL) + 1, y1: Math.ceil((VH - view.y) / z / CELL) + 1
  };
  // faint placement dots on blank paper (editor only)
  if (z * CELL >= 14) {
    ctx.fillStyle = "rgba(60,55,50,.22)";
    const r = 1.1 / z;
    for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) ctx.fillRect(x * CELL - r, y * CELL - r, 2 * r, 2 * r);
  }
  drawScene(ctx, b);

  const accent = getComputedStyle(root).getPropertyValue("--dm-accent").trim() || "#2b7a6e";
  if (preview && preview.kind === "rect") {
    const x = Math.min(preview.x0, preview.x1), y = Math.min(preview.y0, preview.y1);
    const w = Math.abs(preview.x1 - preview.x0) + 1, hh = Math.abs(preview.y1 - preview.y0) + 1;
    ctx.fillStyle = preview.erase ? "rgba(168,67,47,.16)" : "rgba(43,122,110,.16)";
    ctx.strokeStyle = preview.erase ? "#a8432f" : accent;
    ctx.lineWidth = 2 / z; ctx.setLineDash([6 / z, 4 / z]);
    ctx.fillRect(x * CELL, y * CELL, w * CELL, hh * CELL); ctx.strokeRect(x * CELL, y * CELL, w * CELL, hh * CELL);
    ctx.setLineDash([]);
    // size label
    const label = w + " × " + hh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = x * CELL * z + view.x, sy = y * CELL * z + view.y;
    ctx.font = "500 12px " + "ui-monospace, Menlo, monospace";
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = preview.erase ? "#a8432f" : accent; ctx.fillRect(sx, sy - 24, tw, 20);
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(label, sx + 6, sy - 14);
  } else if (preview && preview.kind === "line") {
    ctx.strokeStyle = preview.erase ? "#a8432f" : accent; ctx.lineWidth = Math.max(3 / z, (activeLayer() ? activeLayer().style.wallW : 0.18) * CELL); ctx.lineCap = "round";
    ctx.globalAlpha = .75; ctx.beginPath(); ctx.moveTo(preview.ax * CELL, preview.ay * CELL); ctx.lineTo(preview.bx * CELL, preview.by * CELL); ctx.stroke(); ctx.globalAlpha = 1;
  } else if (hover && hover.kind === "ghost") {
    drawProp(ctx, hover.p, 0.5);
  } else if (hover) {
    ctx.strokeStyle = accent; ctx.lineWidth = 2 / z;
    if (hover.kind === "cell") ctx.strokeRect(hover.x * CELL, hover.y * CELL, CELL, CELL);
    else if (hover.kind === "edge") {
      const [o, xs, ys] = hover.e.split(":"), x = +xs, y = +ys;
      ctx.lineWidth = 4 / z; ctx.lineCap = "round"; ctx.globalAlpha = .8; ctx.beginPath();
      if (o === "h") { ctx.moveTo(x * CELL, y * CELL); ctx.lineTo((x + 1) * CELL, y * CELL); }
      else { ctx.moveTo(x * CELL, y * CELL); ctx.lineTo(x * CELL, (y + 1) * CELL); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }
  if (selected) {
    const P = PROPS[selected.t], pad = 0.08;
    ctx.save(); ctx.translate(selected.x * CELL, selected.y * CELL); ctx.rotate(selected.r); ctx.scale(selected.s, selected.s);
    ctx.strokeStyle = accent; ctx.lineWidth = 2 / z / selected.s; ctx.setLineDash([5 / z, 3 / z]);
    if (P.cat === "fol") { ctx.beginPath(); ctx.arc(0, 0, (Math.max(P.w, P.h) * 0.45 + pad) * CELL, 0, 6.283); ctx.stroke(); }
    else ctx.strokeRect((-P.w / 2 - pad) * CELL, (-P.h / 2 - pad) * CELL, (P.w + 2 * pad) * CELL, (P.h + 2 * pad) * CELL);
    ctx.restore(); ctx.setLineDash([]);
  }
  $("zoomLbl").textContent = Math.round(z * 100) + "%";
}

function zoomAt(sx, sy, factor) {
  const z = Math.min(5, Math.max(0.15, view.z * factor));
  const [wx, wy] = toWorld(sx, sy);
  view.z = z; view.x = sx - wx * z; view.y = sy - wy * z;
  requestRender();
}
function bandMargin() { let m = 1; for (const L of layers) if (L.visible && L.style.bg !== "none") m = Math.max(m, Math.ceil(L.style.depth) + 1); return m; }
function mapBounds() { // in cells, x1/y1 exclusive
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of floorList) { x0 = Math.min(x0, f.x); y0 = Math.min(y0, f.y); x1 = Math.max(x1, f.x + 1); y1 = Math.max(y1, f.y + 1); }
  for (const p of props) { const P = PROPS[p.t]; if (!P) continue; const r = Math.max(P.w, P.h) * p.s / 2; x0 = Math.min(x0, Math.floor(p.x - r)); y0 = Math.min(y0, Math.floor(p.y - r)); x1 = Math.max(x1, Math.ceil(p.x + r)); y1 = Math.max(y1, Math.ceil(p.y + r)); }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}
function fitView() {
  const mb = mapBounds();
  if (!mb) { view.z = 1; view.x = VW / 2; view.y = VH / 2; requestRender(); return; }
  let { x0, y0, x1, y1 } = mb;
  const m = bandMargin(); x0 -= m; y0 -= m; x1 += m; y1 += m;
  const w = (x1 - x0) * CELL, hh = (y1 - y0) * CELL;
  view.z = Math.min(2.5, Math.max(0.15, Math.min(VW / w, VH / hh)));
  view.x = VW / 2 - (x0 * CELL + w / 2) * view.z; view.y = VH / 2 - (y0 * CELL + hh / 2) * view.z;
  requestRender();
}

// ---------- history & persistence ----------
function serialize() {
  const ls = layers.map(L => {
    const c = []; for (const [k, t] of L.cells) { const [x, y] = k.split(","); c.push([+x, +y, TEX_ORDER.indexOf(t)]); }
    return { id: L.id, name: L.name, visible: L.visible, style: { ...L.style }, cells: c };
  });
  return { app: "delve-mapper", v: 3, active: activeId, layers: ls, walls: [...walls], doors: [...doors], props: props.map(p => [p.t, +p.x.toFixed(3), +p.y.toFixed(3), +p.r.toFixed(4), +p.s.toFixed(3), p.id]), style: { grid: style.grid, ppc: style.ppc } };
}
// Older maps kept one set of squares and one style: indoor floors become "Dungeon", grass and water become "Outdoors" underneath.
function layersFromLegacy(cellMap, legacy) {
  const out = [], inn = [];
  for (const [k, t] of cellMap) (TEX[t] && TEX[t].outdoor ? out : inn).push([k, t]);
  const res = [];
  if (out.length) { const L = makeLayer("Outdoors", { ...legacy, bg: "none", wallW: 0.04, shadow: false }); for (const [k, t] of out) L.cells.set(k, t); res.push(L); }
  if (inn.length || !out.length) { const L = makeLayer("Dungeon", legacy); for (const [k, t] of inn) L.cells.set(k, t); res.push(L); }
  return res;
}
function load(data) {
  if (!data || !(Array.isArray(data.cells) || Array.isArray(data.layers))) throw new Error("bad");
  walls = new Set(data.walls || []); doors = new Set(data.doors || []);
  style = { ...DEFAULT_STYLE, ...(data.style || {}) };
  if (!data.v || data.v < 2) style.depth = Math.min(style.depth, 1); // v1 maps: tighter hatching by default
  nextLayerId = 1;
  if (Array.isArray(data.layers)) {
    layers = data.layers.map(d => {
      const L = makeLayer(d.name || "Layer", d.style || {}); L.visible = d.visible !== false;
      if (d.id) { L.id = d.id; nextLayerId = Math.max(nextLayerId, d.id + 1); }
      for (const [x, y, t] of d.cells || []) L.cells.set(key(x, y), TEX_ORDER[t] || "plain");
      return L;
    });
    if (!layers.length) layers = [makeLayer("Dungeon")];
  } else {
    const m = new Map(); for (const [x, y, t] of data.cells) m.set(key(x, y), TEX_ORDER[t] || "plain");
    layers = layersFromLegacy(m, style);
  }
  setActive(layers.some(L => L.id === data.active) ? data.active : layers[layers.length - 1].id);
  props = []; nextId = 1;
  for (const a of data.props || []) { if (!PROPS[a[0]]) continue; const id = a[5] || nextId; props.push({ t: a[0], x: a[1], y: a[2], r: a[3] || 0, s: a[4] || 1, id }); nextId = Math.max(nextId, id + 1); }
  if (selected) selected = props.find(p => p.id === selected.id) || null;
  rebuild(); syncStyleUI(); syncSel(); renderLayers(); requestRender();
}
function begin() { undoStack.push(JSON.stringify(serialize())); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; updateUndoUI(); }
function changed() { rebuild(); requestRender(); saveLocal(); refreshCounts(); }
function refreshCounts() { if (typeof layerList === "undefined") return; layerList.querySelectorAll(".layer").forEach(r => { const L = layers.find(l => l.id === +r.dataset.id); if (L) r.querySelector(".lcount").textContent = L.cells.size ? L.cells.size + " sq" : "empty"; }); }
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(serialize())); load(JSON.parse(undoStack.pop())); saveLocal(); updateUndoUI(); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(serialize())); load(JSON.parse(redoStack.pop())); saveLocal(); updateUndoUI(); }
function updateUndoUI() { $("undo").disabled = !undoStack.length; $("redo").disabled = !redoStack.length; }
let saveT = 0;
function saveLocal() { clearTimeout(saveT); saveT = setTimeout(() => { if (alive) opts.onChange(serialize()); }, 250); }

// ---------- editing ops ----------
function fillRect(x0, y0, x1, y1, erase) {
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    if (erase) cells.delete(key(x, y)); else cells.set(key(x, y), curTex);
  }
  if (erase) props = props.filter(p => { const gone = p.x >= ax && p.x <= bx + 1 && p.y >= ay && p.y <= by + 1; if (gone && p === selected) selected = null; return !gone; });
  if (erase) { // drop interior walls / doors fully inside the erased block
    for (const set of [walls, doors]) for (const e of [...set]) { const [a, b, c, d] = edgeCells(e); if (!isFloor(a, b) && !isFloor(c, d)) set.delete(e); }
  } else { // a fresh room clears interior walls inside it
    for (const e of [...walls]) { const [a, b, c, d] = edgeCells(e); if (a >= ax && a <= bx && c >= ax && c <= bx && b >= ay && b <= by && d >= ay && d <= by) walls.delete(e); }
  }
}
function paintCell(x, y, erase) { const k = key(x, y); if (erase) cells.delete(k); else cells.set(k, curTex); }
function nearestEdge(wx, wy) {
  const u = wx / CELL, v = wy / CELL, cx = Math.floor(u), cy = Math.floor(v), fx = u - cx, fy = v - cy;
  const m = Math.min(fx, 1 - fx, fy, 1 - fy);
  if (m === fx) return "v:" + cx + ":" + cy;
  if (m === 1 - fx) return "v:" + (cx + 1) + ":" + cy;
  if (m === fy) return "h:" + cx + ":" + cy;
  return "h:" + cx + ":" + (cy + 1);
}
const isWallEdge = e => { const [a, b, c, d] = edgeCells(e); return (isFloor(a, b) !== isFloor(c, d)) || walls.has(e); };

// ---------- input ----------
const pointers = new Map();
let action = null, spaceDown = false, pinch = null;
function cellAt(sx, sy) { const [wx, wy] = toWorld(sx, sy); return [Math.floor(wx / CELL), Math.floor(wy / CELL)]; }
function cornerAt(sx, sy) { const [wx, wy] = toWorld(sx, sy); return [Math.round(wx / CELL), Math.round(wy / CELL)]; }
function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("pointerdown", e => {
  appEl.focus({ preventScroll: true });
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = local(e);
  pointers.set(e.pointerId, { x: sx, y: sy });
  if (pointers.size === 2) { // switch to pinch; cancel any edit in progress
    if (action && (action.began || action.kind === "move")) { load(JSON.parse(undoStack.pop())); updateUndoUI(); }
    action = null; preview = null;
    const [p1, p2] = [...pointers.values()];
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    pinch = { d0: Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1, z0: view.z, w0: toWorld(c.x, c.y) };
    requestRender(); return;
  }
  if (pointers.size > 2) return;
  const erase = e.button === 2 || e.altKey;
  if (e.button === 1 || tool === "pan" || spaceDown) { action = { kind: "pan", sx, sy, vx: view.x, vy: view.y }; canvas.style.cursor = "grabbing"; return; }
  if ((tool === "room" || tool === "erase" || tool === "brush") && activeLayer() && !activeLayer().visible) toast("\u201c" + activeLayer().name + "\u201d is hidden. Show it to see what you draw.");
  if (tool === "room" || tool === "erase") {
    const [x, y] = cellAt(sx, sy);
    action = { kind: "rect", erase: erase || tool === "erase" };
    preview = { kind: "rect", x0: x, y0: y, x1: x, y1: y, erase: action.erase };
  } else if (tool === "brush") {
    begin(); const [x, y] = cellAt(sx, sy);
    action = { kind: "brush", erase, lx: x, ly: y, began: true };
    paintCell(x, y, erase); changed();
  } else if (tool === "wall") {
    const [ax, ay] = cornerAt(sx, sy);
    action = { kind: "wall", ax, ay, erase, sx, sy, moved: false };
    preview = { kind: "line", ax, ay, bx: ax, by: ay, erase };
  } else if (tool === "prop") {
    const [wx, wy] = toWorld(sx, sy), u = wx / CELL, v = wy / CELL, hit = hitProp(u, v);
    hover = null;
    if (hit && erase) { begin(); props.splice(props.indexOf(hit), 1); if (selected === hit) selected = null; propsChanged(); }
    else if (hit) { selected = hit; syncSel(); begin(); props.splice(props.indexOf(hit), 1); props.push(hit); action = { kind: "move", p: hit, ox: u - hit.x, oy: v - hit.y, moved: false }; }
    else if (!erase) {
      begin(); const p = makeProp(curProp, u, v, e.altKey); props.push(p); selected = p; propsChanged();
      action = PROPS[curProp].cat === "fol" ? { kind: "scatter", lx: u, ly: v, began: true } : { kind: "move", p, ox: u - p.x, oy: v - p.y, moved: true, placed: true };
    } else { selected = null; }
    syncSel();
  } else if (tool === "door") {
    const [wx, wy] = toWorld(sx, sy), ed = nearestEdge(wx, wy);
    if (doors.has(ed)) { begin(); doors.delete(ed); changed(); }
    else if (edgeTouchesFloor(ed)) { begin(); doors.add(ed); changed(); }
    else toast("Doors go on a wall or between two floor squares.");
  }
  requestRender();
});
canvas.addEventListener("pointermove", e => {
  const [sx, sy] = local(e);
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: sx, y: sy });
  if (pinch && pointers.size >= 2) {
    const [p1, p2] = [...pointers.values()];
    const c = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    const z = Math.min(5, Math.max(0.15, pinch.z0 * Math.hypot(p1.x - p2.x, p1.y - p2.y) / pinch.d0));
    view.z = z; view.x = c.x - pinch.w0[0] * z; view.y = c.y - pinch.w0[1] * z; requestRender(); return;
  }
  updateHud(sx, sy);
  if (!action) {
    if (e.pointerType === "mouse") {
      const [wx, wy] = toWorld(sx, sy);
      if (tool === "prop") {
        const u = wx / CELL, v = wy / CELL;
        if (hitProp(u, v)) { hover = null; canvas.style.cursor = "move"; }
        else { canvas.style.cursor = "crosshair"; const p = { id: nextId, t: curProp, x: u, y: v, r: ghostRot, s: 1 }; if (!e.altKey) snapProp(p); hover = { kind: "ghost", p }; }
      } else if (tool === "door" || tool === "wall") hover = { kind: "edge", e: nearestEdge(wx, wy) };
      else if (tool === "brush" || tool === "room" || tool === "erase") hover = { kind: "cell", x: Math.floor(wx / CELL), y: Math.floor(wy / CELL) };
      else hover = null;
      requestRender();
    }
    return;
  }
  if (action.kind === "move") {
    const [wx, wy] = toWorld(sx, sy), p = action.p;
    const nx = wx / CELL - action.ox, ny = wy / CELL - action.oy;
    if (!action.moved && Math.hypot(nx - p.x, ny - p.y) < 0.15) return;
    action.moved = true; p.x = nx; p.y = ny; if (!e.altKey) snapProp(p); propsChanged(); return;
  }
  if (action.kind === "scatter") {
    const [wx, wy] = toWorld(sx, sy), u = wx / CELL, v = wy / CELL, P = PROPS[curProp];
    const gap = Math.max(P.w, P.h) * 0.75;
    if (Math.hypot(u - action.lx, v - action.ly) >= gap) {
      const j = Math.max(P.w, P.h) * 0.3;
      props.push(makeProp(curProp, u + (Math.random() - 0.5) * j, v + (Math.random() - 0.5) * j, true));
      action.lx = u; action.ly = v; propsChanged();
    }
    return;
  }
  if (action.kind === "pan") { view.x = action.vx + sx - action.sx; view.y = action.vy + sy - action.sy; requestRender(); }
  else if (action.kind === "rect") { const [x, y] = cellAt(sx, sy); preview.x1 = x; preview.y1 = y; requestRender(); }
  else if (action.kind === "brush") {
    const [x, y] = cellAt(sx, sy);
    const steps = Math.max(Math.abs(x - action.lx), Math.abs(y - action.ly));
    for (let i = 1; i <= steps; i++) paintCell(Math.round(action.lx + (x - action.lx) * i / steps), Math.round(action.ly + (y - action.ly) * i / steps), action.erase);
    if (steps) { action.lx = x; action.ly = y; changed(); }
  } else if (action.kind === "wall") {
    const [cx, cy] = cornerAt(sx, sy);
    if (Math.hypot(sx - action.sx, sy - action.sy) > 6) action.moved = true;
    if (Math.abs(cx - action.ax) >= Math.abs(cy - action.ay)) { preview.bx = cx; preview.by = action.ay; }
    else { preview.bx = action.ax; preview.by = cy; }
    requestRender();
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; if (!pointers.size) action = null; return; }
  if (!action) return;
  const [sx, sy] = local(e);
  if (action.kind === "move" && !action.moved) { undoStack.pop(); updateUndoUI(); }
  if (action.kind === "rect") {
    begin(); fillRect(preview.x0, preview.y0, preview.x1, preview.y1, action.erase); changed();
  } else if (action.kind === "wall") {
    if (!action.moved) { // click: toggle nearest interior wall
      const [wx, wy] = toWorld(sx, sy), ed = nearestEdge(wx, wy);
      if (walls.has(ed)) { begin(); walls.delete(ed); changed(); }
      else { const [a, b, c, d] = edgeCells(ed); if (isFloor(a, b) && isFloor(c, d)) { begin(); walls.add(ed); changed(); } else if (!isWallEdge(ed)) toast("Interior walls go between two floor squares."); }
    } else {
      const { ax, ay, bx, by } = preview, list = [];
      if (ay === by) for (let x = Math.min(ax, bx); x < Math.max(ax, bx); x++) list.push("h:" + x + ":" + ay);
      else for (let y = Math.min(ay, by); y < Math.max(ay, by); y++) list.push("v:" + ax + ":" + y);
      const ok = list.filter(ed => { const [a, b, c, d] = edgeCells(ed); return isFloor(a, b) && isFloor(c, d); });
      if (ok.length) { begin(); ok.forEach(ed => preview.erase ? walls.delete(ed) : walls.add(ed)); changed(); }
    }
  }
  action = null; preview = null; canvas.style.cursor = cursorFor(); requestRender();
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);
canvas.addEventListener("pointerleave", () => { if (!action) { hover = null; requestRender(); } });
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const [sx, sy] = local(e);
  const lineMode = e.deltaMode === 1;
  if (e.ctrlKey || lineMode || (Math.abs(e.deltaY) >= 40 && e.deltaX === 0)) zoomAt(sx, sy, Math.exp(-e.deltaY * (lineMode ? 0.05 : e.ctrlKey ? 0.01 : 0.0015)));
  else { view.x -= e.deltaX; view.y -= e.deltaY; requestRender(); }
}, { passive: false });

function updateHud(sx, sy) {
  const [x, y] = cellAt(sx, sy);
  const hints = {
    room: "Drag to draw a room", brush: "Drag to paint squares", erase: "Drag to erase floor",
    wall: "Drag along grid lines to add a wall", door: "Click a wall to add a door", pan: "Drag to move the view",
    prop: "Click to place " + PROPS[curProp].name.toLowerCase() + " · drag props to move · right-click deletes"
  };
  const hud = $("hud");
  hud.innerHTML = "<b>" + hints[tool] + "</b>" + (sx == null ? "" : " · " + x + ", " + y);
}

// ---------- UI wiring ----------
const cursorFor = () => (tool === "pan" || spaceDown) ? "grab" : "crosshair";
function setTool(t) {
  tool = t; hover = null;
  root.querySelectorAll("[data-tool]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tool === t));
  canvas.style.cursor = cursorFor(); updateHud(); if (typeof syncSel === "function") syncSel(); requestRender();
}
root.querySelectorAll("[data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);
$("zoomIn").addEventListener("click", () => zoomAt(VW / 2, VH / 2, 1.25));
$("zoomOut").addEventListener("click", () => zoomAt(VW / 2, VH / 2, 0.8));
$("zoomFit").addEventListener("click", fitView);

const panel = $("panel"), styleToggle = $("styleToggle");
styleToggle.addEventListener("click", () => { const o = panel.classList.toggle("open"); styleToggle.setAttribute("aria-expanded", o); styleToggle.setAttribute("aria-pressed", o); });

// texture swatches
const swWrap = $("swatches");
TEX_ORDER.forEach((t, i) => {
  const b = document.createElement("button"); b.className = "swatch"; b.dataset.tex = t;
  b.innerHTML = '<canvas width="180" height="120"></canvas><span class="nm"><span>' + TEX[t].name + "</span>" + (i < 10 ? "<kbd>" + ((i + 1) % 10) + "</kbd>" : "") + "</span>";
  b.addEventListener("click", () => setTex(t));
  swWrap.appendChild(b);
});
function drawSwatches() {
  swWrap.querySelectorAll(".swatch").forEach((b, n) => {
    const c = b.querySelector("canvas"), g = c.getContext("2d"), t = b.dataset.tex;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = PAPER; g.fillRect(0, 0, c.width, c.height);
    const sc = c.width / (CELL * 3), ox = 20, oy = 40 + n * 5; // sample a patch of the real texture field
    g.setTransform(sc, 0, 0, sc, -ox * CELL * sc, -oy * CELL * sc);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) { g.save(); g.beginPath(); g.rect((ox + x) * CELL, (oy + y) * CELL, CELL, CELL); g.clip(); TEX[t].draw(g, ox + x, oy + y); g.restore(); }
    if (style.grid) {
      g.strokeStyle = "rgba(55,45,35,.22)"; g.lineWidth = 0.6; g.beginPath();
      for (let x = 1; x < 3; x++) { g.moveTo((ox + x) * CELL, oy * CELL); g.lineTo((ox + x) * CELL, (oy + 2) * CELL); }
      g.moveTo(ox * CELL, (oy + 1) * CELL); g.lineTo((ox + 3) * CELL, (oy + 1) * CELL); g.stroke();
    }
  });
}
// layers panel
const layerList = $("layerList");
function renderLayers() {
  layerList.innerHTML = "";
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i], row = document.createElement("div");
    row.className = "layer" + (L.id === activeId ? " active" : "") + (L.visible ? "" : " hidden-layer");
    row.dataset.id = L.id;
    const eye = document.createElement("button");
    eye.className = "eye"; eye.title = L.visible ? "Hide layer" : "Show layer"; eye.setAttribute("aria-label", eye.title);
    eye.innerHTML = L.visible
      ? '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".5"/><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.4"/></svg>';
    eye.addEventListener("click", ev => { ev.stopPropagation(); begin(); L.visible = !L.visible; renderLayers(); changed(); });
    const name = document.createElement("span");
    name.className = "lname"; name.textContent = L.name; name.title = "Double-click to rename";
    name.addEventListener("dblclick", ev => { ev.stopPropagation(); startRename(L, name); });
    const count = document.createElement("span");
    count.className = "lcount"; count.textContent = L.cells.size ? L.cells.size + " sq" : "empty";
    row.append(eye, name, count);
    row.addEventListener("click", () => selectLayer(L.id));
    layerList.appendChild(row);
  }
  if (document.activeElement === document.body && root.isConnected) appEl.focus({ preventScroll: true }); // keep shortcuts working after the list redraws
  const i = layers.findIndex(L => L.id === activeId);
  $("layerUp").disabled = i >= layers.length - 1; $("layerDown").disabled = i <= 0; $("layerDel").disabled = layers.length <= 1;
}
// Selecting only restyles the rows (no redraw), so a double-click lands on the same element twice.
function selectLayer(id) {
  if (id === activeId) return;
  setActive(id); syncStyleUI();
  layerList.querySelectorAll(".layer").forEach(r => r.classList.toggle("active", +r.dataset.id === id));
  const i = layers.findIndex(L => L.id === activeId);
  $("layerUp").disabled = i >= layers.length - 1; $("layerDown").disabled = i <= 0;
  updateHud();
}
function startRename(L, span) {
  if (!span || !span.isConnected) return;
  const input = document.createElement("input");
  input.type = "text"; input.value = L.name; input.className = "lname editing"; input.setAttribute("aria-label", "Layer name");
  span.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (save && v && v !== L.name) { begin(); L.name = v; saveLocal(); syncStyleUI(); }
    renderLayers(); appEl.focus({ preventScroll: true });
  };
  input.addEventListener("keydown", ev => { ev.stopPropagation(); if (ev.key === "Enter") finish(true); else if (ev.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  for (const t of ["click", "dblclick", "pointerdown"]) input.addEventListener(t, ev => ev.stopPropagation());
}
$("layerAdd").addEventListener("click", () => {
  begin();
  const cur = activeLayer(), L = makeLayer("Layer " + (layers.length + 1), cur ? cur.style : DEFAULT_STYLE);
  layers.splice(layers.indexOf(cur) + 1, 0, L); setActive(L.id); renderLayers(); syncStyleUI(); changed();
  startRename(L, layerList.querySelector('.layer.active .lname'));
});
function moveLayer(dir) {
  const i = layers.findIndex(L => L.id === activeId), j = i + dir;
  if (i < 0 || j < 0 || j >= layers.length) return;
  begin(); [layers[i], layers[j]] = [layers[j], layers[i]]; renderLayers(); changed();
}
$("layerUp").addEventListener("click", () => moveLayer(1));
$("layerDown").addEventListener("click", () => moveLayer(-1));
$("layerDel").addEventListener("click", () => {
  if (layers.length <= 1) return;
  const L = activeLayer(), i = layers.indexOf(L);
  begin(); layers.splice(i, 1); setActive(layers[Math.max(0, i - 1)].id); renderLayers(); syncStyleUI(); changed();
  toast("Deleted layer \u201c" + L.name + "\u201d. Undo brings it back.");
});

// prop palette
function buildPropPalette() {
  const wrap = $("propGroups"), grids = {};
  for (const name of PROP_GROUPS) {
    const sub = document.createElement("p"); sub.className = "sub"; sub.textContent = name;
    const grid = document.createElement("div"); grid.className = "props";
    wrap.append(sub, grid); grids[name] = grid;
  }
  PROP_ORDER.forEach(t => {
    const P = PROPS[t], b = document.createElement("button");
    b.className = "pbtn"; b.dataset.prop = t; b.title = P.name;
    b.innerHTML = '<canvas width="96" height="96"></canvas><span>' + P.name + "</span>";
    const c = b.querySelector("canvas"), g = c.getContext("2d"), m = Math.max(P.w, P.h), sc = 96 / (CELL * (m + 0.3));
    g.fillStyle = propGroup(P) === "Foliage" ? "#b9cc98" : P.group === "Wilderness" ? "#d8ccb0" : PAPER; g.fillRect(0, 0, 96, 96);
    g.setTransform(sc, 0, 0, sc, 48, 48); P.draw(g, 11 + PROP_ORDER.indexOf(t));
    b.addEventListener("click", () => { setProp(t); setTool("prop"); if (root.clientWidth < 820) { panel.classList.remove("open"); styleToggle.setAttribute("aria-expanded", false); styleToggle.setAttribute("aria-pressed", false); } });
    grids[propGroup(P)].appendChild(b);
  });
}
function setProp(t) { curProp = t; root.querySelectorAll("[data-prop]").forEach(b => b.setAttribute("aria-pressed", b.dataset.prop === t)); updateHud(); }
function propsChanged() { requestRender(); saveLocal(); }
const selbar = $("selbar");
const DEG = Math.PI / 180;
const normDeg = d => ((Math.round(d) % 360) + 360) % 360;
function syncSel() {
  selbar.hidden = tool !== "prop";
  selbar.querySelector(".selonly").hidden = !selected;
  $("selName").textContent = selected ? PROPS[selected.t].name : "New " + PROPS[curProp].name.toLowerCase();
  const ang = $("selAngle");
  if (document.activeElement !== ang) ang.value = normDeg((selected ? selected.r : ghostRot) / DEG);
  requestRender();
}
function setAngle(deg) {
  const r = normDeg(deg) * DEG;
  if (selected) { begin(); selected.r = r; snapProp(selected); propsChanged(); }
  ghostRot = r; // the next props you place use the same rotation
  syncSel();
}
function rotateSel(dir, step = 15) {
  const cur = (selected ? selected.r : ghostRot) / DEG;
  setAngle(Math.round((cur + dir * step) / step) * step);
}
function scaleSel(f) { if (!selected) return; begin(); selected.s = Math.min(3, Math.max(0.4, selected.s * f)); propsChanged(); }
function deleteSel() { if (!selected) return; begin(); props.splice(props.indexOf(selected), 1); selected = null; syncSel(); propsChanged(); }
selbar.addEventListener("click", e => {
  const a = e.target.closest("[data-act]"); if (!a) return;
  ({ rotl: () => rotateSel(-1, e.shiftKey ? 90 : 15), rotr: () => rotateSel(1, e.shiftKey ? 90 : 15), smaller: () => scaleSel(1 / 1.15), larger: () => scaleSel(1.15),
     match: () => { ghostRot = selected.r; toast("New props will be placed at " + normDeg(ghostRot / DEG) + "°."); syncSel(); }, del: deleteSel })[a.dataset.act]();
});
$("selAngle").addEventListener("change", e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setAngle(v); });

function setTex(t) { curTex = t; swWrap.querySelectorAll(".swatch").forEach(b => b.setAttribute("aria-pressed", b.dataset.tex === t)); }

root.querySelectorAll("[data-bg]").forEach(b => b.addEventListener("click", () => { begin(); activeLayer().style.bg = b.dataset.bg; syncStyleUI(); changed(); }));
const depth = $("depth"), wallW = $("wallW"), gridChk = $("gridChk");
depth.addEventListener("input", () => { activeLayer().style.depth = +depth.value; syncStyleUI(); changed(); });
wallW.addEventListener("input", () => { activeLayer().style.wallW = +wallW.value; syncStyleUI(); changed(); });
gridChk.addEventListener("change", () => { style.grid = gridChk.checked; syncStyleUI(); changed(); drawSwatches(); });
$("shadowChk").addEventListener("change", e => { begin(); activeLayer().style.shadow = e.target.checked; changed(); });
$("overChk").addEventListener("change", e => { begin(); activeLayer().style.over = e.target.checked; changed(); });
function syncStyleUI() {
  const ls = activeLayer() ? activeLayer().style : layerStyle();
  root.querySelectorAll("[data-bg]").forEach(b => b.setAttribute("aria-pressed", b.dataset.bg === ls.bg));
  depth.value = ls.depth; $("depthOut").textContent = ls.depth + " sq";
  depth.disabled = ls.bg === "none";
  wallW.value = ls.wallW; $("wallOut").textContent = +ls.wallW > 0 ? (+ls.wallW).toFixed(2) : "none";
  $("layerStyleName").textContent = activeLayer() ? activeLayer().name : "";
  gridChk.checked = style.grid;
  $("shadowChk").checked = !!ls.shadow;
  $("overChk").checked = !!ls.over;
  $("ppc").value = String(style.ppc);
}

let toastT = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => t.style.opacity = 0, 2600); }

// PNG rendering
function renderPng() {
  return new Promise(resolve => {
    const mb = mapBounds();
    if (!mb) { resolve(null); return; }
    const ppc = +style.ppc || 70;
    let { x0, y0, x1, y1 } = mb; x1 -= 1; y1 -= 1;
    const m = bandMargin(); x0 -= m; y0 -= m; x1 += m; y1 += m;
    let scale = ppc / CELL, w = (x1 - x0 + 1) * ppc, hh = (y1 - y0 + 1) * ppc;
    const maxDim = 12000;
    if (Math.max(w, hh) > maxDim) { const k = maxDim / Math.max(w, hh); scale *= k; w = Math.floor(w * k); hh = Math.floor(hh * k); }
    const c = document.createElement("canvas"); c.width = Math.round(w); c.height = Math.round(hh);
    const g = c.getContext("2d");
    g.fillStyle = PAPER; g.fillRect(0, 0, c.width, c.height);
    g.setTransform(scale, 0, 0, scale, -x0 * CELL * scale, -y0 * CELL * scale);
    const keepSel = selected; selected = null;
    drawScene(g, { x0, y0, x1, y1 });
    selected = keepSel;
    c.toBlob(blob => resolve(blob), "image/png");
  });
}
$("exportPng").addEventListener("click", async () => {
  if (!mapBounds()) { toast("Draw a room first, then export."); return; }
  const blob = await renderPng();
  if (blob) opts.onExportPng(blob); else toast("The export failed. Try a smaller pixels-per-square setting.");
});
$("ppc").addEventListener("change", e => { style.ppc = +e.target.value; changed(); });
const newBtn = $("newMap"); let newArmed = 0;
newBtn.addEventListener("click", () => {
  if (!newArmed) { newBtn.textContent = "Click again to clear the map"; newBtn.classList.add("danger-armed"); newArmed = setTimeout(() => { newArmed = 0; newBtn.textContent = "New blank map"; newBtn.classList.remove("danger-armed"); }, 3000); return; }
  clearTimeout(newArmed); newArmed = 0; newBtn.textContent = "New blank map"; newBtn.classList.remove("danger-armed");
  begin(); nextLayerId = 1; layers = [makeLayer("Dungeon")]; setActive(layers[0].id); walls.clear(); doors.clear(); props = []; selected = null; syncSel(); syncStyleUI(); renderLayers(); changed(); fitView(); toast("Map cleared. Undo brings it back.");
});

$("sampleBtn").addEventListener("click", () => {
  begin(); walls.clear(); doors.clear(); props = []; selected = null; nextId = 1; nextLayerId = 1;
  const m = sampleMap(); layers = layersFromLegacy(m, DEFAULT_STYLE); setActive(layers[layers.length - 1].id);
  syncStyleUI(); syncSel(); renderLayers(); changed(); fitView(); toast("Sample loaded. Undo brings your map back.");
});

// keyboard
// Shortcuts work while this map was the last thing clicked, even if focus fell back to the page body.
let rootActive = false;
const onPointerAnywhere = e => { rootActive = root.contains(e.target); };
document.addEventListener("pointerdown", onPointerAnywhere, true);
const keyTargetOk = e => rootActive && root.isConnected && (root.contains(e.target) || e.target === document.body);
const onKeyDown = e => {
  if (!keyTargetOk(e)) return;
  if (e.target.closest && e.target.closest("input, select, textarea")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Space") { if (!spaceDown) { spaceDown = true; canvas.style.cursor = "grab"; } e.preventDefault(); return; }
  const map = { r: "room", b: "brush", e: "erase", w: "wall", d: "door", p: "prop", h: "pan" };
  e.stopPropagation();
  if (map[k]) setTool(map[k]);
  else if (k >= "0" && k <= "9" && k.length === 1) setTex(TEX_ORDER[(+k + 9) % 10]);
  else if (k === "]" || k === "}") rotateSel(1, e.shiftKey ? 90 : 15);
  else if (k === "[" || k === "{") rotateSel(-1, e.shiftKey ? 90 : 15);
  else if ((k === "delete" || k === "backspace") && selected) { e.preventDefault(); deleteSel(); }
  else if ((k === "=" || k === "+") && selected) scaleSel(1.15);
  else if ((k === "-" || k === "_") && selected) scaleSel(1 / 1.15);
  else if (k === "f") fitView();
  else if (k === "g") { style.grid = !style.grid; syncStyleUI(); changed(); drawSwatches(); }
  else if (k === "escape") { if (action) { action = null; preview = null; } selected = null; syncSel(); }
};
window.addEventListener("keydown", onKeyDown);
const onKeyUp = e => { if (e.code === "Space") { spaceDown = false; canvas.style.cursor = cursorFor(); } };
window.addEventListener("keyup", onKeyUp);

// ---------- sample map ----------
function sampleMap() {
  const cells = new Map();
  const put = (x0, y0, x1, y1, t) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.set(key(x, y), t); };
  put(2, 2, 8, 7, "flag");          // entry hall
  put(9, 4, 13, 4, "plain");        // corridor
  put(14, 1, 22, 8, "wood");        // library
  put(5, 8, 5, 9, "dirt");          // passage down
  const cave = [[10, 3, 7], [11, 2, 8], [12, 2, 9], [13, 3, 9], [14, 4, 8], [15, 5, 6]];
  for (const [y, a, b] of cave) put(a, y, b, y, "dirt");
  for (let y = 1; y <= 8; y++) walls.add("v:19:" + y);   // library partition
  ["v:9:4", "v:14:4", "v:19:6", "h:5:8", "h:17:9"].forEach(d => doors.add(d));
  // outdoor clearing south of the library
  put(13, 9, 25, 16, "grass");
  const pond = [[12, 19, 21], [13, 18, 22], [14, 18, 22], [15, 19, 21]];
  for (const [y, a, b] of pond) put(a, y, b, y, "water");
  const P = (t, x, y, r = 0, s = 1) => props.push({ id: nextId++, t, x, y, r, s });
  P("table", 16, 4.5); P("chair", 15.5, 3.5); P("chair", 16.5, 3.5); P("chair", 15.5, 5.5, Math.PI); P("chair", 16.5, 5.5, Math.PI);
  P("shelf", 16, 2); P("shelf", 21, 2); P("rug", 21, 5.5); P("bed", 22.5, 7, Math.PI);
  P("pillar", 3.5, 3.5); P("pillar", 7.5, 3.5); P("pillar", 3.5, 6.5); P("pillar", 7.5, 6.5); P("chest", 5.5, 2.5); P("brazier", 5.5, 5.5);
  P("barrel", 3.5, 11.5); P("barrel", 4.3, 12.4); P("crate", 8.5, 12.5); P("stairs", 6.5, 14, 0); P("rock", 7.6, 10.4);
  P("tree", 14.6, 11.2, 0.4); P("tree", 24, 14.4, 2.1, 1.1); P("pine", 23.5, 10.6, 1); P("pine", 15.2, 15.2, 3);
  P("bush", 17.3, 12.2, 0.2); P("bush", 22.8, 12.1, 2); P("bush", 13.8, 13.6, 4);
  P("grass", 16.4, 15.4); P("grass", 20.6, 16.3); P("grass", 24.4, 12.2); P("flowers", 18, 10.6); P("flowers", 22.3, 16.2);
  P("log", 16.6, 14.2, 0.3); P("rock", 22.6, 12.9, 1, 0.8);
  return cells;
}

// ---------- boot / api ----------
let alive = true;
buildPropPalette(); setProp(curProp);
layers = [makeLayer("Dungeon")]; setActive(layers[0].id);
rebuild(); syncStyleUI(); renderLayers(); setTex(curTex); setTool("room"); drawSwatches(); updateUndoUI();
resize();
return {
  setData(data) {
    walls = new Set(); doors = new Set(); props = []; selected = null;
    nextLayerId = 1; layers = [makeLayer("Dungeon")]; setActive(layers[0].id);
    if (data && (Array.isArray(data.cells) || Array.isArray(data.layers))) { try { load(data); } catch (e) { toast("This map file could not be read."); } }
    else { style = { ...DEFAULT_STYLE }; rebuild(); syncStyleUI(); renderLayers(); }
    undoStack.length = 0; redoStack.length = 0; updateUndoUI(); drawSwatches(); syncSel();
    requestAnimationFrame(() => { resize(); fitView(); });
  },
  getData: serialize,
  renderPng,
  toast,
  destroy() { alive = false; clearTimeout(saveT); ro.disconnect(); window.removeEventListener("keydown", onKeyDown); window.removeEventListener("keyup", onKeyUp); document.removeEventListener("pointerdown", onPointerAnywhere, true); }
};

}
