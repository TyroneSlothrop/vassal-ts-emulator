/**
 * Port of VASSAL `HexGrid` + the `ASLHexGrid` subclass (non-sideways, non-oblique).
 *
 * Upstream references:
 * - vassal-master/.../boardPicker/board/HexGrid.java (snapTo/edgesLegal/
 *   cornersLegal, snapToHexSide/snapToHexVertex, hexPoint, getSingleHexShape,
 *   getRawColumn/getRawRow, range via cube coords)
 * - $VASL_SRC/build/module/map/boardPicker/board/ASLHexGrid.java
 *   (locationName, getLocation, hexPosition, hexrow)
 * - $VASL_SRC/build/module/map/boardArchive/BoardArchive.java
 *   (geo constants: hexWidth = 1800/32 = 56.25, hexHeight = 645/10 = 64.5,
 *   A1 center = (0, 32.25))
 *
 * Geomorphic boards: columns A..GG left→right (x), rows 1..10 top→bottom (y).
 * Odd raw columns (B, D, …) sit half a hex lower, so their top half-hex is
 * numbered 0 (e.g. B0) and their bottom one 10 — exactly as in ASLHexGrid.
 */

export interface HexGridDef {
  /** center-to-center column spacing (Java HexGrid dx). */
  dx: number;
  /** center-to-center row spacing within a column (Java HexGrid dy). */
  dy: number;
  originX: number;
  originY: number;
  /** ASLHexGrid `alternate` hex grain (some non-geo boards). */
  alternate: boolean;
  /** HexGrid snapScale: >0 allows sub-hex snap points (deluxe boards). */
  snapScale: number;
  /** HexGrid snapTo: false disables snapping unless forced (default true). */
  snapTo?: boolean;
  /** HexGrid edgesLegal: hex sides are legal snap points (default false). */
  edgesLegal?: boolean;
  /** HexGrid cornersLegal: hex corners are legal snap points (default false). */
  cornersLegal?: boolean;
  /** Draw the grid lines over the board (HexGrid visible). */
  visible?: boolean;
  /** Grid line color, CSS-ready (HexGrid color, default black). */
  color?: string;
  /** Stock HexGridNumbering, when the buildFile declares one. */
  numbering?: GridNumberingDef;
}

/**
 * Stock `HexGridNumbering` / `RegularGridNumbering` definition: how hexes are
 * labeled ("0101") and whether the labels are drawn on the board.
 */
export interface GridNumberingDef {
  /** 'H': column name first; 'V': row name first. */
  first: "H" | "V";
  sep: string;
  /** 'N' numeric / 'A' alphabetic, per axis. */
  hType: "N" | "A";
  vType: "N" | "A";
  /** Zero-padding count (numeric only). */
  hLeading: number;
  vLeading: number;
  /** Added to the raw column/row index. */
  hOff: number;
  vOff: number;
  hDescend: boolean;
  vDescend: boolean;
  /** Odd raw columns shift their row number by one (HexGridNumbering). */
  stagger: boolean;
  visible: boolean;
  fontSize: number;
  color: string;
}

export const GEO_HEX_WIDTH = 1800 / 32;
export const GEO_HEX_HEIGHT = 645 / 10;
export const GEO_A1_CENTER = { x: 0, y: GEO_HEX_HEIGHT / 2 };

export function geoGridDef(): HexGridDef {
  return {
    dx: GEO_HEX_WIDTH,
    dy: GEO_HEX_HEIGHT,
    originX: GEO_A1_CENTER.x,
    originY: GEO_A1_CENTER.y,
    alternate: false,
    snapScale: 0,
    snapTo: true,
    edgesLegal: false,
    cornersLegal: false,
  };
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export class HexGridModel {
  constructor(readonly def: HexGridDef) {}

  /** ASLHexGrid.hexrow: 0→A, 1→B, …, 26→AA, 27→BB, … */
  static hexrow(n: number): string {
    let s = "";
    if (n < 0) {
      s = "-";
      n = -n;
    }
    while (n >= 0) {
      s += ALPHABET[n % 26];
      n -= 26;
    }
    return s;
  }

  /** ASLHexGrid.hexPosition: "A1" → (0,1); "bb3" → (27,3). Throws on garbage. */
  static hexPosition(hex: string): { x: number; y: number } {
    hex = hex.toLowerCase();
    let n = 0;
    let signY = 1;
    let nx = hex.charCodeAt(0) - 97;
    if (nx < 0 || nx > 25) throw new Error("Bad Hex Coordinates");
    while (hex[n + 1] != null && (hex[n + 1] < "0" || hex[n + 1] > "9")) {
      if (hex[n + 1] === "-") signY = -1;
      else if (hex[n + 1] !== hex[0]) throw new Error("Bad Hex Coordinates");
      else nx += 26;
      n++;
    }
    const ny = Number.parseInt(hex.substring(n + 1), 10);
    if (!Number.isFinite(ny)) throw new Error("Bad Hex Coordinates");
    return { x: nx, y: signY * ny };
  }

  /** ASLHexGrid.getLocation: hex name → center point (world px). */
  getLocation(hex: string): { x: number; y: number } {
    const { dx, dy, originX, originY, alternate } = this.def;
    hex = hex.toLowerCase();
    let sign = 1;
    if (hex.startsWith("-")) {
      sign = -1;
      hex = hex.substring(1);
    }
    const p = HexGridModel.hexPosition(hex);
    const hexX = Math.floor(dx * p.x + 0.5);
    const hexY = p.x % 2 === 0
      ? Math.floor(dy * (p.y - 1) + 0.5)
      : alternate
        ? Math.floor(dy * (p.y - 1.5) + 0.5)
        : Math.floor(dy * (p.y - 0.5) + 0.5);
    return { x: sign * hexX + originX, y: hexY + originY };
  }

  /**
   * Hex label at a point. With a declared stock HexGridNumbering the label
   * follows it ("0101"); otherwise ASLHexGrid hexrow naming ("F5") applies.
   */
  locationName(x: number, y: number): string {
    if (this.def.numbering) return this.numberedName(x, y);
    return this.hexrowLocationName(x, y);
  }

  /** HexGridNumbering.getRow/getColumn + RegularGridNumbering.getName port. */
  private numberedName(x: number, y: number): string {
    const n = this.def.numbering!;
    const col = this.rawColumn(x);
    let row = this.rawRow(x, y);
    // Descending axes need the grid's max row/column (board-size dependent);
    // no module we bundle uses them — treat as ascending.
    if (n.stagger && col % 2 !== 0) row += n.vDescend ? -1 : 1;
    const colName = axisName(col + n.hOff, n.hType, n.hLeading);
    const rowName = axisName(row + n.vOff, n.vType, n.vLeading);
    return n.first === "H" ? colName + n.sep + rowName : rowName + n.sep + colName;
  }

  /**
   * ASLHexGrid.locationName without the hexside/bypass branch (that branch
   * only fires for points snapped exactly onto a hex side; our snap targets
   * centers). Returns e.g. "F5", or "offboard" for negative rows.
   */
  private hexrowLocationName(x: number, y: number): string {
    const { dx, dy, originX, originY, alternate } = this.def;
    const px = x - originX;
    const py = y + dy / 2 - originY;
    const hexX = Math.floor(px / dx + 0.5);
    let hexY = hexX % 2 === 0
      ? Math.floor(py / dy) + 1
      : Math.floor(py / dy + 0.5);
    if (alternate && hexX % 2 !== 0) hexY++;
    const name = HexGridModel.hexrow(hexX) + hexY;
    return name.includes("-") ? "offboard" : name;
  }

  /** HexGrid raw column/row (odd-q offset coordinates, before numbering). */
  rawColumn(x: number): number {
    return Math.floor((x - this.def.originX) / this.def.dx + 0.5);
  }

  rawRow(x: number, y: number): number {
    const { dx, dy, originX, originY } = this.def;
    const nx = Math.round((x - originX) / dx);
    return nx % 2 === 0
      ? Math.round((y - originY) / dy)
      : Math.round((y - originY - dy / 2) / dy);
  }

  /** HexGrid.range: hex distance via odd-q offset → cube coordinates. */
  range(x1: number, y1: number, x2: number, y2: number): number {
    // Java snaps both points through Map.snapTo (full snapTo, not just centers).
    const a = this.snapTo(x1, y1);
    const b = this.snapTo(x2, y2);
    const c1 = qoffsetToCube(this.rawColumn(a.x), this.rawRow(a.x, a.y));
    const c2 = qoffsetToCube(this.rawColumn(b.x), this.rawRow(b.x, b.y));
    return cubeDistance(c1, c2);
  }

  /** Center of the hex at raw (col,row) — HexGrid.hexPointCenterFromRawIndex. */
  private centerOf(nx: number, ny: number): { x: number; y: number } {
    const { dx, dy, originX, originY } = this.def;
    const x = Math.trunc(dx * nx + originX);
    const y = nx % 2 === 0
      ? Math.trunc(dy * ny + originY)
      : Math.trunc(dy * ny + Math.trunc(dy / 2) + originY);
    return { x, y };
  }

  /**
   * HexGrid.hexPoint: nearest hex center (exact polygon containment against
   * the candidate cell, then its neighbors), plus snapScale sub-hex snapping.
   */
  snapToHex(x: number, y: number): { x: number; y: number } {
    const { dx, dy, originX, originY, snapScale } = this.def;
    const nx = Math.floor((x - originX + dx / 2) / dx);
    const ny = nx % 2 === 0
      ? Math.floor((y - originY + dy / 2) / dy)
      : Math.floor((y - originY) / dy);

    let { x: xLoc, y: yLoc } = this.centerOf(nx, ny);
    if (!this.hexContains(xLoc, yLoc, x, y)) {
      const offsets = nx % 2 === 0
        ? [[-1, -1], [-1, 0], [1, -1], [1, 0]]
        : [[-1, 0], [-1, 1], [1, 0], [1, 1]];
      for (const [ox, oy] of offsets) {
        const c = this.centerOf(nx + ox, ny + oy);
        if (this.hexContains(c.x, c.y, x, y)) {
          xLoc = c.x;
          yLoc = c.y;
          break;
        }
      }
    }

    if (snapScale > 0) {
      xLoc += snapDelta(x - xLoc, dx, snapScale);
      yLoc += snapDelta(y - yLoc, dy, snapScale);
    }
    return { x: xLoc, y: yLoc };
  }

  /**
   * HexGrid.snapTo(p, force, centerOnly): full snap honoring the grid's
   * snapTo/edgesLegal/cornersLegal flags. Non-sideways port, so the Java
   * rotateIfSideways calls are no-ops here.
   */
  snapTo(x: number, y: number, force = false, centerOnly = false): { x: number; y: number } {
    if (this.def.snapTo === false && !force) return { x, y };
    const center = this.snapToHex(x, y);
    if (centerOnly) return center;
    const edges = this.def.edgesLegal === true;
    const corners = this.def.cornersLegal === true;
    if (edges && corners) {
      const edge = this.snapToHexSide(x, y);
      const vertex = this.snapToHexVertex(x, y);
      const dEdge = (x - edge.x) ** 2 + (y - edge.y) ** 2;
      const dVertex = (x - vertex.x) ** 2 + (y - vertex.y) ** 2;
      return this.checkCenter(center, dEdge < dVertex ? edge : vertex);
    }
    if (edges) return this.checkCenter(center, this.snapToHexSide(x, y));
    if (corners) return this.checkCenter(center, this.snapToHexVertex(x, y));
    return center;
  }

  /** HexGrid.snapToHexSide: nearest hex side (or center when snapScale>0 and closer). */
  snapToHexSide(x: number, y: number): { x: number; y: number } {
    let sx = this.sideX(x, y);
    let sy = this.sideY(x, y);
    const { snapScale } = this.def;
    if (snapScale > 0) {
      const c = this.snapToHex(x, y);
      if (Math.abs(x - c.x) + Math.abs(y - c.y) <= Math.abs(x - sx) + Math.abs(y - sy)) {
        sx = c.x;
        sy = c.y;
      }
    }
    return { x: sx, y: sy };
  }

  /** HexGrid.snapToHexVertex: nearest hex corner (or center when snapScale>0 and closer). */
  snapToHexVertex(x: number, y: number): { x: number; y: number } {
    let vx = this.vertexX(x, y);
    let vy = this.vertexY(x, y);
    const { snapScale } = this.def;
    if (snapScale > 0) {
      const c = this.snapToHex(x, y);
      if (Math.abs(x - c.x) + Math.abs(y - c.y) <= Math.abs(x - vx) + Math.abs(y - vy)) {
        vx = c.x;
        vy = c.y;
      }
    }
    return { x: vx, y: vy };
  }

  /** HexGrid.checkCenter: keep the center when it is within ~1px of the target. */
  private checkCenter(center: { x: number; y: number }, target: { x: number; y: number }): { x: number; y: number } {
    const d = (center.x - target.x) ** 2 + (center.y - target.y) ** 2;
    return d <= 2 ? center : target;
  }

  /** HexGrid.sideX/sideY: coordinates of the nearest hex-side point. */
  private sideX(x: number, _y: number): number {
    const { dx, originX } = this.def;
    return Math.trunc((dx / 2) * Math.floor(((x - originX + dx / 4) * 2) / dx) + originX);
  }

  private sideY(x: number, y: number): number {
    const { dx, dy, originX, originY } = this.def;
    const nx = Math.floor(((x - originX + dx / 4) * 2) / dx);
    if (nx % 2 === 0) {
      return Math.trunc((dy / 2) * Math.floor(((y - originY + dy / 4) * 2) / dy) + originY);
    }
    return Math.trunc((dy / 2) * Math.floor(((y - originY) * 2) / dy) + Math.trunc(dy / 4) + originY);
  }

  /** HexGrid.vertexX/vertexY: coordinates of the nearest hex corner. */
  private vertexX(x: number, y: number): number {
    const { dx, dy, originX, originY } = this.def;
    const ny = Math.floor(((y - originY + dy / 4) * 2) / dy);
    if (ny % 2 === 0) {
      return Math.trunc((2 * dx) / 3 * Math.trunc(Math.floor(x - originX + dx / 3) * 3 / (2 * dx)) + originX);
    }
    return Math.trunc(
      (2 * dx) / 3 * Math.trunc(Math.floor(x - originX + (2 * dx) / 3) * 3 / (2 * dx)) - Math.trunc(dx / 3) + originX,
    );
  }

  private vertexY(_x: number, y: number): number {
    const { dy, originY } = this.def;
    return Math.trunc((dy / 2) * Math.floor(((y - originY + dy / 4) * 2) / dy) + originY);
  }

  /** Vertices of the hex centered at (cx,cy) — HexGrid.getSingleHexShape. */
  hexPolygon(cx: number, cy: number): Array<{ x: number; y: number }> {
    const { dx, dy } = this.def;
    const r = (2 * dx) / 3;
    return [
      { x: cx - r, y: cy },
      { x: cx - r / 2, y: cy - dy / 2 },
      { x: cx + r / 2, y: cy - dy / 2 },
      { x: cx + r, y: cy },
      { x: cx + r / 2, y: cy + dy / 2 },
      { x: cx - r / 2, y: cy + dy / 2 },
    ];
  }

  private hexContains(cx: number, cy: number, x: number, y: number): boolean {
    return pointInPolygon(this.hexPolygon(cx, cy), x, y);
  }
}

/** HexGrid snapScale delta: snap to (2*snapScale-1) points across the hex. */
/**
 * RegularGridNumbering.getName(rowOrColumn, type, leading): numeric with
 * `leading` zero-padding, or alphabetic (A..Z, then doubled letters — ported
 * exactly, including the do/while quirk).
 */
export function axisName(value: number, type: "N" | "A", leading: number): string {
  let val = value < 0 ? "-" : "";
  let n = Math.abs(value);
  if (type === "A") {
    do {
      val += ALPHABET[n % 26];
      n -= 26;
    } while (n >= 0);
    return val;
  }
  let lead = leading;
  while (lead > 0 && n < Math.pow(10, lead--)) val += "0";
  return val + n;
}

function snapDelta(delta: number, d: number, snapScale: number): number {
  let v = Math.round(delta / (0.5 * d / snapScale));
  v = Math.max(v, 1 - snapScale);
  v = Math.min(v, snapScale - 1);
  return Math.round(v * 0.5 * d / snapScale);
}

function pointInPolygon(poly: Array<{ x: number; y: number }>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** OffsetCoord.qoffsetToCube with ODD (-1) offset, as both grid classes use. */
function qoffsetToCube(col: number, row: number): { q: number; r: number; s: number } {
  const q = col;
  const r = row - (col - (col & 1)) / 2;
  return { q, r, s: -q - r };
}

function cubeDistance(a: { q: number; r: number; s: number }, b: { q: number; r: number; s: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.s - b.s)) / 2;
}
