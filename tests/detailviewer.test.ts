import { describe, expect, it } from "vitest";
import { stackAtPosition, type GamePiece } from "../src/model/piece";

const piece = (x: number, y: number): GamePiece => ({ x, y }) as unknown as GamePiece;

describe("stackAtPosition (VASSAL Stack = same position)", () => {
  it("groups pieces sharing the exact position", () => {
    const pieces = [piece(100, 200), piece(100, 200), piece(300, 200), piece(100, 201)];
    const stack = stackAtPosition(pieces, 100, 200);
    expect(stack).toHaveLength(2);
    expect(stack.every((p) => p.x === 100 && p.y === 200)).toBe(true);
  });

  it("returns empty when nothing sits there", () => {
    expect(stackAtPosition([piece(1, 1)], 50, 50)).toEqual([]);
  });
});
