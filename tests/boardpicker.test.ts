import { describe, expect, it } from "vitest";
import { BoardPickerModel, encodePickerCommand, findOrCreatePickerBoard, type PickerTile } from "../src/vmod/boardpicker";
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
