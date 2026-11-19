import { describe, expect, it } from "vitest";
import { BoardPickerModel, computeTileLayout, encodePickerCommand, findOrCreatePickerBoard, type PickerTile } from "../src/vmod/boardpicker";
import { parseBoardPickerCommand } from "../src/vmod/vsav";
import type { BoardDef, MapDef } from "../src/vmod/buildfile";

const board = (name: string, reversible = false): BoardDef => ({
  name,
  image: `${name}.png`,
  reversible,
});

const map = (boards: BoardDef[]): MapDef => ({
  name: "Main Map",
  buttonName: "Map",
  boards,
  drawPiles: [],
  layerOrder: [],
  losScale: 0,
});

describe("BoardPickerModel slot grid (BoardPicker addRow/addColumn index math)", () => {
  it("starts as a single empty 1x1 slot", () => {
    const m = new BoardPickerModel();
    expect(m.nx).toBe(1);
    expect(m.ny).toBe(1);
    expect(m.slots).toHaveLength(1);
    expect(m.tiles()).toEqual([]);
  });

  it("addColumn inserts one slot at the end of each row ((j+1)*nx-1)", () => {
    const m = new BoardPickerModel();
    m.addColumn(); // nx=2, insert at index 1
    expect(m.slots).toHaveLength(2);
    m.addRow(); // ny=2, append nx=2 slots
    expect(m.slots).toHaveLength(4);
    // Fill the bottom-right cell (index 3 = col 1, row 1).
    m.setSlot(3, { boardName: "B", reversed: false });
    m.setSlot(0, { boardName: "A", reversed: false });
    expect(m.tiles()).toEqual([
      { boardName: "A", x: 0, y: 0, reversed: false },
      { boardName: "B", x: 1, y: 1, reversed: false },
    ]);
  });

  it("addRow appends nx empty slots (new bottom row)", () => {
    const m = new BoardPickerModel();
    m.addColumn();
    m.setSlot(0, { boardName: "A", reversed: true });
    m.addRow();
    expect(m.tiles()).toEqual([{ boardName: "A", x: 0, y: 0, reversed: true }]);
    m.setSlot(m.slotIndex(1, 1), { boardName: "B", reversed: false });
    expect(m.slotIndex(1, 1)).toBe(3);
    expect(m.tiles()).toContainEqual({ boardName: "B", x: 1, y: 1, reversed: false });
  });

  it("clear resets to 1x1 empty; canAddColumn honors maxColumns", () => {
    const m = new BoardPickerModel();
    m.addColumn();
    m.addRow();
    m.clear();
    expect(m.nx).toBe(1);
    expect(m.ny).toBe(1);
    expect(m.slots).toHaveLength(1);
    expect(m.canAddColumn(0)).toBe(true);
    expect(m.canAddColumn(1)).toBe(false); // nx=1, max=1: 1 < 1 is false
    m.addColumn(); // nx=2
    expect(m.canAddColumn(2)).toBe(false);
    expect(m.canAddColumn(3)).toBe(true);
  });

  it("loadTiles grows the grid and places boards (BoardPicker.setBoards)", () => {
    const m = new BoardPickerModel();
    m.loadTiles([
      { boardName: "A", x: 0, y: 0, reversed: false },
      { boardName: "B", x: 2, y: 1, reversed: true },
    ]);
    expect(m.nx).toBe(3);
    expect(m.ny).toBe(2);
    expect(m.slots).toHaveLength(6);
    expect(m.slotIndex(2, 1)).toBe(5);
    expect(m.slots[5]).toEqual({ boardName: "B", reversed: true });
    expect(m.tiles()).toEqual([
      { boardName: "A", x: 0, y: 0, reversed: false },
      { boardName: "B", x: 2, y: 1, reversed: true },
    ]);
  });
});

describe("findOrCreatePickerBoard", () => {
  it("maps a single tile to the plain board", () => {
    const a = board("A");
    const m = map([a, board("B")]);
    const found = findOrCreatePickerBoard(m, [{ boardName: "A", x: 0, y: 0, reversed: false }]);
    expect(found).toBe(a);
  });

  it("composes a multi-tile board and is idempotent by layout id", () => {
    const m = map([board("A"), board("B", true)]);
    const tiles: PickerTile[] = [
      { boardName: "A", x: 0, y: 0, reversed: false },
      { boardName: "B", x: 1, y: 0, reversed: true },
    ];
    const composed = findOrCreatePickerBoard(m, tiles);
    expect(composed).not.toBeNull();
    expect(composed!.tiles).toEqual([
      { boardName: "A", image: "A.png", x: 0, y: 0 },
      { boardName: "B", image: "B.png", x: 1, y: 0, reversed: true },
    ]);
    const again = findOrCreatePickerBoard(m, tiles);
    expect(again).toBe(composed);
    expect(m.boards).toHaveLength(3);
  });

  it("returns null for empty or unknown selections", () => {
    const m = map([board("A")]);
    expect(findOrCreatePickerBoard(m, [])).toBeNull();
    expect(findOrCreatePickerBoard(m, [{ boardName: "ZZ", x: 0, y: 0, reversed: false }])).toBeNull();
  });
});

describe("encodePickerCommand round-trips through parseBoardPickerCommand", () => {
  it("encodes name[/rev] + x + y per tile (BoardPicker.encode)", () => {
    const tiles: PickerTile[] = [
      { boardName: "A", x: 0, y: 0, reversed: false },
      { boardName: "B", x: 1, y: 0, reversed: true },
      { boardName: "C", x: 0, y: 1, reversed: false },
    ];
    const cmd = encodePickerCommand("Main Map", tiles);
    expect(cmd.startsWith("Main MapBoardPicker\t")).toBe(true);
    const parsed = parseBoardPickerCommand(cmd);
    expect(parsed).not.toBeNull();
    expect(parsed!.mapName).toBe("Main Map");
    expect(parsed!.tiles).toEqual(tiles);
  });
});

describe("BoardPicker <setup> default command (pre-placed boards)", () => {
  it("a setup command composes the fixed layout without prompting", () => {
    const m = map([board("map A"), board("map B")]);
    const parsed = parseBoardPickerCommand("Main MapBoardPicker\tmap A\t0\t0\tmap B\t1\t0");
    expect(parsed).not.toBeNull();
    expect(parsed!.mapName).toBe("Main Map");
    const composed = findOrCreatePickerBoard(m, parsed!.tiles);
    expect(composed!.tiles).toEqual([
      { boardName: "map A", image: "map A.png", x: 0, y: 0 },
      { boardName: "map B", image: "map B.png", x: 1, y: 0 },
    ]);
  });
});

describe("computeTileLayout (Java Map.getLocation cumulative placement)", () => {
  it("joins differently-sized boards edge-to-edge (no max-cell seam)", () => {
    const layout = computeTileLayout([
      { x: 0, y: 0, w: 964, h: 1474 },
      { x: 1, y: 0, w: 1024, h: 1474 },
    ]);
    expect(layout[0]).toMatchObject({ px: 0, py: 0 });
    // map B starts right after map A's own width, not at max-cell 1024.
    expect(layout[1]).toMatchObject({ px: 964, py: 0 });
  });

  it("empty cells contribute 0 (Java boardWidths defaults to 0)", () => {
    const layout = computeTileLayout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 2, y: 0, w: 50, h: 100 }, // cell (1,0) empty
      { x: 0, y: 2, w: 100, h: 40 }, // cells (0,1) empty
    ]);
    expect(layout[1]).toMatchObject({ px: 100, py: 0 });
    expect(layout[2]).toMatchObject({ px: 0, py: 100 });
  });

  it("cumulates per-row widths and per-column heights independently", () => {
    const layout = computeTileLayout([
      { x: 0, y: 0, w: 100, h: 200 },
      { x: 1, y: 0, w: 300, h: 150 },
      { x: 0, y: 1, w: 80, h: 120 },
      { x: 1, y: 1, w: 60, h: 90 },
    ]);
    expect(layout[1]).toMatchObject({ px: 100, py: 0 }); // right of (0,0)
    expect(layout[2]).toMatchObject({ px: 0, py: 200 }); // below (0,0)
    expect(layout[3]).toMatchObject({ px: 80, py: 150 }); // dx sums widths of row 1 (board at (0,1)=80), dy sums heights of column 1 (board at (1,0)=150)
  });
});
