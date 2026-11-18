import { describe, expect, it } from "vitest";
import { HexGridModel, axisName, geoGridDef, GEO_HEX_HEIGHT, GEO_HEX_WIDTH } from "../src/vmod/hexgrid";

describe("HexGridModel (geo board 33x10)", () => {
  const grid = new HexGridModel(geoGridDef());

  it("has the upstream geo constants", () => {
    expect(GEO_HEX_WIDTH).toBeCloseTo(56.25);
    expect(GEO_HEX_HEIGHT).toBeCloseTo(64.5);
  });

  it("hexrow letters follow ASLHexGrid.hexrow", () => {
    expect(HexGridModel.hexrow(0)).toBe("A");
    expect(HexGridModel.hexrow(1)).toBe("B");
    expect(HexGridModel.hexrow(25)).toBe("Z");
    expect(HexGridModel.hexrow(26)).toBe("AA");
    expect(HexGridModel.hexrow(32)).toBe("GG");
  });

  it("hexPosition parses single and doubled letters", () => {
    expect(HexGridModel.hexPosition("a1")).toEqual({ x: 0, y: 1 });
    expect(HexGridModel.hexPosition("bb3")).toEqual({ x: 27, y: 3 });
    expect(HexGridModel.hexPosition("gg10")).toEqual({ x: 32, y: 10 });
    expect(() => HexGridModel.hexPosition("b?")).toThrow();
  });

  it("locationName at hex centers matches the printed grid", () => {
    expect(grid.locationName(0, 32.25)).toBe("A1");
    expect(grid.locationName(56.25, 64.5)).toBe("B1");
    // top half-hex of the staggered columns is numbered 0 (ASLHexGrid)
    expect(grid.locationName(56.25, 0)).toBe("B0");
    expect(grid.locationName(1800, 612.75)).toBe("GG10");
  });

  it("getLocation is the inverse of locationName (within int rounding)", () => {
    for (const name of ["A1", "A10", "B0", "B5", "Q7", "GG10"]) {
      const p = grid.getLocation(name);
      expect(grid.locationName(p.x, p.y)).toBe(name);
    }
  });

  it("snapToHex snaps to the nearest center", () => {
    const a1 = grid.snapToHex(5, 30);
    expect(grid.locationName(a1.x, a1.y)).toBe("A1");
    // a point clearly inside B2's hex
    const b2 = grid.getLocation("B2");
    const snapped = grid.snapToHex(b2.x + 10, b2.y - 12);
    expect(snapped).toEqual({ x: Math.trunc(b2.x), y: expect.any(Number) });
    expect(grid.locationName(snapped.x, snapped.y)).toBe("B2");
  });

  it("range counts hexes like the Java cube-coordinate port", () => {
    const at = (h: string) => grid.getLocation(h);
    const range = (h1: string, h2: string) => {
      const a = at(h1);
      const b = at(h2);
      return grid.range(a.x, a.y, b.x, b.y);
    };
    expect(range("A1", "A1")).toBe(0);
    expect(range("A1", "A5")).toBe(4);
    expect(range("A1", "B1")).toBe(1);
    expect(range("A1", "C1")).toBe(2);
    expect(range("A5", "C4")).toBe(2);
    expect(range("A1", "GG10")).toBe(32);
  });

  it("hexPolygon spans 4/3*dx wide and dy tall", () => {
    const poly = grid.hexPolygon(100, 100);
    const xs = poly.map((p) => p.x);
    const ys = poly.map((p) => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((4 * GEO_HEX_WIDTH) / 3);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(GEO_HEX_HEIGHT);
  });
});

describe("stock HexGridNumbering names", () => {
  const def = {
    dx: 55.42562584220407,
    dy: 64,
    originX: 0,
    originY: 32,
    alternate: false,
    snapScale: 0,
    numbering: {
      first: "H" as const, sep: "", hType: "N" as const, vType: "N" as const,
      hLeading: 1, vLeading: 1, hOff: 1, vOff: 1,
      hDescend: false, vDescend: false, stagger: true, visible: true,
      fontSize: 9, color: "rgb(102,204,255)",
    },
  };
  const grid = new HexGridModel(def);

  it("labels hexes column-first with leading zeros", () => {
    // Raw (0,0) center is (0,32): col 1, row 1 -> "0101".
    expect(grid.locationName(0, 32)).toBe("0101");
    // Next hex down the same column.
    expect(grid.locationName(0, 96)).toBe("0102");
    // Odd column staggers its row number (HexGridNumbering.getRow).
    expect(grid.locationName(55.4256, 64)).toBe("0202");
    // Two-digit column, no padding needed.
    expect(grid.locationName(55.4256 * 10, 32)).toBe("1101");
  });

  it("axisName ports RegularGridNumbering.getName exactly", () => {
    expect(axisName(7, "N", 1)).toBe("07");
    expect(axisName(10, "N", 1)).toBe("10");
    expect(axisName(7, "N", 3)).toBe("0007");
    expect(axisName(0, "A", 1)).toBe("A");
    expect(axisName(25, "A", 1)).toBe("Z");
    expect(axisName(-3, "N", 1)).toBe("-03");
  });
});

describe("HexGrid.snapTo (snapTo/edgesLegal/cornersLegal port)", () => {
  // Synthetic 100x100 grid, origin at (0,0): hex (0,0) is centered at (0,0)
  // with vertices (+-66, 0), (+-33, +-50) after int truncation, so its side
  // midpoints are (0, +-50), (+-50, +-25) and its corners the vertex points.
  const base = { dx: 100, dy: 100, originX: 0, originY: 0, alternate: false, snapScale: 0 };
  const mk = (extra: Partial<ConstructorParameters<typeof HexGridModel>[0]>) =>
    new HexGridModel({ ...base, ...extra });

  it("snaps to the hex center when neither edges nor corners are legal", () => {
    const grid = mk({});
    // (45,20) lies inside hex (0,0); the nearest side point is (50,25) but
    // edgesLegal=false keeps the center.
    expect(grid.snapTo(45, 20)).toEqual({ x: 0, y: 0 });
  });

  it("snaps to the hex side when edgesLegal (HexGrid.snapToHexSide)", () => {
    const grid = mk({ edgesLegal: true });
    expect(grid.snapTo(45, 20)).toEqual({ x: 50, y: 25 });
    // within ~1px of the center, checkCenter keeps the center
    expect(grid.snapTo(3, 2)).toEqual({ x: 0, y: 0 });
  });

  it("snaps to the hex corner when cornersLegal (HexGrid.snapToHexVertex)", () => {
    const grid = mk({ cornersLegal: true });
    expect(grid.snapTo(45, 20)).toEqual({ x: 66, y: 0 });
  });

  it("picks the closer of side/corner when both are legal", () => {
    const grid = mk({ edgesLegal: true, cornersLegal: true });
    expect(grid.snapTo(45, 20)).toEqual({ x: 50, y: 25 }); // side nearer
    expect(grid.snapTo(60, 5)).toEqual({ x: 66, y: 0 }); // corner nearer
  });

  it("honors snapTo=false unless forced, and centerOnly", () => {
    const grid = mk({ snapTo: false, edgesLegal: true });
    expect(grid.snapTo(45, 20)).toEqual({ x: 45, y: 20 });
    expect(grid.snapTo(45, 20, true)).toEqual({ x: 50, y: 25 });
    expect(grid.snapTo(45, 20, true, true)).toEqual({ x: 0, y: 0 });
  });

  it("range() snaps endpoints through snapTo like Map.snapTo does", () => {
    const plain = mk({});
    const edges = mk({ edgesLegal: true });
    // Without edgesLegal, (45,20) snaps to the center of hex (0,0): range 0.
    expect(plain.range(45, 20, 0, 0)).toBe(0);
    // With edgesLegal it snaps to the side (50,25), whose raw column rounds
    // into the next column: range 1 — what Java's range-via-Map.snapTo yields.
    expect(edges.range(45, 20, 0, 0)).toBe(1);
  });
});
