import type { GamePiece } from "../model/piece";
import { boardKey, cssColor, type BoardDef, type LosThreadDef, type SlotCategory, type StackMetricsDef } from "../vmod/buildfile";
import type { HexGridModel } from "../vmod/hexgrid";
import type { ImageStore } from "./images";
import { drawPiece, drawSelection, hitTestPiece, pieceHalfExtent, segmentIntersectsPiece } from "./render";

/**
 * LayeredPieceCollection layer names are free-form module data, so pieces are
 * bucketed into interaction categories by keyword, never by per-module lists.
 * Palette provenance (paletteCategory) always wins over these fallbacks.
 */
const AID_LAYER_RE = /deploy|objective|tray|template|zone|area|aura|overlay|aid/i;
const TERRAIN_LAYER_RE = /terrain|hill|road|street|river|bridge|tree|forest|wood|building|wall|obstru|rubble|crater|pod|object/i;
/** Road/water-like terrain is flat: it never blocks line of sight. */
const LOS_TRANSPARENT_RE = /road|street|path|river|bridge|ford|runway/i;

export type InteractionLayer = "models" | "terrain" | "aids" | "map" | "all";
export type PointerTool = "select" | "pan";

interface Camera {
  tx: number; // css-px translation
  ty: number;
  scale: number;
}

export interface MapCallbacks {
  onSelect: (piece: GamePiece | null, count: number) => void;
  onContextMenu: (piece: GamePiece, clientX: number, clientY: number) => void;
  /** Drag started on a deck pile: draw the top piece at (x,y) and return it. */
  onDeckPickUp?: (deckId: string, x: number, y: number) => GamePiece | null;
  /** Tap/right-click on a deck pile: show its Draw/Shuffle menu. */
  onDeckMenu?: (deckId: string, clientX: number, clientY: number) => void;
  onChange: () => void;
  /** Fired after every redraw — camera or content changed (overview repaints). */
  onViewChanged?: () => void;
  /** A drag ended with the piece in a new grid location (hex move report). */
  onMoved?: (piece: GamePiece, from: string, to: string) => void;
}

/** A DrawPile rendered on the map: a pile of pieces players draw from. */
export interface DeckView {
  id: string;
  /** Center position + footprint in world px (Java Deck position semantics). */
  x: number;
  y: number;
  w: number;
  h: number;
  count: number;
  name: string;
  /** CSS color for the pile back/outline, or null for the default. */
  color: string | null;
  faceDown: boolean;
  /** Composed top piece for face-up piles (null when face down/empty). */
  topPiece: GamePiece | null;
}

/** Dot colors for pieces in the overview when too small to draw as sprites. */
const OVERVIEW_DOT_COLORS: Record<SlotCategory, string> = {
  models: "#ffcf33",
  terrain: "#8a9a6a",
  aids: "#6a8a9a",
};

/**
 * One VASSAL Map window: a canvas with a camera, a background board image, and
 * a z-ordered set of pieces. Handles pan/zoom/pinch (touch + mouse), piece
 * dragging, tap-to-select and long-press / right-click context menu. All the
 * iOS touch handling lives here via Pointer Events.
 */
export class MapWindow {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cam: Camera = { tx: 0, ty: 0, scale: 1 };
  private boardImage: string | null = null;
  /** Cached grid-line path for the current board (rebuilt on board change). */
  private gridPath: Path2D | null = null;
  private gridPathKey: string | null = null;
  private boardDefs = new Map<string, BoardDef>();
  private pieces: GamePiece[] = [];
  private decks: DeckView[] = [];
  private layerOrder: string[] = [];
  private layerRank = new Map<string, number>();
  private selected = new Set<GamePiece>();
  private primarySelected: GamePiece | null = null;
  private interactionLayer: InteractionLayer = "models";
  private pointerTool: PointerTool = "select";
  private pieceScale = 1;
  private sortedPieces: GamePiece[] | null = null;

  private losScale = 0;
  private losThread: LosThreadDef | null = null;
  private stackMetrics: StackMetricsDef | null = null;
  /** Map edge buffer: boards + board-relative grids anchor here. */
  private boardOrigin = { x: 0, y: 0 };
  private hexGrid: HexGridModel | null = null;
  private dragStartLocs = new Map<GamePiece, string>();
  private measureMode = false;
  private measure: { sx: number; sy: number; ex: number; ey: number } | null = null;

  private pointers = new Map<number, { x: number; y: number }>();
  private mode: "idle" | "pan" | "drag" | "pinch" | "measure" | "marquee" | "deckPick" = "idle";
  private pendingDeck: DeckView | null = null;
  private dragPieces: GamePiece[] = [];
  private marquee: { sx: number; sy: number; ex: number; ey: number } | null = null;
  private lastPinchDist = 0;
  private downAt = { x: 0, y: 0 };
  private spacePan = false;
  private longPressTimer: number | null = null;
  private redrawQueued = false;
  private resizeObserver: ResizeObserver | null = null;

  constructor(
    parent: HTMLElement,
    private readonly images: ImageStore,
    private readonly cb: MapCallbacks,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "map-canvas";
    this.canvas.style.touchAction = "none"; // we handle all gestures
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.attach();
    this.observeSize(parent);
    this.resize();
  }

  setLayerOrder(order: string[]): void {
    this.layerOrder = order;
    this.layerRank = new Map(order.map((name, i) => [name, i]));
    this.invalidateSort();
  }

  setLosScale(scale: number): void {
    this.losScale = scale;
  }

  /** Adopt the module's LOS_Thread declaration (color, snapping, rounding). */
  setLosThread(def: LosThreadDef | null): void {
    this.losThread = def;
    this.losScale = def?.scale ?? 0;
  }

  /** Adopt the map's StackMetrics (visual cascade for co-located pieces). */
  setStackMetrics(def: StackMetricsDef | null): void {
    this.stackMetrics = def;
    this.requestDraw();
  }

  /** Map edge buffer (Map.setBoardBoundaries board translate). */
  setBoardOrigin(x: number, y: number): void {
    this.boardOrigin = { x, y };
    this.requestDraw();
  }

  /** World position of a named grid location (board-relative grid + origin). */
  hexCenter(hex: string): { x: number; y: number } | null {
    if (!this.hexGrid) return null;
    const p = this.hexGrid.getLocation(hex);
    return { x: p.x + this.boardOrigin.x, y: p.y + this.boardOrigin.y };
  }

  /**
   * Visual cascade offsets: pieces sharing an exact position draw shifted
   * up-right per index (StackMetrics unexpanded separation), so stacks read
   * as stacks. Logical positions/hit-testing are untouched (cycleHit
   * disambiguates overlaps).
   */
  private stackOffsets(pieces: GamePiece[]): Map<GamePiece, { ox: number; oy: number }> {
    const out = new Map<GamePiece, { ox: number; oy: number }>();
    if (this.stackMetrics?.disabled) return out;
    const sepX = this.stackMetrics?.unexSepX ?? 2;
    const sepY = this.stackMetrics?.unexSepY ?? 4;
    const counts = new Map<string, number>();
    for (const p of pieces) {
      const key = `${Math.round(p.x)}:${Math.round(p.y)}`;
      const i = counts.get(key) ?? 0;
      counts.set(key, i + 1);
      if (i > 0) out.set(p, { ox: i * sepX, oy: -i * sepY });
    }
    return out;
  }

  /** Hex grid of the current board; enables snapping + hex locations. */
  setGrid(grid: HexGridModel | null): void {
    this.hexGrid = grid;
    this.requestDraw();
  }

  grid(): HexGridModel | null {
    return this.hexGrid;
  }

  /** Grid location name of a piece ("F5"), or null without a grid. */
  locationOf(piece: GamePiece): string | null {
    if (!this.hexGrid) return null;
    return this.hexGrid.locationName(piece.x - this.boardOrigin.x, piece.y - this.boardOrigin.y);
  }

  /** Snap a world point to the grid (Map.snapTo → HexGrid.snapTo); identity without a grid. */
  snap(x: number, y: number): { x: number; y: number } {
    if (!this.hexGrid) return { x, y };
    const s = this.hexGrid.snapTo(x - this.boardOrigin.x, y - this.boardOrigin.y);
    return { x: s.x + this.boardOrigin.x, y: s.y + this.boardOrigin.y };
  }

  setInteractionLayer(layer: InteractionLayer): void {
    this.interactionLayer = layer;
    const keep = this.getSelectedPieces().filter((p) => this.matchesInteractionLayer(p));
    if (keep.length !== this.selected.size) this.selectMany(keep);
    this.requestDraw();
  }

  getInteractionLayer(): InteractionLayer {
    return this.interactionLayer;
  }

  setPointerTool(tool: PointerTool): void {
    this.pointerTool = tool;
  }

  getPointerTool(): PointerTool {
    return this.pointerTool;
  }

  setPieceScale(scale: number): void {
    this.pieceScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
    this.requestDraw();
  }

  setBoardDefs(boards: BoardDef[]): void {
    this.boardDefs = new Map(boards.map((board) => [boardKey(board), board]));
  }

  /** Replace the deck piles drawn on this map. */
  setDecks(decks: DeckView[]): void {
    this.decks = decks;
    this.requestDraw();
  }

  /** Topmost deck whose footprint contains the world point, if any. */
  private deckAt(x: number, y: number): DeckView | null {
    for (let i = this.decks.length - 1; i >= 0; i--) {
      const d = this.decks[i];
      if (Math.abs(x - d.x) <= d.w / 2 && Math.abs(y - d.y) <= d.h / 2) return d;
    }
    return null;
  }

  /** Toggle the range/LOS measuring tool. Clears any existing thread when off. */
  setMeasureMode(on: boolean): void {
    this.measureMode = on;
    if (!on) this.measure = null;
    this.requestDraw();
  }

  isMeasuring(): boolean {
    return this.measureMode;
  }

  /** Current measurement result (for UI/tests), or null if no thread drawn. */
  measureInfo(): { distance: number; unit: string; blocked: boolean } | null {
    if (!this.measure) return null;
    const m = this.measure;
    const len = Math.hypot(m.ex - m.sx, m.ey - m.sy);
    const blocked = this.losBlocked(m.sx, m.sy, m.ex, m.ey);
    if (this.hexGrid) {
      const { x: ox, y: oy } = this.boardOrigin;
      return { distance: this.hexGrid.range(m.sx - ox, m.sy - oy, m.ex - ox, m.ey - oy), unit: "hexes", blocked };
    }
    return this.losScale > 0
      ? { distance: this.scaledRange(len), unit: "in", blocked }
      : { distance: Math.round(len), unit: "px", blocked };
  }

  /** Pixel length -> range units using the thread's declared rounding. */
  private scaledRange(len: number): number {
    const v = len / this.losScale;
    if (this.losThread?.round === "down") return Math.floor(v);
    if (this.losThread?.round === "nearest") return Math.round(v);
    return Math.ceil(v);
  }

  /** Snap a thread endpoint to the grid when the module declared snapping. */
  private snapThreadPoint(x: number, y: number, isStart: boolean): { x: number; y: number } {
    const snap = isStart ? this.losThread?.snapStart : this.losThread?.snapEnd;
    if (snap && this.hexGrid) return this.snap(x, y);
    return { x, y };
  }

  setMeasure(start: { x: number; y: number }, end: { x: number; y: number }): void {
    this.measureMode = true;
    const s = this.snapThreadPoint(start.x, start.y, true);
    const e = this.snapThreadPoint(end.x, end.y, false);
    this.measure = { sx: s.x, sy: s.y, ex: e.x, ey: e.y };
    this.requestDraw();
  }

  setBoard(imageName: string | null): void {
    this.boardImage = imageName;
    if (imageName) this.fitBoard();
    this.requestDraw();
  }

  setPieces(pieces: GamePiece[]): void {
    this.pieces = pieces;
    this.invalidateSort();
    const keep = this.getSelectedPieces().filter((p) => this.pieces.includes(p));
    if (keep.length !== this.selected.size) this.selectMany(keep);
    this.requestDraw();
  }

  addPiece(piece: GamePiece, select = true): void {
    const snapped = piece.ignoresGrid() ? { x: piece.x, y: piece.y } : this.snap(piece.x, piece.y);
    piece.x = snapped.x;
    piece.y = snapped.y;
    piece.trailStart = { x: piece.x, y: piece.y };
    piece.moved = false;
    this.pieces.push(piece);
    this.invalidateSort();
    // Trait-spawned markers (PlaceMarker/PlaceDM) must not steal the selection
    // from the piece whose command spawned them (Java keeps the KeyBuffer).
    if (select) this.select(piece);
    this.requestDraw();
  }

  removePiece(piece: GamePiece): void {
    const idx = this.pieces.indexOf(piece);
    if (idx >= 0) {
      this.pieces.splice(idx, 1);
      this.invalidateSort();
    }
    if (this.selected.has(piece)) {
      this.selected.delete(piece);
      if (this.primarySelected === piece) this.primarySelected = this.getSelectedPieces()[0] ?? null;
      this.emitSelection();
    }
    this.requestDraw();
  }

  getSelected(): GamePiece | null {
    return this.primarySelected && this.selected.has(this.primarySelected) ? this.primarySelected : this.getSelectedPieces()[0] ?? null;
  }

  getSelectedPieces(): GamePiece[] {
    return this.pieces.filter((p) => this.selected.has(p));
  }

  pieceCount(): number {
    return this.pieces.length;
  }

  piecesSnapshot(): Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    layer: string | null;
    locked: boolean;
    layers: string[];
    moved: boolean;
    trailStart: { x: number; y: number } | null;
    category: ReturnType<typeof classifyPiece>;
  }> {
    return this.pieces.map((p) => ({
      id: p.instanceId,
      name: p.name(),
      x: p.x,
      y: p.y,
      layer: p.layerName(),
      locked: p.isImmobile(),
      layers: p.activeLayers().map((l) => l.name),
      moved: p.movedStatus(),
      trailStart: p.trailStart ? { ...p.trailStart } : null,
      category: classifyPiece(p),
    }));
  }

  findPiece(name: string): GamePiece | null {
    return this.pieces.find((p) => p.name() === name) ?? null;
  }

  setPiecePosition(piece: GamePiece, x: number, y: number): void {
    const from = this.locationOf(piece);
    const snapped = this.snap(x, y);
    piece.x = snapped.x;
    piece.y = snapped.y;
    const to = this.locationOf(piece);
    if (from && to && from !== to) this.cb.onMoved?.(piece, from, to);
    this.updateMoved(piece);
    this.select(piece);
    this.cb.onChange();
    this.requestDraw();
  }

  markMoved(piece: GamePiece): void {
    if (classifyPiece(piece) !== "models") {
      piece.trailStart = { x: piece.x, y: piece.y };
      piece.setMovedStatus(false);
      piece.clearMoveTrail();
      this.requestDraw();
      return;
    }
    if (!piece.trailStart) piece.trailStart = { x: piece.x, y: piece.y };
    piece.setMovedStatus(true);
    this.requestDraw();
  }

  clearMoved(piece?: GamePiece): void {
    const targets = piece ? [piece] : this.pieces;
    for (const p of targets) {
      p.trailStart = { x: p.x, y: p.y };
      p.setMovedStatus(false);
      p.clearMoveTrail();
    }
    this.requestDraw();
  }

  /** Client (page) coordinates of a piece's center — for scripted clicks. */
  clientPosOf(piece: GamePiece): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: r.left + piece.x * this.cam.scale + this.cam.tx,
      y: r.top + piece.y * this.cam.scale + this.cam.ty,
    };
  }

  select(piece: GamePiece | null): void {
    this.selected.clear();
    if (piece) {
      this.selected.add(piece);
      this.primarySelected = piece;
    } else {
      this.primarySelected = null;
    }
    this.emitSelection();
    this.requestDraw();
  }

  selectMany(pieces: GamePiece[]): void {
    this.selected.clear();
    for (const p of pieces) {
      if (this.pieces.includes(p)) this.selected.add(p);
    }
    this.primarySelected = pieces.find((p) => this.selected.has(p)) ?? null;
    this.emitSelection();
    this.requestDraw();
  }

  private toggleSelected(piece: GamePiece): void {
    if (this.selected.has(piece)) {
      this.selected.delete(piece);
      if (this.primarySelected === piece) this.primarySelected = this.getSelectedPieces()[0] ?? null;
    } else {
      this.selected.add(piece);
      this.primarySelected = piece;
    }
    this.emitSelection();
    this.requestDraw();
  }

  private emitSelection(): void {
    this.cb.onSelect(this.getSelected(), this.selected.size);
  }

  /** Zoom by a factor around the current view center (toolbar buttons). */
  zoomBy(factor: number): void {
    const r = this.canvas.getBoundingClientRect();
    this.zoomAt(r.width / 2, r.height / 2, factor);
  }

  /** Center of the current view in world coords (used for palette drops). */
  viewCenterWorld(): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return this.screenToWorld(r.width / 2, r.height / 2);
  }

  /** Convert client (page) coordinates to world coordinates (drag-drop). */
  clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return this.screenToWorld(clientX - r.left, clientY - r.top);
  }

  /** The world-space rectangle currently visible in the canvas. */
  worldViewport(): { x: number; y: number; w: number; h: number } {
    const r = this.canvas.getBoundingClientRect();
    const min = this.screenToWorld(0, 0);
    const max = this.screenToWorld(r.width, r.height);
    return { x: min.x, y: min.y, w: max.x - min.x, h: max.y - min.y };
  }

  /** Pan so the given world point sits at the canvas center (overview drag). */
  centerOn(wx: number, wy: number): void {
    const r = this.canvas.getBoundingClientRect();
    this.cam.tx = r.width / 2 - wx * this.cam.scale;
    this.cam.ty = r.height / 2 - wy * this.cam.scale;
    this.requestDraw();
  }

  /** Absolute zoom level, anchored at the view center (Zoomer levels). */
  zoomTo(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.zoomBy(scale / this.cam.scale);
  }

  zoomScale(): number {
    return this.cam.scale;
  }

  /** World size of the current board (single image or composed tiles). */
  boardSize(): { width: number; height: number } | null {
    const size = this.boardWorldSize();
    return size ? { width: size.width, height: size.height } : null;
  }

  /**
   * Draw the whole board + pieces scaled to fit maxW×maxH into a foreign
   * context (the overview window). The caller owns DPR scaling and clearing.
   * Pieces render as sprites when legible, else as category-colored dots.
   */
  renderOverview(
    ctx: CanvasRenderingContext2D,
    maxW: number,
    maxH: number,
  ): { scale: number; width: number; height: number } | null {
    const board = this.boardWorldSize();
    if (!board || board.width <= 0 || board.height <= 0) return null;
    const size = {
      width: board.width + this.boardOrigin.x * 2,
      height: board.height + this.boardOrigin.y * 2,
    };
    const scale = Math.min(maxW / size.width, maxH / size.height);
    ctx.save();
    ctx.scale(scale, scale);
    this.drawBoard(ctx);
    if (scale * this.pieceScale >= 0.08) {
      for (const p of this.zSorted()) drawPiece(ctx, p, this.images, { pieceScale: this.pieceScale });
    } else {
      for (const p of this.zSorted()) {
        ctx.fillStyle = OVERVIEW_DOT_COLORS[classifyPiece(p)];
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3 / scale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
    return { scale, width: size.width * scale, height: size.height * scale };
  }

  requestDraw(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      this.draw();
    });
  }

  // ---- rendering -----------------------------------------------------------

  private draw(): void {
    const dpr = canvasPixelRatio();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#2b2f36";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.setTransform(this.cam.scale * dpr, 0, 0, this.cam.scale * dpr, this.cam.tx * dpr, this.cam.ty * dpr);

    this.drawBoard(ctx);
    this.drawGridOverlay(ctx);
    this.drawDecks(ctx);

    this.drawMovementTrails(ctx);
    const visible = this.visiblePieces();
    const offsets = this.stackOffsets(visible);
    const redraw = () => this.requestDraw();
    for (const p of visible) {
      const off = offsets.get(p);
      drawPiece(ctx, p, this.images, { pieceScale: this.pieceScale, ox: off?.ox, oy: off?.oy, redraw });
    }
    for (const p of this.getSelectedPieces()) {
      this.drawHexHighlight(ctx, p);
      const off = offsets.get(p);
      drawSelection(ctx, p, this.images, { pieceScale: this.pieceScale, ox: off?.ox, oy: off?.oy });
    }
    if (this.marquee) this.drawMarquee(ctx);
    if (this.measure) this.drawMeasure(ctx, dpr);
    this.cb.onViewChanged?.();
  }

  /** Outline the selected piece's hex (hex-grid selection cue). */
  private drawHexHighlight(ctx: CanvasRenderingContext2D, piece: GamePiece): void {
    if (!this.hexGrid) return;
    const { x: ox, y: oy } = this.boardOrigin;
    const c = this.hexGrid.snapToHex(piece.x - ox, piece.y - oy);
    const poly = this.hexGrid.hexPolygon(c.x, c.y).map((p) => ({ x: p.x + ox, y: p.y + oy }));
    ctx.save();
    ctx.strokeStyle = "rgba(255, 207, 51, 0.9)";
    ctx.lineWidth = 2 / this.cam.scale;
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  private drawMarquee(ctx: CanvasRenderingContext2D): void {
    const m = this.marquee;
    if (!m) return;
    const x = Math.min(m.sx, m.ex);
    const y = Math.min(m.sy, m.ey);
    const w = Math.abs(m.ex - m.sx);
    const h = Math.abs(m.ey - m.sy);
    ctx.save();
    ctx.fillStyle = "rgba(255, 207, 51, 0.12)";
    ctx.strokeStyle = "#ffcf33";
    ctx.lineWidth = 1 / this.cam.scale;
    ctx.setLineDash([5 / this.cam.scale, 3 / this.cam.scale]);
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }

  /** Deck piles: face-up top piece or a colored back, plus a count badge. */
  private drawDecks(ctx: CanvasRenderingContext2D): void {
    for (const d of this.decks) {
      const left = d.x - d.w / 2;
      const top = d.y - d.h / 2;
      ctx.save();
      if (d.count === 0) {
        // Empty pile: dashed outline so players still see the slot.
        ctx.strokeStyle = d.color ?? "rgba(255,255,255,0.35)";
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeRect(left, top, d.w, d.h);
      } else if (d.topPiece && !d.faceDown) {
        d.topPiece.x = d.x;
        d.topPiece.y = d.y;
        drawPiece(ctx, d.topPiece, this.images, { pieceScale: this.pieceScale });
      } else {
        // Face-down (or art still loading): a stacked colored back.
        const back = d.color ?? "rgb(58,74,95)";
        const depth = Math.min(3, d.count) - 1;
        for (let i = depth; i >= 0; i--) {
          ctx.fillStyle = i === 0 ? back : "rgba(0,0,0,0.35)";
          ctx.strokeStyle = "rgba(255,255,255,0.4)";
          ctx.lineWidth = 1;
          ctx.fillRect(left + i * 2, top + i * 2, d.w, d.h);
          if (i === 0) ctx.strokeRect(left, top, d.w, d.h);
        }
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(left, top + d.h * 0.36, d.w, d.h * 0.28);
        ctx.fillStyle = "#fff";
        ctx.font = `${Math.max(9, d.h * 0.16)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(fitText(ctx, d.name, d.w - 6), d.x, d.y);
      }
      if (d.count > 0) {
        // Count badge, bottom-right of the pile.
        const r = Math.max(8, d.h * 0.14);
        ctx.beginPath();
        ctx.arc(left + d.w - 2, top + d.h - 2, r, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(20,22,26,0.9)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.stroke();
        ctx.fillStyle = "#ffe14d";
        ctx.font = `bold ${r}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(d.count), left + d.w - 2, top + d.h - 2);
      }
      ctx.restore();
    }
  }

  /** Draw the range/LOS thread (world space) plus a distance/blocked label. */
  private drawMeasure(ctx: CanvasRenderingContext2D, dpr: number): void {
    const m = this.measure!;
    const blocked = this.losBlocked(m.sx, m.sy, m.ex, m.ey);
    const color = blocked ? "#ff5555" : this.losThread?.color ?? "#ffe14d";

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 / this.cam.scale;
    ctx.beginPath();
    ctx.moveTo(m.sx, m.sy);
    ctx.lineTo(m.ex, m.ey);
    ctx.stroke();
    for (const [px, py] of [[m.sx, m.sy], [m.ex, m.ey]] as const) {
      ctx.beginPath();
      ctx.arc(px, py, 4 / this.cam.scale, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.restore();

    // Label in screen space so it stays legible at any zoom.
    const lenWorld = Math.hypot(m.ex - m.sx, m.ey - m.sy);
    const { x: mox, y: moy } = this.boardOrigin;
    const label = this.hexGrid
      ? `Range: ${this.hexGrid.range(m.sx - mox, m.sy - moy, m.ex - mox, m.ey - moy)}${blocked ? " • blocked" : ""}`
      : this.losScale > 0
        ? `${this.scaledRange(lenWorld)}"${blocked ? " • blocked" : ""}`
        : `${Math.round(lenWorld)}px${blocked ? " • blocked" : ""}`;
    const midScreenX = ((m.sx + m.ex) / 2) * this.cam.scale + this.cam.tx;
    const midScreenY = ((m.sy + m.ey) / 2) * this.cam.scale + this.cam.ty;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = "bold 13px system-ui, sans-serif";
    const w = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(20,22,26,0.85)";
    ctx.fillRect(midScreenX - w / 2 - 6, midScreenY - 22, w + 12, 20);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, midScreenX, midScreenY - 12);
    ctx.restore();
  }

  /** True if any blocking-layer piece lies across the segment (excluding ends). */
  private losBlocked(x1: number, y1: number, x2: number, y2: number): boolean {
    for (const p of this.pieces) {
      if (classifyPiece(p) !== "terrain") continue;
      const layer = p.layerName();
      if (layer && LOS_TRANSPARENT_RE.test(layer)) continue;
      // Ignore terrain sitting right on an endpoint (the shooter's/target's hex).
      if (Math.hypot(p.x - x1, p.y - y1) < 8 || Math.hypot(p.x - x2, p.y - y2) < 8) continue;
      if (segmentIntersectsPiece(p, x1, y1, x2, y2, this.images, this.pieceScale)) return true;
    }
    return false;
  }

  private zSorted(): GamePiece[] {
    if (this.sortedPieces) return this.sortedPieces;
    const idx = (p: GamePiece) => {
      const l = p.layerName();
      const i = l ? this.layerRank.get(l) ?? -1 : -1;
      const categoryRank = { terrain: 10, aids: 20, models: 30 }[classifyPiece(p)];
      return categoryRank * 100 + (i < 0 ? this.layerOrder.length : i);
    };
    this.sortedPieces = this.pieces
      .map((p, i) => ({ p, i }))
      .sort((a, b) => idx(a.p) - idx(b.p) || a.i - b.i)
      .map((e) => e.p);
    return this.sortedPieces;
  }

  private invalidateSort(): void {
    this.sortedPieces = null;
  }

  private visiblePieces(): GamePiece[] {
    const r = this.canvas.getBoundingClientRect();
    const min = this.screenToWorld(-80, -80);
    const max = this.screenToWorld(r.width + 80, r.height + 80);
    return this.zSorted().filter((p) => {
      const { hw, hh } = pieceHalfExtent(p, this.images, this.pieceScale);
      return p.x + hw >= min.x && p.x - hw <= max.x && p.y + hh >= min.y && p.y - hh <= max.y;
    });
  }

  // ---- camera --------------------------------------------------------------

  private resize(): void {
    const dpr = canvasPixelRatio();
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.canvas.style.width = r.width + "px";
    this.canvas.style.height = r.height + "px";
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.draw();
  }

  private observeSize(parent: HTMLElement): void {
    const Observer = (window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) {
      this.resizeObserver = new Observer(() => this.resize());
      this.resizeObserver.observe(parent);
    } else {
      window.addEventListener("resize", () => this.resize());
    }
  }

  private fitBoard(): void {
    const r = this.canvas.getBoundingClientRect();
    const size = this.boardWorldSize();
    if (size && size.width > 0 && size.height > 0) {
      const scale = Math.min(r.width / size.width, r.height / size.height) * 0.95;
      this.cam.scale = scale || 1;
      this.cam.tx = (r.width - size.width * this.cam.scale) / 2 - this.boardOrigin.x * this.cam.scale;
      this.cam.ty = (r.height - size.height * this.cam.scale) / 2 - this.boardOrigin.y * this.cam.scale;
    } else if (this.boardImage) {
      // board not loaded yet; retry shortly
      setTimeout(() => this.fitBoard(), 100);
    }
  }

  private currentBoardDef(): BoardDef | null {
    return this.boardImage ? this.boardDefs.get(this.boardImage) ?? null : null;
  }

  private drawBoard(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(this.boardOrigin.x, this.boardOrigin.y);
    try {
      this.drawBoardContent(ctx);
    } finally {
      ctx.restore();
    }
  }

  private drawBoardContent(ctx: CanvasRenderingContext2D): void {
    const boardDef = this.currentBoardDef();
    if (boardDef?.tiles?.length) {
      const layout = this.boardLayout(boardDef);
      if (!layout) return;
      for (const tile of layout.tiles) {
        const sx = tile.crop?.x ?? 0;
        const sy = tile.crop?.y ?? 0;
        ctx.save();
        if (tile.reversed) {
          // ASLBoard reversal: the tile draws rotated 180° in place.
          ctx.translate(tile.x + tile.w / 2, tile.y + tile.h / 2);
          ctx.rotate(Math.PI);
          ctx.drawImage(tile.image.img, sx, sy, tile.w, tile.h, -tile.w / 2, -tile.h / 2, tile.w, tile.h);
        } else {
          ctx.drawImage(tile.image.img, sx, sy, tile.w, tile.h, tile.x, tile.y, tile.w, tile.h);
        }
        ctx.restore();
      }
      return;
    }

    const imageName = boardDef?.image || this.boardImage;
    const board = this.images.get(imageName);
    if (board && board.loaded) {
      const crop = boardDef?.crop;
      if (crop) {
        const cw = crop.width > 0 ? Math.min(crop.width, board.width - crop.x) : board.width - crop.x;
        const ch = crop.height > 0 ? Math.min(crop.height, board.height - crop.y) : board.height - crop.y;
        ctx.drawImage(board.img, crop.x, crop.y, cw, ch, 0, 0, cw, ch);
      } else {
        ctx.drawImage(board.img, 0, 0);
      }
      return;
    }

    // Java Board: no image means a width×height rectangle of solid color
    // (old modules build their map from a color fill plus a visible grid).
    if (boardDef?.width && boardDef.height) {
      ctx.fillStyle = cssColor(boardDef.color ?? null) ?? "#ffffff";
      ctx.fillRect(0, 0, boardDef.width, boardDef.height);
    }
  }

  private boardWorldSize(): { width: number; height: number } | null {
    const boardDef = this.currentBoardDef();
    if (boardDef?.tiles?.length) return this.boardLayout(boardDef);
    const imageName = boardDef?.image || this.boardImage;
    const board = this.images.get(imageName);
    if (board && board.loaded) {
      const crop = boardDef?.crop;
      return {
        width: crop && crop.width > 0 ? Math.min(crop.width, board.width) : board.width,
        height: crop && crop.height > 0 ? Math.min(crop.height, board.height) : board.height,
      };
    }
    if (boardDef?.width && boardDef.height) return { width: boardDef.width, height: boardDef.height };
    return null;
  }

  /**
   * Grid lines + hex numbering over the board, when the grid declares itself
   * visible (HexGrid.draw / HexGridNumbering.draw). The line path is cached
   * per board; labels skip below ~5px on screen like the Java engine.
   */
  private drawGridOverlay(ctx: CanvasRenderingContext2D): void {
    const grid = this.hexGrid;
    const def = grid?.def;
    const size = this.boardWorldSize();
    if (!grid || !def || !size) return;
    const numbering = def.numbering;
    if (!def.visible && !numbering?.visible) return;

    ctx.save();
    ctx.translate(this.boardOrigin.x, this.boardOrigin.y);
    ctx.beginPath();
    ctx.rect(0, 0, size.width, size.height);
    ctx.clip();

    const centers: Array<{ x: number; y: number }> = [];
    for (let col = 0; def.originX + col * def.dx <= size.width + def.dx; col++) {
      const cx = def.originX + col * def.dx;
      const stagger = col % 2 === 0 ? 0 : def.dy / 2;
      for (let row = -1; def.originY + row * def.dy <= size.height + def.dy; row++) {
        centers.push({ x: cx, y: def.originY + row * def.dy + stagger });
      }
    }

    if (def.visible) {
      if (!this.gridPath || this.gridPathKey !== this.boardImage) {
        const path = new Path2D();
        for (const c of centers) {
          const poly = grid.hexPolygon(c.x, c.y);
          poly.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
          path.closePath();
        }
        this.gridPath = path;
        this.gridPathKey = this.boardImage;
      }
      ctx.strokeStyle = def.color ?? "#000000";
      ctx.lineWidth = 1 / this.cam.scale;
      ctx.stroke(this.gridPath);
    }

    // Labels sit at the top of each hex (Java LabelUtils.TOP at -dy/2).
    if (numbering?.visible && numbering.fontSize * this.cam.scale >= 5) {
      ctx.fillStyle = numbering.color;
      ctx.font = `${numbering.fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const c of centers) {
        ctx.fillText(grid.locationName(c.x, c.y), c.x, c.y - def.dy / 2 + 1);
      }
    }
    ctx.restore();
  }

  private boardLayout(boardDef: BoardDef): {
    width: number;
    height: number;
    tiles: Array<{
      image: NonNullable<ReturnType<ImageStore["get"]>>;
      x: number;
      y: number;
      w: number;
      h: number;
      reversed: boolean;
      crop?: { x: number; y: number; width: number; height: number };
    }>;
  } | null {
    const loaded = boardDef.tiles?.map((tile) => ({ tile, image: this.images.get(tile.image) })).filter((t) => t.image) ?? [];
    if (!loaded.length || loaded.some((t) => !t.image!.loaded)) return null;

    // Cropped tiles occupy their cropped footprint; cells size to the largest.
    const sized = loaded.map(({ tile, image }) => ({
      tile,
      image: image!,
      w: tile.crop && tile.crop.width > 0 ? Math.min(tile.crop.width, image!.width) : image!.width,
      h: tile.crop && tile.crop.height > 0 ? Math.min(tile.crop.height, image!.height) : image!.height,
    }));
    const cellWidth = Math.max(...sized.map((t) => t.w));
    const cellHeight = Math.max(...sized.map((t) => t.h));
    const tiles = sized.map(({ tile, image, w, h }) => ({
      image,
      x: tile.x * cellWidth,
      y: tile.y * cellHeight,
      w,
      h,
      reversed: !!tile.reversed,
      crop: tile.crop,
    }));
    return {
      width: Math.max(...tiles.map((t) => t.x + t.w)),
      height: Math.max(...tiles.map((t) => t.y + t.h)),
      tiles,
    };
  }

  private screenToWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.cam.tx) / this.cam.scale, y: (py - this.cam.ty) / this.cam.scale };
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const before = this.screenToWorld(px, py);
    this.cam.scale = Math.max(0.05, Math.min(8, this.cam.scale * factor));
    this.cam.tx = px - before.x * this.cam.scale;
    this.cam.ty = py - before.y * this.cam.scale;
    this.requestDraw();
  }

  // ---- input ---------------------------------------------------------------

  private attach(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    c.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    c.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    window.addEventListener("pointercancel", (e) => this.onPointerUp(e));
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !isTypingTarget(e.target)) this.spacePan = true;
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") this.spacePan = false;
    });
  }

  private localXY(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private topPieceAt(wx: number, wy: number): GamePiece | null {
    return this.piecesAt(wx, wy)[0] ?? null;
  }

  private piecesAt(wx: number, wy: number): GamePiece[] {
    if (this.interactionLayer === "map") return [];
    const ordered = this.zSorted();
    const hits: GamePiece[] = [];
    const fallback: GamePiece[] = [];
    for (let i = ordered.length - 1; i >= 0; i--) {
      if (!hitTestPiece(ordered[i], wx, wy, this.images, this.pieceScale)) continue;
      (this.matchesInteractionLayer(ordered[i]) ? hits : fallback).push(ordered[i]);
    }
    // The edit focus is a priority, not a wall: with nothing from the focused
    // layer under the pointer, pick from the other layers so terrain and
    // game aids stay directly grabbable (focused pieces still win overlaps).
    return hits.length ? hits : fallback;
  }

  private cycleHit(hits: GamePiece[], e: PointerEvent): GamePiece | null {
    if (hits.length <= 1) return hits[0] ?? null;
    const current = this.getSelected();
    if (!current || (!e.altKey && e.detail < 2)) return hits[0];
    const idx = hits.indexOf(current);
    return hits[(idx + 1 + hits.length) % hits.length] ?? hits[0];
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button === 2) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* Older WebKit can reject capture during edge-case gesture handoff. */
    }
    const p = this.localXY(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size === 2) {
      this.mode = "pinch";
      this.dragPieces = [];
      this.clearLongPress();
      this.lastPinchDist = this.pinchDistance();
      return;
    }

    this.downAt = p;
    const world = this.screenToWorld(p.x, p.y);

    // Range/LOS tool: start a thread instead of selecting/dragging.
    if (this.measureMode) {
      this.mode = "measure";
      const s = this.snapThreadPoint(world.x, world.y, true);
      this.measure = { sx: s.x, sy: s.y, ex: s.x, ey: s.y };
      this.clearLongPress();
      this.requestDraw();
      return;
    }

    if (this.pointerTool === "pan" || e.button === 1 || this.spacePan) {
      this.mode = "pan";
      this.clearLongPress();
      return;
    }

    const hits = this.piecesAt(world.x, world.y);
    const hit = this.cycleHit(hits, e);

    if (hit) {
      this.bringToFrontWithinCategory(hit);
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        this.toggleSelected(hit);
        this.mode = "idle";
        this.clearLongPress();
        return;
      }
      if (!this.selected.has(hit)) this.select(hit);
      if (!hit.isImmobile()) {
        this.mode = "drag";
        this.dragPieces = this.getSelectedPieces().filter((p) => !p.isImmobile());
        this.dragStartLocs.clear();
        if (this.hexGrid) {
          for (const piece of this.dragPieces) {
            const loc = this.locationOf(piece);
            if (loc) this.dragStartLocs.set(piece, loc);
          }
        }
      } else {
        this.mode = "idle";
      }
      // long-press over a piece opens its context menu (touch)
      this.startLongPress(hit, e.clientX, e.clientY);
    } else if (this.deckAt(world.x, world.y)) {
      // Deck pile: drag pulls the top piece off; a plain tap opens its menu
      // (see onPointerMove/Up). Long-press also opens the menu (touch).
      const deck = this.deckAt(world.x, world.y)!;
      this.mode = "deckPick";
      this.pendingDeck = deck;
      this.clearLongPress();
      this.longPressTimer = window.setTimeout(() => {
        this.mode = "idle";
        this.pendingDeck = null;
        this.cb.onDeckMenu?.(deck.id, e.clientX, e.clientY);
      }, 500);
    } else {
      this.mode = "marquee";
      this.marquee = { sx: world.x, sy: world.y, ex: world.x, ey: world.y };
      if (!e.shiftKey && !e.metaKey && !e.ctrlKey) this.select(null);
      this.clearLongPress();
      this.requestDraw();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.localXY(e);
    const prev = this.pointers.get(e.pointerId)!;
    this.pointers.set(e.pointerId, p);

    const moved = Math.hypot(p.x - this.downAt.x, p.y - this.downAt.y);
    if (moved > 6) this.clearLongPress();

    if (this.mode === "pinch" && this.pointers.size >= 2) {
      const dist = this.pinchDistance();
      const mid = this.pinchMidpoint();
      if (this.lastPinchDist > 0) this.zoomAt(mid.x, mid.y, dist / this.lastPinchDist);
      this.lastPinchDist = dist;
      return;
    }

    if (this.mode === "deckPick" && this.pendingDeck && moved > 6) {
      const w = this.screenToWorld(p.x, p.y);
      const piece = this.cb.onDeckPickUp?.(this.pendingDeck.id, w.x, w.y) ?? null;
      this.pendingDeck = null;
      if (piece) {
        this.mode = "drag";
        this.dragPieces = [piece];
        this.dragStartLocs.clear();
      } else {
        this.mode = "idle";
      }
      return;
    }

    if (this.mode === "measure" && this.measure) {
      const w = this.screenToWorld(p.x, p.y);
      const e = this.snapThreadPoint(w.x, w.y, false);
      this.measure.ex = e.x;
      this.measure.ey = e.y;
      this.requestDraw();
      return;
    }

    if (this.mode === "marquee" && this.marquee) {
      const w = this.screenToWorld(p.x, p.y);
      this.marquee.ex = w.x;
      this.marquee.ey = w.y;
      this.requestDraw();
      return;
    }

    const dx = p.x - prev.x;
    const dy = p.y - prev.y;

    if (this.mode === "drag" && this.dragPieces.length) {
      for (const piece of this.dragPieces) {
        piece.x += dx / this.cam.scale;
        piece.y += dy / this.cam.scale;
      }
      this.requestDraw();
    } else if (this.mode === "pan") {
      this.cam.tx += dx;
      this.cam.ty += dy;
      this.requestDraw();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.clearLongPress();
    try {
      if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* Ignore capture release races during browser gesture cancellation. */
    }
    this.pointers.delete(e.pointerId);
    if (this.mode === "drag" && this.dragPieces.length) {
      for (const piece of this.dragPieces) {
        const snapped = piece.ignoresGrid() ? { x: piece.x, y: piece.y } : this.snap(piece.x, piece.y);
        piece.x = snapped.x;
        piece.y = snapped.y;
        const from = this.dragStartLocs.get(piece);
        const to = this.locationOf(piece);
        if (from && to && from !== to) this.cb.onMoved?.(piece, from, to);
        this.updateMoved(piece);
      }
      this.dragStartLocs.clear();
      this.cb.onChange();
    }
    if (this.mode === "marquee" && this.marquee) this.finishMarquee(e);
    if (this.mode === "deckPick" && this.pendingDeck) {
      // No drag happened: a plain tap/click opens the deck menu.
      this.cb.onDeckMenu?.(this.pendingDeck.id, e.clientX, e.clientY);
      this.pendingDeck = null;
    }
    if (this.pointers.size === 0) {
      this.mode = "idle";
      this.dragPieces = [];
      this.marquee = null;
    } else if (this.pointers.size === 1) {
      this.mode = "pan";
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.localXY(e);
    this.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }

  private onContextMenu(e: MouseEvent): void {
    e.preventDefault();
    const p = this.localXY(e);
    const world = this.screenToWorld(p.x, p.y);
    const hit = this.topPieceAt(world.x, world.y);
    if (hit) {
      this.select(hit);
      this.cb.onContextMenu(hit, e.clientX, e.clientY);
      return;
    }
    const deck = this.deckAt(world.x, world.y);
    if (deck) this.cb.onDeckMenu?.(deck.id, e.clientX, e.clientY);
  }

  private finishMarquee(e: PointerEvent): void {
    const m = this.marquee;
    if (!m) return;
    const minX = Math.min(m.sx, m.ex);
    const maxX = Math.max(m.sx, m.ex);
    const minY = Math.min(m.sy, m.ey);
    const maxY = Math.max(m.sy, m.ey);
    if (Math.abs(maxX - minX) < 4 || Math.abs(maxY - minY) < 4) return;
    const matches = this.zSorted().filter((p) =>
      this.matchesInteractionLayer(p) &&
      p.x >= minX &&
      p.x <= maxX &&
      p.y >= minY &&
      p.y <= maxY
    );
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      const combined = new Set(this.getSelectedPieces());
      for (const p of matches) combined.add(p);
      this.selectMany([...combined]);
    } else {
      this.selectMany(matches);
    }
  }

  private startLongPress(piece: GamePiece, clientX: number, clientY: number): void {
    this.clearLongPress();
    this.longPressTimer = window.setTimeout(() => {
      this.cb.onContextMenu(piece, clientX, clientY);
    }, 500);
  }

  private clearLongPress(): void {
    if (this.longPressTimer != null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  private pinchDistance(): number {
    const pts = [...this.pointers.values()];
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  private pinchMidpoint(): { x: number; y: number } {
    const pts = [...this.pointers.values()];
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  }

  private updateMoved(piece: GamePiece): void {
    if (classifyPiece(piece) !== "models") {
      piece.trailStart = { x: piece.x, y: piece.y };
      piece.setMovedStatus(false);
      piece.clearMoveTrail();
      return;
    }
    if (!piece.trailStart) piece.trailStart = { x: piece.x, y: piece.y };
    const moved = Math.hypot(piece.x - piece.trailStart.x, piece.y - piece.trailStart.y) > 1;
    piece.setMovedStatus(moved);
    if (moved) piece.recordMovePoint();
  }

  private bringToFrontWithinCategory(piece: GamePiece): void {
    const current = this.pieces.indexOf(piece);
    if (current < 0 || current === this.pieces.length - 1) return;
    const category = classifyPiece(piece);
    const layer = piece.layerName();
    let target = current;
    for (let i = current + 1; i < this.pieces.length; i++) {
      const other = this.pieces[i];
      if (classifyPiece(other) === category && other.layerName() === layer) target = i;
    }
    if (target === current) return;
    this.pieces.splice(current, 1);
    this.pieces.splice(target, 0, piece);
    this.invalidateSort();
  }

  private matchesInteractionLayer(piece: GamePiece): boolean {
    if (this.interactionLayer === "all") return true;
    return classifyPiece(piece) === this.interactionLayer;
  }

  private drawMovementTrails(ctx: CanvasRenderingContext2D): void {
    const unit = this.losScale > 0 ? this.losScale : 32;
    for (const p of this.pieces) {
      if (classifyPiece(p) !== "models") continue;
      const traitTrails = p.movementTrails();
      if (traitTrails.length) {
        for (const trail of traitTrails) this.drawTraitTrail(ctx, trail, this.selected.has(p));
        continue;
      }
      if (p.hasMovedTrait() || !p.movedStatus() || !p.trailStart) continue;
      const sx = p.trailStart.x;
      const sy = p.trailStart.y;
      const dx = p.x - sx;
      const dy = p.y - sy;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len;
      const uy = dy / len;

      ctx.save();
      ctx.strokeStyle = "rgba(255, 207, 51, 0.65)";
      ctx.lineWidth = 1.5 / this.cam.scale;
      ctx.setLineDash([6 / this.cam.scale, 4 / this.cam.scale]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ffcf33";
      const steps = Math.floor(len / unit);
      const size = Math.max(3 / this.cam.scale, 4);
      for (let i = 1; i <= steps; i++) {
        const x = sx + ux * unit * i;
        const y = sy + uy * unit * i;
        ctx.fillRect(x - size / 2, y - size / 2, size, size);
      }
      ctx.restore();
    }
  }

  private drawTraitTrail(ctx: CanvasRenderingContext2D, trail: ReturnType<GamePiece["movementTrails"]>[number], selected: boolean): void {
    if (!trail.visible || trail.points.length === 0) return;
    const alpha = selected ? trail.alphaSelected : trail.alphaUnselected;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = trail.stroke;
    ctx.fillStyle = trail.fill;
    ctx.lineWidth = Math.max(1 / this.cam.scale, trail.lineWidth);
    ctx.beginPath();
    trail.points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    for (const p of trail.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, trail.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

function classifyPiece(piece: GamePiece): SlotCategory {
  // Scenario cards / rule aids (HTML labels) sit under the counters that
  // play on top of them, whatever their provenance.
  if (piece.hasHtmlLabel()) return "aids";
  if (piece.paletteCategory) return piece.paletteCategory;
  const layer = piece.layerName();
  if (layer) {
    if (AID_LAYER_RE.test(layer)) return "aids";
    if (TERRAIN_LAYER_RE.test(layer)) return "terrain";
  }
  const name = piece.name();
  if (/objective|deployment|zone|hex ?grid|aura|range|marker|counter/i.test(name)) return "aids";
  return "models";
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
  return t + "…";
}

function canvasPixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2);
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
