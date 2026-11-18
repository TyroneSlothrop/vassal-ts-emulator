/**
 * Parse a module's `buildFile.xml` into the subset of the tree we need:
 * the Map windows (with their selectable boards + layer order) and the
 * PieceWindow palette (a tree of container widgets down to PieceSlots).
 *
 * VASSAL uses fully-qualified Java class names as XML tag names, e.g.
 * `<VASSAL.build.module.Map ...>`. DOMParser handles the dots fine.
 */

import type { HexGridDef } from "./hexgrid";
import {
  resolveToolbarMenus,
  zoomerInitialIndex,
  type ChartNodeDef,
  type GlobalMapDef,
  type ToolbarItemDef,
  type TurnTrackerDef,
  type TurnLevelDef,
  type ZoomerDef,
} from "./toolbar-defs";

export type { ChartNodeDef, GlobalMapDef, ToolbarItemDef, TurnTrackerDef, TurnLevelDef, ZoomerDef };

export interface BoardDef {
  /**
   * Visible sub-rectangle of the board image (ASLBoard crop bounds from a
   * save's `bd` command). Zero width/height = to the image edge.
   */
  crop?: { x: number; y: number; width: number; height: number };
  id?: string;
  name: string;
  image: string;
  reversible: boolean;
  tiles?: BoardTileDef[];
  /** Board archive file under the preset's boards/ dir, fetched on demand. */
  archiveFile?: string;
  /** Hex grid, from the buildFile or the board archive once loaded. */
  grid?: HexGridDef;
  /** Raw ASLBoardPicker `bd` command this layout came from (re-exported
   *  verbatim so crop/VER/overlay tokens survive the round-trip). */
  bdCommand?: string;
  /** Imageless boards (Java Board): a width×height rectangle of solid color. */
  width?: number;
  height?: number;
  /** Fill color as "r,g,b", when declared. */
  color?: string;
}

export interface BoardTileDef {
  boardName: string;
  image: string;
  /** Layout cell indices (column, row), not pixels. */
  x: number;
  y: number;
  /** ASLBoard reversal: the tile draws rotated 180°. */
  reversed?: boolean;
  /** Origin-anchored crop of the tile image. Zero = to the edge. */
  crop?: { x: number; y: number; width: number; height: number };
  /** Lazy board archive backing this tile, when boards ship separately. */
  archiveFile?: string;
}

/**
 * Stock LOS_Thread declaration (VASSAL/build/module/map/LOS_Thread.java):
 * the module's own range/LOS tool settings.
 */
export interface LosThreadDef {
  /** RANGE_SCALE: pixels per range unit. 0 = report raw pixels. */
  scale: number;
  /** LOS_COLOR (threadColor), CSS-ready; null = renderer default. */
  color: string | null;
  /** SNAP_START / SNAP_LOS: snap the thread start to the grid. */
  snapStart: boolean;
  /** SNAP_END / SNAP_LOS: snap the thread end to the grid. */
  snapEnd: boolean;
  /** RANGE_ROUNDING: "Up" (default), "Down", or "Nearest whole number". */
  round: "up" | "down" | "nearest";
}

/**
 * Stock `StackMetrics` (VASSAL/build/module/map/StackMetrics.java): how
 * co-located pieces cascade visually. Defaults are the Java constants.
 */
export interface StackMetricsDef {
  disabled: boolean;
  unexSepX: number;
  unexSepY: number;
  exSepX: number;
  exSepY: number;
}

export interface MapDef {
  /** VASSAL `mapName` — unique id of the window. */
  name: string;
  buttonName: string;
  boards: BoardDef[];
  drawPiles: DrawPileDef[];
  /** Stack cascade metrics, when the map declares them. */
  stackMetrics?: StackMetricsDef;
  /**
   * Edge buffer: blank margin around the boards. Boards (and board-relative
   * grids/piles) anchor at this offset in map coordinates — piece positions
   * include it (Map.setBoardBoundaries translates boards by the buffer).
   */
  edgeWidth?: number;
  edgeHeight?: number;
  /** LayeredPieceCollection order; a piece's z-index = indexOf(its Layer). */
  layerOrder: string[];
  /** LOS_Thread range scale: pixels per range unit (inch). 0 = none defined. */
  losScale: number;
  /** Full LOS_Thread declaration when the map has one. */
  losThread?: LosThreadDef;
  /** At-start stacks placed on new-game setup. */
  setupStacks?: SetupStackDef[];
  /** Map-level Zoomer levels, if declared. */
  zoomer?: ZoomerDef;
  /** Map-level GlobalMap (overview) definition, if declared. */
  globalMap?: GlobalMapDef;
}

export interface DrawPileDef {
  name: string;
  mapName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  drawFaceUp: boolean;
  /** "Always" / "Never" / "Use Menu" — whether contents sit face down. */
  faceDown: string;
  /** "Always" (default) / "Never" / "Use Menu" — shuffle at game start. */
  shuffle: string;
  shuffleCommand: string;
  /** Pile outline color as "r,g,b", or null. */
  color: string | null;
  /** Board this pile belongs to; shown only while that board is in play. */
  owningBoard: string | null;
  slots: PieceSlotDef[];
}

/**
 * `SetupStack` — pieces placed at a fixed board position when a new game
 * starts (VASSAL/build/module/map/SetupStack.java; DrawPile subclasses it).
 */
export interface SetupStackDef {
  name: string;
  mapName: string;
  owningBoard: string | null;
  x: number;
  y: number;
  slots: PieceSlotDef[];
}

export type SlotCategory = "models" | "terrain" | "aids";

export interface PieceSlotDef {
  name: string;
  gpid: string;
  width: number;
  height: number;
  /** The `+/id/type/state` piece definition. */
  def: string;
  /** Palette provenance category, used for edit focus/z-order when traits lack Layer. */
  category?: SlotCategory;
  /** Source module/extension filename for debugging and future preset grouping. */
  source?: string;
}

export interface WidgetNode {
  name: string;
  /** Container widget tag short-name (BoxWidget/ListWidget/TabWidget/...). */
  kind: string;
  /** hidden="true" PieceWindow: resolvable in the tree, not shown in the palette. */
  hidden?: boolean;
  children: WidgetNode[];
  slots: PieceSlotDef[];
  category?: SlotCategory;
  source?: string;
}

export interface ModuleModel {
  name: string;
  version: string;
  maps: MapDef[];
  diceButtons: DiceButtonDef[];
  predefinedSetups: PredefinedSetupDef[];
  /** Module/map GlobalProperty initial values, by name. */
  globalProperties: Map<string, string>;
  palette: WidgetNode | null;
  /** PrototypeDefinition name -> its `+/id/type/state` definition string. */
  prototypes: Map<string, string>;
  /** Module toolbar buttons in GameModule child document order, menus resolved. */
  toolbar: ToolbarItemDef[];
  /**
   * The module declares a custom `*DiceBot` component (2d6 bots
   * reporting `DR`/`dr` rolls by category); enables the chatter's DR/dr row.
   */
  hasDiceBot: boolean;
}

export interface PredefinedSetupDef {
  name: string;
  file: string;
  isMenu: boolean;
  useFile: boolean;
  /** Enclosing setup-menu names, outermost first (scenario books/series). */
  menu: string[];
}

export interface DiceButtonDef {
  name: string;
  text: string;
  nDice: number;
  nSides: number;
  plus: number;
  prompt: boolean;
  reportTotal: boolean;
}

/** One `<ExtensionElement target=...>` graft: widgets to splice into the palette. */
export interface ExtensionGraft {
  /** target path like `PieceWindow:Models/BoxWidget:GroupB` (class:entryName / …). */
  target: string;
  widgets: WidgetNode[];
}

/** Boards contributed by a module extension to a map's BoardPicker. */
export interface BoardGraft {
  /** target path like `Map:Table/BoardPicker`. */
  target: string;
  mapName: string;
  boards: BoardDef[];
}

export interface ExtensionModel {
  id: string;
  name: string;
  category: SlotCategory;
  grafts: ExtensionGraft[];
  boardGrafts: BoardGraft[];
  prototypes: Map<string, string>;
  /** Scenario setups the extension contributes (files live in its archive). */
  predefinedSetups: PredefinedSetupDef[];
}

const NS = "VASSAL.build.";
const T = {
  module: NS + "GameModule",
  map: NS + "module.Map",
  privateMap: NS + "module.PrivateMap",
  playerHand: NS + "module.PlayerHand",
  boardPicker: NS + "module.map.BoardPicker",
  board: NS + "module.map.boardPicker.Board",
  layered: NS + "module.map.LayeredPieceCollection",
  drawPile: NS + "module.map.DrawPile",
  setupStack: NS + "module.map.SetupStack",
  stackMetrics: NS + "module.map.StackMetrics",
  pieceWindow: NS + "module.PieceWindow",
  diceButton: NS + "module.DiceButton",
  predefinedSetup: NS + "module.PredefinedSetup",
  globalProperty: NS + "module.properties.GlobalProperty",
  pieceSlot: NS + "widget.PieceSlot",
  cardSlot: NS + "widget.CardSlot",
  losThread: NS + "module.map.LOS_Thread",
  hexGrid: NS + "module.map.boardPicker.board.HexGrid",
  hexGridNumbering: NS + "module.map.boardPicker.board.mapgrid.HexGridNumbering",
  prototypeDef: NS + "module.PrototypeDefinition",
  extension: NS + "module.ModuleExtension",
  extensionElement: NS + "module.ExtensionElement",
  notesWindow: NS + "module.NotesWindow",
  toolbarMenu: NS + "module.ToolbarMenu",
  turnTracker: NS + "module.turn.TurnTracker",
  counterTurnLevel: NS + "module.turn.CounterTurnLevel",
  listTurnLevel: NS + "module.turn.ListTurnLevel",
  globalMap: NS + "module.map.GlobalMap",
  zoomer: NS + "module.map.Zoomer",
  imageSaver: NS + "module.map.ImageSaver",
  chessClockControl: NS + "module.ChessClockControl",
  chartWindow: NS + "module.ChartWindow",
  chart: NS + "widget.Chart",
  tabWidget: NS + "widget.TabWidget",
  panelWidget: NS + "widget.PanelWidget",
  boxWidget: NS + "widget.BoxWidget",
  listWidget: NS + "widget.ListWidget",
  inventory: NS + "module.Inventory",
};

const CONTAINER_WIDGETS = new Set([
  NS + "widget.BoxWidget",
  NS + "widget.ListWidget",
  NS + "widget.TabWidget",
  NS + "widget.PanelWidget",
  T.pieceWindow,
]);

/**
 * Stock components a custom class may resolve to. Kept to classes the parser
 * actually consumes, so a wrong alias can't activate behavior we don't have.
 */
const ALIAS_TARGETS: string[] = [
  T.map,
  T.boardPicker,
  T.board,
  T.losThread,
  T.globalMap,
  T.zoomer,
  T.imageSaver,
  T.notesWindow,
  T.chartWindow,
  T.pieceWindow,
  T.drawPile,
  T.diceButton,
  T.turnTracker,
];

/**
 * Legacy VASSAL class names that old modules still use as tag names. These are
 * real classes in the Java engine (kept as thin subclasses/aliases of the
 * modern ones — `VASSAL.launch.BasicModule extends GameModule`), so old
 * buildFiles resolve them; map them to the modern tags before parsing.
 */
const LEGACY_CLASSES: Array<[string, string]> = [
  ["VASSAL.launch.BasicModule", T.module],
];

/** Is `name[i]` the start of a name word (camel hump or after `_`/start)? */
function wordBoundary(name: string, i: number): boolean {
  if (i === 0 || name[i - 1] === "_") return true;
  return /[A-Z]/.test(name[i]);
}

/** Length of the longest common suffix starting at a word boundary in both. */
function commonNameSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  while (n > 0 && !(wordBoundary(a, a.length - n) && wordBoundary(b, b.length - n))) n--;
  return n;
}

/**
 * Resolve a custom class to the stock component it most plausibly subclasses,
 * by name. Exact suffix matches win by length (ASLGlobalMap -> GlobalMap, not
 * Map); otherwise the longest common word-suffix of at least 4 chars
 * (VASLThread -> LOS_Thread via "Thread"). Returns null when nothing matches.
 */
export function stockClassFor(customTag: string): string | null {
  const custom = shortName(customTag);
  let best: string | null = null;
  let bestLen = 0;
  let bestExact = false;
  for (const stock of ALIAS_TARGETS) {
    const s = shortName(stock);
    const exact = custom.endsWith(s) && wordBoundary(custom, custom.length - s.length);
    const len = exact ? s.length : commonNameSuffix(custom, s);
    if (!exact && len < 4) continue;
    const better = exact !== bestExact ? exact : len > bestLen;
    if (better) {
      best = stock;
      bestLen = len;
      bestExact = exact;
    }
  }
  return best;
}

/**
 * Modules may declare custom Java classes as tag names — subclasses of stock
 * components that the Java engine loads from the module archive (custom
 * classes like ASLMap, ASLBoardPicker, VASLThread, …). We can't run module code, so
 * superclass resolution is approximated by class name (`stockClassFor`); the
 * subclass keeps the parent's XML attributes, so stock parsing applies.
 * Unmatched custom tags stay untouched and are ignored by the tag-name
 * lookups, like any other unknown component.
 */
export function normalizeCustomClasses(xml: string): string {
  const renames: Array<[string, string]> = LEGACY_CLASSES.filter(([from]) => xml.includes(from));
  const custom = new Set<string>();
  const tag = /<\/?([A-Za-z_][\w$]*(?:\.[\w$]+)+)(?=[\s/>])/g;
  for (let m = tag.exec(xml); m; m = tag.exec(xml)) {
    if (!m[1].startsWith("VASSAL.")) custom.add(m[1]);
  }
  for (const from of custom) {
    const to = stockClassFor(from);
    if (to) renames.push([from, to]);
  }
  for (const [from, to] of renames) {
    xml = xml.replace(new RegExp(`(</?)${from.replace(/[.$]/g, "\\$&")}(?=[\\s/>])`, "g"), `$1${to}`);
  }
  return xml;
}

export function parseBuildFile(xml: string): ModuleModel {
  const doc = new DOMParser().parseFromString(normalizeCustomClasses(xml), "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("buildFile.xml parse error: " + err.textContent);

  const root = doc.documentElement; // GameModule
  const name = root.getAttribute("name") ?? "Module";
  const version = root.getAttribute("version") ?? "";

  const maps: MapDef[] = [];
  for (const mapEl of mapElements(doc)) {
    maps.push(parseMap(mapEl));
  }

  // A module may declare several PieceWindows (e.g. Counters, Draggable
  // Overlays, and the hidden "?" window of concealment counters). One becomes
  // the palette root; the rest join as top-level groups. Hidden windows stay
  // in the tree because PlaceMarker specs resolve slots through them.
  const pieceWindows = Array.from(doc.getElementsByTagName(T.pieceWindow))
    .map((el) => parseWidget(el));
  let palette: WidgetNode | null = pieceWindows[0] ?? null;
  if (pieceWindows.length > 1) {
    palette = {
      name: pieceWindows[0].name,
      kind: "PieceWindow",
      children: [...pieceWindows[0].children, ...pieceWindows.slice(1)],
      slots: pieceWindows[0].slots,
    };
  }

  return {
    name,
    version,
    maps,
    diceButtons: parseDiceButtons(doc),
    predefinedSetups: parsePredefinedSetups(doc),
    globalProperties: parseGlobalProperties(doc),
    palette,
    prototypes: parsePrototypes(doc),
    toolbar: parseToolbar(root, maps),
    hasDiceBot: /<[\w$.]*DiceBot[\s/>]/.test(xml),
  };
}

/**
 * Build the module toolbar from GameModule children in document order, mirroring
 * the Java toolbar layout. Map-level GlobalMap buttons are injected right after
 * their Map's launch button so ToolbarMenus can capture
 * them. Menus are resolved (captured buttons move inside) before returning.
 */
function parseToolbar(root: Element, maps: MapDef[]): ToolbarItemDef[] {
  const items: ToolbarItemDef[] = [];
  const base = (el: Element, textAttr = "text"): { text: string; tooltip: string; icon: string } => ({
    text: (el.getAttribute(textAttr) ?? el.getAttribute("name") ?? "").trim(),
    tooltip: el.getAttribute("tooltip") ?? "",
    icon: el.getAttribute("icon") ?? "",
  });

  for (const el of Array.from(root.children)) {
    switch (el.tagName) {
      case T.diceButton: {
        const dice = parseDiceButton(el);
        items.push({ kind: "dice", dice, ...base(el), text: dice.text.trim() || dice.name });
        break;
      }
      case T.notesWindow:
        items.push({ kind: "notes", ...base(el, "buttonText") });
        break;
      case T.toolbarMenu:
        items.push({
          kind: "menu",
          ...base(el),
          menuItems: (el.getAttribute("menuItems") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          items: [],
          unresolved: [],
        });
        break;
      case T.turnTracker: {
        const def = parseTurnTracker(el);
        items.push({ kind: "turnTracker", def, ...base(el, "buttonText"), text: def.buttonText.trim() || def.name });
        break;
      }
      case T.pieceWindow:
        // Hidden windows (hidden="true" PieceWindows) have no toolbar button.
        if (el.getAttribute("hidden") !== "true") items.push({ kind: "pieceWindow", ...base(el) });
        break;
      case T.privateMap:
      case T.playerHand:
      case T.map: {
        const mapName = el.getAttribute("mapName") ?? el.getAttribute("buttonName") ?? "Map";
        if (el.getAttribute("launch") === "true") {
          const buttonName = (el.getAttribute("buttonName") ?? mapName).trim();
          items.push({ kind: "map", mapName, text: buttonName, tooltip: "", icon: el.getAttribute("icon") ?? "" });
        }
        // Map-level toolbar components join the merged toolbar in child order.
        // In the Java app these live on the Map window's own bar (e.g. a module's
        // Table has a "Overview" ToolbarMenu wrapping its GlobalMap button);
        // we render one merged toolbar since maps share a single canvas.
        for (const child of Array.from(el.children)) {
          if (child.tagName === T.globalMap) {
            const def = parseGlobalMap(child);
            items.push({ kind: "globalMap", mapName, def, text: def.buttonText.trim() || "Overview", tooltip: def.tooltip, icon: def.icon });
          } else if (child.tagName === T.toolbarMenu) {
            items.push({
              kind: "menu",
              ...base(child),
              menuItems: (child.getAttribute("menuItems") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
              items: [],
              unresolved: [],
            });
          }
        }
        break;
      }
      case T.chartWindow: {
        const charts = parseChartNodes(el);
        if (charts.length) {
          items.push({ kind: "chartWindow", name: el.getAttribute("name") ?? "Charts", charts, ...base(el) });
        } else {
          items.push({ kind: "unsupported", component: shortName(el.tagName), ...base(el, "buttonText") });
        }
        break;
      }
      case T.chessClockControl:
      case T.inventory:
        items.push({ kind: "unsupported", component: shortName(el.tagName), ...base(el, "buttonText") });
        break;
    }
  }

  // Attach per-map Zoomer / GlobalMap defs (even for non-launch maps).
  for (const mapEl of mapElements(root)) {
    const name = mapEl.getAttribute("mapName") ?? mapEl.getAttribute("buttonName") ?? "Map";
    const map = maps.find((m) => m.name === name);
    if (!map) continue;
    const zoomerEl = mapEl.getElementsByTagName(T.zoomer)[0];
    if (zoomerEl) {
      const levels = (zoomerEl.getAttribute("zoomLevels") ?? "")
        .split(",")
        .map((s) => parseFloat(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => a - b);
      if (levels.length) {
        const zoomStart = parseInt(zoomerEl.getAttribute("zoomStart") ?? "1", 10) || 1;
        map.zoomer = { levels, initialIndex: zoomerInitialIndex(levels.length, zoomStart) };
      }
    }
    const globalMapEl = mapEl.getElementsByTagName(T.globalMap)[0];
    if (globalMapEl) map.globalMap = parseGlobalMap(globalMapEl);
  }

  return resolveToolbarMenus(items);
}

/**
 * A ChartWindow's contents: Chart widgets (images) organized by nested
 * Tab/Panel/Box/List widgets. Box/List behave like tabs for
 * display purposes (Java shows one child at a time via combo/list selector).
 */
function parseChartNodes(parent: Element): ChartNodeDef[] {
  const nodes: ChartNodeDef[] = [];
  for (const el of Array.from(parent.children)) {
    const name = (el.getAttribute("entryName") ?? el.getAttribute("chartName") ?? "").trim();
    switch (el.tagName) {
      case T.chart: {
        const fileName = el.getAttribute("fileName") ?? "";
        if (fileName) nodes.push({ kind: "chart", name, fileName, children: [] });
        break;
      }
      case T.tabWidget:
      case T.boxWidget:
      case T.listWidget: {
        const children = parseChartNodes(el);
        if (children.length) nodes.push({ kind: "tabs", name, children });
        break;
      }
      case T.panelWidget: {
        const children = parseChartNodes(el);
        if (children.length) {
          nodes.push({ kind: "panel", name, vertical: el.getAttribute("vert") === "true", children });
        }
        break;
      }
    }
  }
  return nodes;
}

function parseGlobalMap(el: Element): GlobalMapDef {
  return {
    buttonText: el.getAttribute("buttonText") ?? "",
    tooltip: el.getAttribute("tooltip") ?? "",
    icon: el.getAttribute("icon") ?? "",
    scale: parseFloat(el.getAttribute("scale") ?? "0") || 0,
    color: el.getAttribute("color") ?? "255,255,0",
  };
}

function parseTurnTracker(el: Element): TurnTrackerDef {
  return {
    name: el.getAttribute("name") ?? "",
    buttonText: el.getAttribute("buttonText") ?? "",
    reportFormat: el.getAttribute("reportFormat") ?? "",
    turnFormat: el.getAttribute("turnFormat") ?? "",
    levels: parseTurnLevels(el),
  };
}

function parseTurnLevels(parent: Element): TurnLevelDef[] {
  const levels: TurnLevelDef[] = [];
  for (const el of Array.from(parent.children)) {
    if (el.tagName !== T.counterTurnLevel && el.tagName !== T.listTurnLevel) continue;
    levels.push({
      kind: el.tagName === T.counterTurnLevel ? "counter" : "list",
      name: el.getAttribute("name") ?? "",
      property: el.getAttribute("property") ?? "",
      start: parseInt(el.getAttribute("start") ?? "1", 10) || 0,
      incr: parseInt(el.getAttribute("incr") ?? "1", 10) || 1,
      loop: el.getAttribute("loop") === "true",
      loopLimit: parseInt(el.getAttribute("loopLimit") ?? "-1", 10) || -1,
      list: (el.getAttribute("list") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      turnFormat: el.getAttribute("turnFormat") ?? "$value$",
      children: parseTurnLevels(el),
    });
  }
  return levels;
}

function parsePrototypes(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const el of Array.from(doc.getElementsByTagName(T.prototypeDef))) {
    const name = el.getAttribute("name");
    if (name) map.set(name, el.textContent ?? "");
  }
  return map;
}

/**
 * Parse a module extension's buildFile (`<ModuleExtension>`). Extensions graft
 * widget subtrees onto the base palette at a target path and may add their own
 * prototypes. Extension-heavy modules keep whole piece rosters in
 * these extension files, not the base module.
 */
export function parseExtension(xml: string, sourceName = ""): ExtensionModel {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("extension parse error: " + err.textContent);
  const root = doc.documentElement;
  const id = root.getAttribute("extensionId") ?? "";
  const name = sourceName || root.getAttribute("name") || root.getAttribute("description") || id;
  const category = classifyExtensionCategory(name);

  const grafts: ExtensionGraft[] = [];
  const boardGrafts: BoardGraft[] = [];
  for (const ee of Array.from(doc.getElementsByTagName(T.extensionElement))) {
    const target = ee.getAttribute("target") ?? "";
    const widgets: WidgetNode[] = [];
    const boards: BoardDef[] = [];
    for (const child of Array.from(ee.children)) {
      if (CONTAINER_WIDGETS.has(child.tagName)) widgets.push(parseWidget(child, category, name));
      else if (child.tagName === T.board) boards.push(parseBoard(child));
      else if (child.tagName === T.pieceSlot || child.tagName === T.cardSlot) {
        // a slot grafted directly; wrap in a synthetic group
        widgets.push({
          name: "",
          kind: "BoxWidget",
          children: [],
          slots: [parseSlot(child, category, name)],
          category,
          source: name,
        });
      }
    }
    if (widgets.length) grafts.push({ target, widgets });
    if (boards.length) boardGrafts.push({ target, mapName: targetMapName(target), boards });
  }
  return {
    id,
    name,
    category,
    grafts,
    boardGrafts,
    prototypes: parsePrototypes(doc),
    predefinedSetups: parsePredefinedSetups(doc),
  };
}

/**
 * Splice an extension's grafts into the palette tree. Target paths look like
 * `VASSAL.build.module.PieceWindow:Models/VASSAL.build.widget.BoxWidget:GroupB`;
 * each segment is `ClassName:entryName`. We match by entryName. Unmatched
 * targets append to the palette root so nothing is silently lost.
 */
export function applyExtension(palette: WidgetNode, ext: ExtensionModel): void {
  for (const graft of ext.grafts) {
    const node = resolveTarget(palette, graft.target) ?? palette;
    node.children.push(...graft.widgets);
  }
}

/** Merge extension-provided BoardPicker entries into their target maps. */
export function applyExtensionBoards(maps: MapDef[], ext: ExtensionModel): void {
  for (const graft of ext.boardGrafts) {
    const map = maps.find((m) => m.name === graft.mapName || m.buttonName === graft.mapName);
    if (!map) continue;
    const seen = new Set(map.boards.map((b) => `${b.name}\n${b.image}`));
    for (const board of graft.boards) {
      const key = `${board.name}\n${board.image}`;
      if (seen.has(key)) continue;
      seen.add(key);
      map.boards.push(board);
    }
  }
}

export function boardKey(board: BoardDef): string {
  // Imageless boards (color rectangles) key by name.
  return board.id ?? (board.image || board.name);
}

/**
 * Merge another loaded module into `base` (hotseat multi-module play): the other
 * module's palette becomes a top-level group, its maps are appended, and its
 * prototypes are folded in by the caller. Board/window ids stay separate.
 */
export function mergeModuleInto(base: ModuleModel, other: ModuleModel): void {
  if (other.palette && base.palette) {
    const group: WidgetNode = {
      name: other.name || "Module",
      kind: "BoxWidget",
      children: other.palette.children,
      slots: other.palette.slots,
    };
    base.palette.children.push(group);
  } else if (other.palette && !base.palette) {
    base.palette = other.palette;
  }
  for (const m of other.maps) base.maps.push(m);
  base.diceButtons.push(...other.diceButtons);
  base.predefinedSetups.push(...other.predefinedSetups);
  for (const [k, v] of other.globalProperties) {
    if (!base.globalProperties.has(k)) base.globalProperties.set(k, v);
  }
  base.toolbar.push(...other.toolbar);
  base.hasDiceBot ||= other.hasDiceBot;
}

function resolveTarget(palette: WidgetNode, target: string): WidgetNode | null {
  const segs = target.split("/").map((s) => {
    const i = s.indexOf(":");
    return i >= 0 ? s.substring(i + 1) : s;
  });
  // First segment is the PieceWindow itself; start matching from segs[1].
  let node: WidgetNode = palette;
  for (let i = 1; i < segs.length; i++) {
    const next = node.children.find((c) => c.name === segs[i]);
    if (!next) return null;
    node = next;
  }
  return node;
}

function parseMap(mapEl: Element): MapDef {
  const boards: BoardDef[] = [];
  const picker = firstChild(mapEl, T.boardPicker);
  if (picker) {
    for (const b of Array.from(picker.getElementsByTagName(T.board))) {
      boards.push(parseBoard(b));
    }
  }
  let layerOrder: string[] = [];
  const layered = mapEl.getElementsByTagName(T.layered)[0];
  if (layered) {
    layerOrder = (layered.getAttribute("layerOrder") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // LOS thread: prefer a Range Thread (drawRange="true"); else any LOS thread.
  let losScale = 0;
  let losThread: LosThreadDef | undefined;
  const threads = Array.from(mapEl.getElementsByTagName(T.losThread));
  const rangeThread = threads.find((t) => t.getAttribute("drawRange") === "true") ?? threads[0];
  if (rangeThread) {
    losScale = parseFloat(rangeThread.getAttribute("scale") ?? "0") || 0;
    const snapAll = rangeThread.getAttribute("snapLOS") === "true";
    const round = rangeThread.getAttribute("round") ?? "Up";
    losThread = {
      scale: losScale,
      color: cssColor(rangeThread.getAttribute("threadColor")),
      snapStart: snapAll || rangeThread.getAttribute("snapStart") === "true",
      snapEnd: snapAll || rangeThread.getAttribute("snapEnd") === "true",
      round: /down/i.test(round) ? "down" : /nearest/i.test(round) ? "nearest" : "up",
    };
  }

  // Stack cascade metrics (Java defaults when absent/short).
  let stackMetrics: StackMetricsDef | undefined;
  const smEl = mapEl.getElementsByTagName(T.stackMetrics)[0];
  if (smEl) {
    const num = (attr: string, dflt: number) => {
      const v = Number.parseInt(smEl.getAttribute(attr) ?? "", 10);
      return Number.isFinite(v) ? v : dflt;
    };
    stackMetrics = {
      disabled: smEl.getAttribute("disabled") === "true",
      unexSepX: num("unexSepX", 2),
      unexSepY: num("unexSepY", 4),
      exSepX: num("exSepX", 6),
      exSepY: num("exSepY", 18),
    };
  }

  // Edge buffer: edgeWidth/edgeHeight attrs, or legacy combined "edgeBuffer".
  let edgeWidth = Number.parseInt(mapEl.getAttribute("edgeWidth") ?? "0", 10) || 0;
  let edgeHeight = Number.parseInt(mapEl.getAttribute("edgeHeight") ?? "0", 10) || 0;
  const edgeBuffer = mapEl.getAttribute("edgeBuffer");
  if (edgeBuffer?.includes(",")) {
    const [w, h] = edgeBuffer.split(",");
    edgeWidth = Number.parseInt(w, 10) || 0;
    edgeHeight = Number.parseInt(h, 10) || 0;
  }

  return {
    name: mapEl.getAttribute("mapName") ?? mapEl.getAttribute("buttonName") ?? "Map",
    buttonName: mapEl.getAttribute("buttonName") ?? mapEl.getAttribute("mapName") ?? "Map",
    boards,
    drawPiles: parseDrawPiles(mapEl),
    setupStacks: parseSetupStacks(mapEl),
    layerOrder,
    losScale,
    edgeWidth,
    edgeHeight,
    ...(losThread ? { losThread } : {}),
    ...(stackMetrics ? { stackMetrics } : {}),
  };
}

/**
 * All Map-family elements in document order. PrivateMap and PlayerHand are
 * Map subclasses in Java (side-restricted windows); local hotseat play
 * renders them as ordinary map windows.
 */
const MAP_TAGS = new Set<string>([T.map, T.privateMap, T.playerHand]);
function mapElements(scope: Document | Element): Element[] {
  return Array.from(scope.getElementsByTagName("*")).filter((el) => MAP_TAGS.has(el.tagName));
}

function parseBoard(el: Element): BoardDef {
  const board: BoardDef = {
    name: el.getAttribute("name") ?? "",
    image: el.getAttribute("image") ?? "",
    reversible: el.getAttribute("reversible") === "true",
  };
  // Java Board: without an image, the board is a width×height rectangle of
  // solid color (old modules draw their whole map as color + visible grid).
  const width = parseInt(el.getAttribute("width") ?? "0", 10);
  const height = parseInt(el.getAttribute("height") ?? "0", 10);
  if (width > 0 && height > 0) {
    board.width = width;
    board.height = height;
  }
  const color = el.getAttribute("color");
  if (color) board.color = color;
  const gridEl = el.getElementsByTagName(T.hexGrid)[0];
  // Our grid port is non-sideways (see hexgrid.ts); sideways grids degrade to
  // no grid rather than a wrong one.
  if (gridEl && gridEl.getAttribute("sideways") !== "true") board.grid = parseHexGrid(gridEl);
  return board;
}

/** Stock `HexGrid` (+ optional `HexGridNumbering` child) from the buildFile. */
function parseHexGrid(el: Element): HexGridDef {
  // Java HexGrid defaults: dy = 64, dx = dy * sqrt(3)/2.
  const dy = parseFloat(el.getAttribute("dy") ?? "64") || 64;
  const dx = parseFloat(el.getAttribute("dx") ?? "") || (dy * Math.sqrt(3)) / 2;
  const grid: HexGridDef = {
    dx,
    dy,
    originX: parseInt(el.getAttribute("x0") ?? "0", 10) || 0,
    originY: parseInt(el.getAttribute("y0") ?? "32", 10) || 0,
    alternate: false,
    // Java HexGrid keys: SNAP_SCALE = "snapscale", SNAP_TO = "snapTo",
    // EDGES = "edgesLegal", CORNERS = "cornersLegal" (defaults: 0/true/false/false).
    snapScale: parseInt(el.getAttribute("snapScale") ?? el.getAttribute("snapscale") ?? "0", 10) || 0,
    snapTo: el.getAttribute("snapTo") !== "false",
    edgesLegal: el.getAttribute("edgesLegal") === "true",
    cornersLegal: el.getAttribute("cornersLegal") === "true",
    visible: el.getAttribute("visible") === "true",
    color: cssColor(el.getAttribute("color")) ?? "#000000",
  };
  const numEl = el.getElementsByTagName(T.hexGridNumbering)[0];
  if (numEl) {
    grid.numbering = {
      first: numEl.getAttribute("first") === "V" ? "V" : "H",
      sep: numEl.getAttribute("sep") ?? "",
      hType: numEl.getAttribute("hType") === "A" ? "A" : "N",
      vType: numEl.getAttribute("vType") === "A" ? "A" : "N",
      hLeading: parseInt(numEl.getAttribute("hLeading") ?? "1", 10) || 0,
      vLeading: parseInt(numEl.getAttribute("vLeading") ?? "1", 10) || 0,
      hOff: parseInt(numEl.getAttribute("hOff") ?? "1", 10) || 0,
      vOff: parseInt(numEl.getAttribute("vOff") ?? "1", 10) || 0,
      hDescend: numEl.getAttribute("hDescend") === "true",
      vDescend: numEl.getAttribute("vDescend") === "true",
      stagger: numEl.getAttribute("stagger") !== "false",
      visible: numEl.getAttribute("visible") === "true",
      fontSize: parseInt(numEl.getAttribute("fontSize") ?? "9", 10) || 9,
      color: cssColor(numEl.getAttribute("color")) ?? "#000000",
    };
  }
  return grid;
}

/** VASSAL "r,g,b" color attribute to a CSS color. */
export function cssColor(raw: string | null): string | null {
  if (!raw) return null;
  const parts = raw.split(",").map((s) => parseInt(s.trim(), 10));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return `rgb(${parts[0]},${parts[1]},${parts[2]})`;
}

function targetMapName(target: string): string {
  const first = target.split("/")[0] ?? "";
  const i = first.indexOf(":");
  return i >= 0 ? first.substring(i + 1) : first;
}

function parseDrawPiles(mapEl: Element): DrawPileDef[] {
  const mapName = mapEl.getAttribute("mapName") ?? mapEl.getAttribute("buttonName") ?? "Map";
  // Deep query: modules commonly nest piles under MapSubFolder elements.
  return Array.from(mapEl.getElementsByTagName(T.drawPile)).map((el) => ({
    name: el.getAttribute("name") ?? "",
    mapName,
    x: parseInt(el.getAttribute("x") ?? "0", 10) || 0,
    y: parseInt(el.getAttribute("y") ?? "0", 10) || 0,
    width: parseInt(el.getAttribute("width") ?? "0", 10) || 0,
    height: parseInt(el.getAttribute("height") ?? "0", 10) || 0,
    drawFaceUp: el.getAttribute("drawFaceUp") === "true",
    faceDown: el.getAttribute("faceDown") ?? "",
    shuffle: el.getAttribute("shuffle") ?? "Always",
    shuffleCommand: el.getAttribute("shuffleCommand") ?? "",
    color: el.getAttribute("color"),
    owningBoard: el.getAttribute("owningBoard"),
    slots: Array.from(el.children)
      .filter((child) => child.tagName === T.pieceSlot || child.tagName === T.cardSlot)
      .map((child) => parseSlot(child)),
  }));
}

function parseSetupStacks(mapEl: Element): SetupStackDef[] {
  const mapName = mapEl.getAttribute("mapName") ?? mapEl.getAttribute("buttonName") ?? "Map";
  return Array.from(mapEl.getElementsByTagName(T.setupStack)).map((el) => ({
    name: el.getAttribute("name") ?? "",
    mapName,
    owningBoard: el.getAttribute("owningBoard"),
    x: parseInt(el.getAttribute("x") ?? "0", 10) || 0,
    y: parseInt(el.getAttribute("y") ?? "0", 10) || 0,
    slots: Array.from(el.children)
      .filter((child) => child.tagName === T.pieceSlot || child.tagName === T.cardSlot)
      .map((child) => parseSlot(child)),
  }));
}

function parseDiceButtons(doc: Document): DiceButtonDef[] {
  return Array.from(doc.getElementsByTagName(T.diceButton)).map(parseDiceButton);
}

function parseDiceButton(el: Element): DiceButtonDef {
  return {
    name: el.getAttribute("name") ?? "",
    text: el.getAttribute("text") ?? el.getAttribute("name") ?? "",
    nDice: parseInt(el.getAttribute("nDice") ?? "1", 10) || 1,
    nSides: parseInt(el.getAttribute("nSides") ?? "6", 10) || 6,
    plus: parseInt(el.getAttribute("plus") ?? "0", 10) || 0,
    prompt: el.getAttribute("prompt") === "true",
    reportTotal: el.getAttribute("reportTotal") === "true",
  };
}

function parseGlobalProperties(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  for (const el of Array.from(doc.getElementsByTagName(T.globalProperty))) {
    const name = el.getAttribute("name");
    if (name) out.set(name, el.getAttribute("initialValue") ?? "");
  }
  return out;
}

function parsePredefinedSetups(doc: Document): PredefinedSetupDef[] {
  return Array.from(doc.getElementsByTagName(T.predefinedSetup)).map((el) => {
    // Menu hierarchy: PredefinedSetup menus nest their child setups.
    const menu: string[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (p.tagName === T.predefinedSetup) menu.unshift(p.getAttribute("name") ?? "");
    }
    return {
      name: el.getAttribute("name") ?? "",
      file: el.getAttribute("file") ?? "",
      isMenu: el.getAttribute("isMenu") === "true",
      useFile: el.getAttribute("useFile") === "true",
      menu,
    };
  });
}

function parseWidget(el: Element, category?: SlotCategory, source?: string): WidgetNode {
  const node: WidgetNode = {
    name: el.getAttribute("entryName") ?? el.getAttribute("name") ?? el.getAttribute("text") ?? "",
    kind: shortName(el.tagName),
    // Hidden PieceWindows (hidden="true") stay in the tree so
    // PlaceMarker paths resolve through them, but the palette must not show them.
    hidden: el.getAttribute("hidden") === "true" || undefined,
    children: [],
    slots: [],
    category,
    source,
  };
  for (const child of Array.from(el.children)) {
    const tag = child.tagName;
    if (tag === T.pieceSlot || tag === T.cardSlot) {
      node.slots.push(parseSlot(child, category, source));
    } else if (CONTAINER_WIDGETS.has(tag)) {
      node.children.push(parseWidget(child, category, source));
    }
  }
  return node;
}

function parseSlot(el: Element, category?: SlotCategory, source?: string): PieceSlotDef {
  return {
    name: el.getAttribute("entryName") ?? "",
    gpid: el.getAttribute("gpid") ?? "",
    width: parseInt(el.getAttribute("width") ?? "0", 10) || 0,
    height: parseInt(el.getAttribute("height") ?? "0", 10) || 0,
    def: el.textContent ?? "",
    category,
    source,
  };
}

function firstChild(el: Element, tag: string): Element | null {
  for (const c of Array.from(el.children)) if (c.tagName === tag) return c;
  return null;
}

function shortName(tag: string): string {
  return tag.substring(tag.lastIndexOf(".") + 1);
}

function classifyExtensionCategory(sourceName: string): SlotCategory {
  const leaf = sourceName.substring(sourceName.lastIndexOf("/") + 1);
  if (/terrain/i.test(leaf)) return "terrain";
  if (/(game setup|trays?|cards?|open war|to cards?|deployment)/i.test(leaf)) return "aids";
  return "models";
}
