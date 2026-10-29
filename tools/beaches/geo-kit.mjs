// BRD-59 공간 판정 공통 도구: shp·dbf 읽기, WGS84 → EPSG:5186 변환, 평면 거리 계산
// 외부 패키지 없음. 좌표계·형식은 ESRI Shapefile 기술 문서와 EPSG:5186 정의(prj)를 따름
import { readFileSync } from "node:fs";

// ── dbf 읽기 (dBASE III, 문자 칸만 사용) ──
export function readDbf(path, encoding) {
  const buf = readFileSync(path);
  const count = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let o = 32; buf[o] !== 0x0d; o += 32) {
    fields.push({ name: buf.toString("latin1", o, o + 11).replace(/\0.*$/, ""), len: buf[o + 16] });
  }
  const dec = new TextDecoder(encoding);
  const rows = [];
  for (let i = 0; i < count; i++) {
    let o = headerLen + i * recordLen + 1;
    const row = {};
    for (const f of fields) {
      row[f.name] = dec.decode(buf.subarray(o, o + f.len)).trim();
      o += f.len;
    }
    rows.push(row);
  }
  return rows;
}

// ── shp 읽기 (폴리라인 3·폴리곤 5, Z·M 변형 13·15·23·25). 각 레코드: bbox + parts(점 배열의 배열) ──
// Z·M 변형은 x·y 부분 배치가 같고 뒤에 Z·M 값이 붙음(ESRI Shapefile 기술 문서). x·y만 읽음
// 법정구역정보(브이월드 dsId=21) 읍면동 층은 PolygonZ(15)
const XY_TYPES = new Set([3, 5, 13, 15, 23, 25]);
export function readShp(path, { keep } = {}) {
  const buf = readFileSync(path);
  const out = [];
  let o = 100;
  let index = 0;
  while (o < buf.length) {
    const contentLen = buf.readInt32BE(o + 4) * 2;
    const c = o + 8;
    const type = buf.readInt32LE(c);
    if (XY_TYPES.has(type)) {
      const bbox = [buf.readDoubleLE(c + 4), buf.readDoubleLE(c + 12), buf.readDoubleLE(c + 20), buf.readDoubleLE(c + 28)];
      if (!keep || keep(bbox, index)) {
        const numParts = buf.readInt32LE(c + 36);
        const numPoints = buf.readInt32LE(c + 40);
        const partStart = c + 44;
        const pointStart = partStart + numParts * 4;
        const starts = [];
        for (let p = 0; p < numParts; p++) starts.push(buf.readInt32LE(partStart + p * 4));
        starts.push(numPoints);
        const parts = [];
        for (let p = 0; p < numParts; p++) {
          const pts = [];
          for (let k = starts[p]; k < starts[p + 1]; k++) {
            const q = pointStart + k * 16;
            pts.push([buf.readDoubleLE(q), buf.readDoubleLE(q + 8)]);
          }
          parts.push(pts);
        }
        out.push({ index, type, bbox, parts });
      }
    }
    o = c + contentLen;
    index++;
  }
  return out;
}

// ── WGS84 경위도 → EPSG:5186 (Korea 2000 / Central Belt 2010) ──
// GRS80 타원체, 원점 위도 38°·경도 127°, 축척 1, 가산 동 200000m·북 600000m (raw prj 값)
// Korea 2000 TOWGS84 = 0 → WGS84 좌표를 그대로 대입(차이는 cm 수준)
const A_GRS80 = 6378137;
const F_GRS80 = 1 / 298.257222101;
const LAT0 = 38;
const LON0 = 127;
const FE = 200000;
const FN = 600000;
const rad = (d) => (d * Math.PI) / 180;

// Krüger 급수(n의 4차) — 주 변환
const n = F_GRS80 / (2 - F_GRS80);
const AA = (A_GRS80 / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64);
const ALPHA = [
  n / 2 - (2 * n ** 2) / 3 + (5 * n ** 3) / 16 + (41 * n ** 4) / 180,
  (13 * n ** 2) / 48 - (3 * n ** 3) / 5 + (557 * n ** 4) / 1440,
  (61 * n ** 3) / 240 - (103 * n ** 4) / 140,
  (49561 * n ** 4) / 161280,
];
function krugerRaw(latDeg, lonDeg) {
  const phi = rad(latDeg);
  const dl = rad(lonDeg - LON0);
  const e2n = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e2n * Math.atanh(e2n * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = eta;
  let y = xi;
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1);
    x += a * Math.cos(j * xi) * Math.sinh(j * eta);
    y += a * Math.sin(j * xi) * Math.cosh(j * eta);
  });
  return [AA * x, AA * y];
}
const N_LAT0 = krugerRaw(LAT0, LON0)[1];
export function toEpsg5186(lat, lon) {
  const [x, y] = krugerRaw(lat, lon);
  return [FE + x, FN + (y - N_LAT0)];
}

// Snyder 급수 — 교차 확인용 별도 공식
export function toEpsg5186Snyder(lat, lon) {
  const e2 = 2 * F_GRS80 - F_GRS80 ** 2;
  const ep2 = e2 / (1 - e2);
  const M = (p) =>
    A_GRS80 *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * p -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * p) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * p) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * p));
  const p = rad(lat);
  const nu = A_GRS80 / Math.sqrt(1 - e2 * Math.sin(p) ** 2);
  const T = Math.tan(p) ** 2;
  const C = ep2 * Math.cos(p) ** 2;
  const Aa = rad(lon - LON0) * Math.cos(p);
  const x = nu * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * Aa ** 5) / 120);
  const y =
    M(p) - M(rad(LAT0)) +
    nu * Math.tan(p) * (Aa ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * Aa ** 6) / 720);
  return [FE + x, FN + y];
}

// ── 평면 기하 ──
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function bboxDist(px, py, [x0, y0, x1, y1]) {
  const dx = Math.max(x0 - px, 0, px - x1);
  const dy = Math.max(y0 - py, 0, py - y1);
  return Math.hypot(dx, dy);
}
// 모든 고리에 짝홀 규칙 적용(구멍 고리 포함)
export function insidePolygon(px, py, parts) {
  let inside = false;
  for (const ring of parts)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}
export function boundaryDist(px, py, parts) {
  let best = Infinity;
  for (const ring of parts)
    for (let i = 1; i < ring.length; i++) {
      const d = segDist(px, py, ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1]);
      if (d < best) best = d;
    }
  return best;
}

// 선분 AB 중 중심 (cx,cy)·반경 r 원 안에 든 부분의 중점. 원 밖이면 null
export function clipMidpoint(cx, cy, r, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const A = dx * dx + dy * dy;
  if (!A) return Math.hypot(fx, fy) <= r ? [ax, ay] : null;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - s) / (2 * A));
  const t1 = Math.min(1, (-B + s) / (2 * A));
  if (t0 > t1) return null;
  const t = (t0 + t1) / 2;
  return [ax + t * dx, ay + t * dy];
}

// 다각형 위치 색인: 포함 판정은 다각형별 y-띠(band)의 변만, 최근접 경계는 cell 격자 3×3 칸만 탐색
// locate(x, y) → { k, inside, d, hits } (k = 다각형 번호, 경계에서 cell 넘게 떨어지면 k = -1, hits = 포함 다각형 전부)
export function buildPolygonIndex(polys, { cell = 500, band = 200 } = {}) {
  const grid = new Map();
  const bands = polys.map(() => new Map());
  const push = (m, key, v) => (m.get(key) ?? m.set(key, []).get(key)).push(v);
  polys.forEach((p, k) => {
    for (const ring of p.parts)
      for (let i = 1; i < ring.length; i++) {
        const [ax, ay] = ring[i - 1];
        const [bx, by] = ring[i];
        const e = [k, ax, ay, bx, by];
        for (let gx = Math.floor(Math.min(ax, bx) / cell); gx <= Math.floor(Math.max(ax, bx) / cell); gx++)
          for (let gy = Math.floor(Math.min(ay, by) / cell); gy <= Math.floor(Math.max(ay, by) / cell); gy++) push(grid, `${gx},${gy}`, e);
        for (let b = Math.floor(Math.min(ay, by) / band); b <= Math.floor(Math.max(ay, by) / band); b++) push(bands[k], b, e);
      }
  });
  const inside = (k, px, py) => {
    let c = false;
    for (const [, xi, yi, xj, yj] of bands[k].get(Math.floor(py / band)) ?? [])
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
    return c;
  };
  return {
    cell,
    locate(px, py) {
      const hits = [];
      polys.forEach((p, k) => {
        const [x0, y0, x1, y1] = p.bbox;
        if (px >= x0 && px <= x1 && py >= y0 && py <= y1 && inside(k, px, py)) hits.push(k);
      });
      if (hits.length) return { k: hits[0], inside: true, d: 0, hits };
      let best = Infinity;
      let bk = -1;
      const gx = Math.floor(px / cell);
      const gy = Math.floor(py / cell);
      for (let ix = gx - 1; ix <= gx + 1; ix++)
        for (let iy = gy - 1; iy <= gy + 1; iy++)
          for (const [k, ax, ay, bx, by] of grid.get(`${ix},${iy}`) ?? []) {
            const d = segDist(px, py, ax, ay, bx, by);
            if (d < best) (best = d), (bk = k);
          }
      return best <= cell ? { k: bk, inside: false, d: best } : { k: -1, inside: false, d: best };
    },
  };
}
