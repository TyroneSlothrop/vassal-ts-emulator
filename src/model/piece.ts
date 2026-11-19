import { strokesEqual, type KeyStroke } from "./keystroke";
import type { SlotCategory } from "../vmod/buildfile";
import { substituteProperties } from "../vmod/expression";
import { getGlobalProperty } from "./globals";

/**
 * A piece spawn requested by a PlaceMarker/Replace/PlaceDM trait. `spec` is
 * either an inline AddPiece definition (`+/id/type/state`) or a component path
 * ending in `PieceSlot:<entryName>`; the app resolves and places it.
 */
export interface PendingPlacement {
  spec: string;
  /** dx/dy offsets in world px (PlaceMarker offsets, +y = up in VASSAL). */
  dx: number;
  dy: number;
  /** True when this placement replaces the requesting piece (Replace trait). */
  replaceSelf: boolean;
}

/**
 * Where a Labeler anchors its label relative to the piece (Java
 * Labeler.getLabelPosition): position chars 't'/'b'/'c' + offsets, then
 * justification of the label box against that point.
 */
export interface LabelPlacement {
  vPos: string;
  vOff: number;
  hPos: string;
  hOff: number;
  vJust: string;
  hJust: string;
}

/** A menu/keyboard action contributed by a trait. */
export interface KeyCommand {
  /** Menu label; empty string means "no menu entry" (keyboard-only). */
  name: string;
  stroke: KeyStroke | null;
  /** Mutate piece state. Return true if something changed (triggers redraw). */
  perform: () => boolean;
  /**
   * SubMenu trait (KeyCommandSubMenu): names of commands to nest under this
   * entry. The context menu moves matching commands inside (MenuDisplayer).
   */
  subCommands?: string[];
}

/** An image layered on top of the base sprite (Embellishment level, etc.). */
export interface LayerImage {
  name: string;
  xOff: number;
  yOff: number;
  scale: number;
  /**
   * Embellishment drawUnderneathWhenSelected: the layer renders but does NOT
   * extend the piece's hit/selection shape (Java Embellishment.getShape).
   * Big vision-arc / movement-arrow overlays use this.
   */
  underneath?: boolean;
}

export interface MovementTrailView {
  visible: boolean;
  points: Array<{ x: number; y: number }>;
  radius: number;
  fill: string;
  stroke: string;
  lineWidth: number;
  alphaSelected: number;
  alphaUnselected: number;
}

export interface MovementMarkView {
  image: string;
  xOff: number;
  yOff: number;
}

/**
 * A trait (VASSAL "Decorator"). Traits are queried by GamePiece via optional
 * capability methods; a flattened renderer reads base image + rotation +
 * layers + label rather than doing full decorator-recursion (sufficient for
 * the trait set we support; see CLAUDE.md).
 */
export interface Trait {
  readonly id: string;
  setState(s: string): void;
  getState(): string;
  keyCommands(piece: GamePiece): KeyCommand[];

  getProperty?(key: string): string | null;
  /** BasicPiece: the base sprite image name. */
  baseImageName?(): string | null;
  /** FreeRotator: current rotation in degrees (clockwise-positive). */
  rotationDegrees?(): number;
  /** Embellishment/etc: images to draw on top of the (rotated) base. */
  layerImages?(): LayerImage[];
  /** Labeler: text to draw. */
  labelText?(): string | null;
  /** Labeler: raw markup when the label is Swing-HTML. */
  htmlLabel?(): string | null;
  /** Labeler: where the label anchors relative to the piece. */
  labelPlacement?(): LabelPlacement | null;
  /** Immobilized: piece ignores the map grid when moved ('g' option). */
  ignoresGrid?(): boolean;
  /** Immobilized(neverMove): trait pins the piece in place. */
  immobile?(): boolean;
  /** Mark When Moved / Movement Trail support. */
  moved?(): boolean | null;
  setMoved?(piece: GamePiece, moved: boolean): void;
  recordMovePoint?(piece: GamePiece): void;
  clearMoveTrail?(piece: GamePiece): void;
  movementTrail?(): MovementTrailView | null;
  movementMark?(): MovementMarkView | null;
}

let INSTANCE_SEQ = 1;

/**
 * A live game piece instance on a map: an ordered trait chain (outer→inner,
 * BasicPiece last) plus position and identity.
 */
export class GamePiece {
  readonly instanceId: string = `p${INSTANCE_SEQ++}`;
  gpid = "";
  mapId = "";
  /** Original `+/id/type/state` definition, kept for cloning/serialization. */
  sourceDef = "";
  /** Palette provenance category for interaction focus/z-order. */
  paletteCategory: SlotCategory | null = null;
  x = 0;
  y = 0;
  /** User lock: prevents dragging even if the trait chain allows it. */
  userLocked = false;
  /** Set by Delete/Clone traits; the board consumes these after a command. */
  pendingDelete = false;
  pendingClone = false;
  /** Spawns requested by PlaceMarker-family traits; app consumes after a command. */
  pendingPlacements: PendingPlacement[] = [];
  /** Report lines (already property-substituted except $location$) for the chatter. */
  pendingReports: string[] = [];
  private dispatchDepth = 0;
  /** Movement trail anchor + status marker for local play. */
  trailStart: { x: number; y: number } | null = null;
  moved = false;

  constructor(public readonly traits: Trait[]) {}

  /** Scan traits outer→inner for a property; falls back to base name/position. */
  getProperty(key: string): string | null {
    for (const t of this.traits) {
      if (t.getProperty) {
        const v = t.getProperty(key);
        if (v != null) return v;
      }
    }
    if (key === "Moved") return this.movedStatus() ? "true" : "false";
    if (key === "BasicName" || key === "PieceName" || key === "pieceName") return this.name();
    // Module GlobalProperties resolve after every trait (static values only).
    return getGlobalProperty(key);
  }

  name(): string {
    for (let i = this.traits.length - 1; i >= 0; i--) {
      const t = this.traits[i];
      if (t.baseImageName) return t.getProperty?.("BasicName") ?? "";
    }
    return "";
  }

  baseImageName(): string | null {
    for (let i = this.traits.length - 1; i >= 0; i--) {
      const n = this.traits[i].baseImageName?.();
      if (n) return n;
    }
    return null;
  }

  rotationDegrees(): number {
    // A piece may carry multiple rotators (e.g. a free fine-rotate plus a
    // facing stepper); VASSAL nests them, so the net rotation is their sum.
    let sum = 0;
    for (const t of this.traits) {
      if (t.rotationDegrees) sum += t.rotationDegrees();
    }
    return sum;
  }

  activeLayers(): LayerImage[] {
    // Draw order is inner→outer (VASSAL decorators draw the inner piece first,
    // then layer on top). `traits` is stored outer→inner, so iterate reversed:
    // the innermost layer (typically the model base disc) ends up at the bottom,
    // with the body, weapons and effect overlays stacked above it.
    const out: LayerImage[] = [];
    for (let i = this.traits.length - 1; i >= 0; i--) {
      const t = this.traits[i];
      if (t.layerImages) out.push(...t.layerImages());
    }
    return out;
  }

  labels(): string[] {
    const out: string[] = [];
    for (const t of this.traits) {
      const s = t.labelText?.();
      if (s) out.push(this.substitute(s));
    }
    return out;
  }

  /** Label text is a FormattedString: $property$ refs resolve on the piece. */
  private substitute(text: string): string {
    if (!text.includes("$")) return text;
    return substituteProperties(text, (key) => this.getProperty(key));
  }

  /** Per-label view: raw HTML when Swing-HTML, plus the plain-text fallback. */
  labelViews(): Array<{ html: string | null; text: string | null; placement: LabelPlacement | null }> {
    const out: Array<{ html: string | null; text: string | null; placement: LabelPlacement | null }> = [];
    for (const t of this.traits) {
      if (!t.labelText && !t.htmlLabel) continue;
      const html = t.htmlLabel?.();
      const text = t.labelText?.();
      if (html || text) {
        out.push({
          html: html ? this.substitute(html) : null,
          text: text ? this.substitute(text) : null,
          placement: t.labelPlacement?.() ?? null,
        });
      }
    }
    return out;
  }

  /** True when any label is Swing-HTML (scenario cards / rule aids). */
  hasHtmlLabel(): boolean {
    return this.traits.some((t) => t.htmlLabel?.());
  }

  /** Immobilized 'g': the piece never snaps to the grid. */
  ignoresGrid(): boolean {
    return this.traits.some((t) => t.ignoresGrid?.());
  }

  /** The `Layer` property value (drives z-order via LayeredPieceCollection). */
  layerName(): string | null {
    return this.getProperty("Layer");
  }

  isImmobile(): boolean {
    if (this.userLocked) return true;
    return this.traits.some((t) => t.immobile?.());
  }

  /**
   * Fire a keystroke at the whole piece: every trait command bound to that
   * stroke performs (Java Decorator.keyEvent semantics — each trait sees the
   * stroke). Used by TriggerAction to fire its action keys. Depth-guarded so
   * mutually-triggering pieces can't loop forever.
   */
  dispatch(stroke: KeyStroke | null): boolean {
    if (!stroke || this.dispatchDepth > 10) return false;
    this.dispatchDepth++;
    try {
      let changed = false;
      for (const cmd of this.keyCommands()) {
        if (strokesEqual(cmd.stroke, stroke)) changed = cmd.perform() || changed;
      }
      return changed;
    } finally {
      this.dispatchDepth--;
    }
  }

  keyCommands(): KeyCommand[] {
    const out: KeyCommand[] = [];
    for (const t of this.traits) out.push(...t.keyCommands(this));
    const seen = new Set<string>();
    return out.filter((cmd) => {
      // Keyboard-only commands (no menu name) never dedupe: distinct traits
      // legitimately share a stroke and each must fire (keyEvent chain).
      if (!cmd.name) return true;
      const key = `${cmd.name}\n${strokeKey(cmd.stroke)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  hasMovedTrait(): boolean {
    return this.traits.some((t) => t.moved || t.setMoved || t.movementTrail);
  }

  movedStatus(): boolean {
    for (const t of this.traits) {
      const v = t.moved?.();
      if (v != null) return v;
    }
    return this.moved;
  }

  setMovedStatus(moved: boolean): void {
    let handled = false;
    for (const t of this.traits) {
      if (t.setMoved) {
        t.setMoved(this, moved);
        handled = true;
      }
    }
    if (!handled) {
      this.moved = moved;
      if (!this.trailStart) this.trailStart = { x: this.x, y: this.y };
      if (!moved) this.trailStart = { x: this.x, y: this.y };
    } else {
      this.moved = this.movedStatus();
    }
  }

  recordMovePoint(): void {
    for (const t of this.traits) t.recordMovePoint?.(this);
  }

  clearMoveTrail(): void {
    for (const t of this.traits) t.clearMoveTrail?.(this);
    this.trailStart = { x: this.x, y: this.y };
  }

  movementTrails(): MovementTrailView[] {
    return this.traits.map((t) => t.movementTrail?.() ?? null).filter((v): v is MovementTrailView => v != null);
  }

  movementMarks(): MovementMarkView[] {
    return this.traits.map((t) => t.movementMark?.() ?? null).filter((v): v is MovementMarkView => v != null);
  }
}

function strokeKey(stroke: KeyStroke | null): string {
  if (!stroke) return "";
  return `${stroke.code}:${stroke.ctrl ? 1 : 0}:${stroke.shift ? 1 : 0}:${stroke.alt ? 1 : 0}:${stroke.meta ? 1 : 0}:${stroke.name ?? ""}`;
}

/** Pieces sharing the same (snapped) position — a VASSAL Stack. */
export function stackAtPosition(pieces: GamePiece[], x: number, y: number): GamePiece[] {
  return pieces.filter((p) => p.x === x && p.y === y);
}
