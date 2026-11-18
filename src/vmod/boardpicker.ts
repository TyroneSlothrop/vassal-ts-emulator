/**
 * Stock `BoardPicker` model: the "choose boards" grid dialog. Ported from
 * vassal-master/.../map/BoardPicker.java + boardPicker/BoardSlot.java.
 *
 * The picker keeps a GridLayout(ny, nx) of slots (initially 1x1). Slot index
 * i maps to grid cell (col = i % nx, row = floor(i / nx)). "Add row" appends
 * nx slots at the end; "Add column" inserts one slot at the end of every
 * existing row, i.e. at index (j + 1) * nx - 1 for row j — exactly the Java
 * insertion positions. On OK the occupied slots become boards at their
 * relative positions, encoded as a `<mapName>BoardPicker` save command.
 */

import { boardKey, type BoardDef, type MapDef } from "./buildfile";
import { SequenceEncoder } from "./sequence";

/** One cell of the picker grid: a chosen board (or empty) + flip state. */
export interface PickerSlot {
  boardName: string | null;
  reversed: boolean;
}

/** A selected board placed at a grid cell (Java Board.relativePosition). */
export interface PickerTile {
  boardName: string;
  x: number;
  y: number;
  reversed: boolean;
}

const emptySlot = (): PickerSlot => ({ boardName: null, reversed: false });

export class BoardPickerModel {
  nx = 1;
  ny = 1;
  slots: PickerSlot[] = [emptySlot()];

  /** Java BoardPicker.reset(): back to a single empty slot. */
  clear(): void {
    this.nx = 1;
    this.ny = 1;
    this.slots = [emptySlot()];
  }

  /** Java BoardPicker.addRow(): new bottom row of nx empty slots. */
  addRow(): void {
    this.ny++;
    for (let i = 0; i < this.nx; i++) this.slots.push(emptySlot());
  }

  /** Java BoardPicker.addColumn(): insert an empty slot at each row's end. */
  addColumn(): void {
    const nx = ++this.nx;
    for (let j = 0; j < this.ny; j++) {
      this.slots.splice((j + 1) * nx - 1, 0, emptySlot());
    }
  }

  canAddColumn(maxColumns: number): boolean {
    return maxColumns === 0 || this.nx < maxColumns;
  }

  slotIndex(col: number, row: number): number {
    return col + this.nx * row;
  }

  setSlot(index: number, slot: PickerSlot): void {
    if (index >= 0 && index < this.slots.length) this.slots[index] = slot;
  }

  /** Occupied slots as boards at their relative grid positions. */
  tiles(): PickerTile[] {
    const out: PickerTile[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s.boardName) continue;
      out.push({ boardName: s.boardName, x: i % this.nx, y: Math.floor(i / this.nx), reversed: s.reversed });
    }
    return out;
  }

  /** Java BoardPicker.setBoards(): grow the grid to fit, then place tiles. */
  loadTiles(tiles: PickerTile[]): void {
    this.clear();
    for (const t of tiles) {
      while (t.x > this.nx - 1) this.addColumn();
      while (t.y > this.ny - 1) this.addRow();
    }
    for (const t of tiles) {
      this.setSlot(this.slotIndex(t.x, t.y), { boardName: t.boardName, reversed: t.reversed });
    }
  }
}

/**
 * Find (or create) the composed BoardDef for a picker selection.
 * A single tile maps to the plain board, like Java map.setBoards(singleton).
 */
export function findOrCreatePickerBoard(map: MapDef, tiles: PickerTile[]): BoardDef | null {
  if (!tiles.length) return null;
  if (tiles.length === 1) {
    return map.boards.find((b) => b.name === tiles[0].boardName) ?? null;
  }
  const id = `picker:${tiles.map((t) => `${t.boardName}@${t.x},${t.y}${t.reversed ? "r" : ""}`).join("|")}`;
  const existing = map.boards.find((b) => b.id === id);
  if (existing) return existing;

  const resolved = tiles.flatMap((t) => {
    const src = map.boards.find((b) => b.name === t.boardName);
    if (!src) return [];
    return [{
      boardName: t.boardName,
      image: src.image || "",
      x: t.x,
      y: t.y,
      ...(t.reversed ? { reversed: true } : {}),
      ...(src.archiveFile ? { archiveFile: src.archiveFile } : {}),
    }];
  });
  if (!resolved.length) return null;

  const board: BoardDef = {
    id,
    name: tiles.map((t) => t.boardName).join(" + "),
    image: "",
    reversible: false,
    tiles: resolved,
  };
  map.boards.push(board);
  return board;
}

/**
 * Java BoardPicker.encode(SetBoards): `<mapId>BoardPicker\tname[/rev]\tx\ty…`.
 * parseBoardPickerCommand (vsav.ts) is the inverse.
 */
export function encodePickerCommand(mapName: string, tiles: PickerTile[]): string {
  const se = new SequenceEncoder("\t", `${mapName}BoardPicker`);
  for (const t of tiles) {
    const name = new SequenceEncoder("/", t.boardName);
    if (t.reversed) name.append("rev");
    se.append(name.getValue()).append(t.x).append(t.y);
  }
  return se.getValue();
}

/** Key used to look up a board def from a tile's board name. */
export function tileBoardKey(map: MapDef, boardName: string): string | null {
  const b = map.boards.find((x) => x.name === boardName);
  return b ? boardKey(b) : null;
}
