import "./ui/style.css";
import { ModuleArchive } from "./vmod/zip";
import { boardKey, cssColor, parseBuildFile, parseExtension, applyExtension, applyExtensionBoards, type BoardDef, type DiceButtonDef, type MapDef, type ModuleModel, type PieceSlotDef, type WidgetNode } from "./vmod/buildfile";
import { summarizeToolbar } from "./vmod/toolbar-defs";
import { ModuleToolbar } from "./ui/ModuleToolbar";
import { mergeModuleInto } from "./vmod/buildfile";
import { applyPredefinedSetupBoards } from "./vmod/predefined-setups";
import { buildPiece, setPrototypes } from "./vmod/piece-type";
import { parseBoardArchive } from "./vmod/board-archive";
import { archiveKind, buildFileEntry, expandBundle, type BundleBoard } from "./vmod/bundle";
import { drawFromDeck, instantiateDecks, shuffleDeck, type DeckState } from "./model/deck";
import { setGlobalProperties } from "./model/globals";
import { htmlLabelImage } from "./board/html-label";
import { HexGridModel } from "./vmod/hexgrid";
import { readVassalSave, writeVassalSave, parseBoardPickerCommand, type MapImportState } from "./vmod/vsav";
import { ImageStore, type ImageSource } from "./board/images";
import { MapWindow, type PointerTool } from "./board/MapWindow";
import { pieceHalfExtent, pieceShapeHalfExtent } from "./board/render";
import { Palette } from "./ui/Palette";
import { PiecePreview } from "./ui/PiecePreview";
import { Toolbar } from "./ui/Toolbar";
import { BoardPickerDialog } from "./ui/BoardPickerDialog";
import { findOrCreatePickerBoard } from "./vmod/boardpicker";
import { ContextMenu } from "./ui/ContextMenu";
import { Chatter, type CardPreview } from "./ui/Chatter";
import { WindowManager } from "./ui/wm/WindowManager";
import { OverviewMap } from "./ui/OverviewMap";
import { NotesWindow, loadPlayerId } from "./ui/NotesWindow";
import { ChartWindowView } from "./ui/ChartWindowView";
import { TurnTrackerView } from "./ui/TurnTrackerView";
import { emptyNotes, flattenNotes, notesSummary, type NotesState, type SecretNote } from "./vmod/notes";
import { decodeTurnCommand, encodeTurnCommand, formatTurn, initialTurnState, nextTurn, prevTurn, turnLevelValues, TURN_PREFIX, type TurnState } from "./vmod/turn";
import type { ToolbarItemDef, TurnTrackerDef } from "./vmod/toolbar-defs";
import { installKeymap } from "./input/keymap";
import type { GamePiece, KeyCommand } from "./model/piece";

interface CardDeckState {
  id: string;
  name: string;
  slots: PieceSlotDef[];
  remaining: PieceSlotDef[];
}

interface MapState {
  boardImage: string | null;
  pieces: GamePiece[];
  /** Live DrawPile decks on this map (instantiated at new-game setup). */
  decks: DeckState[];
}

/**
 * One bundled-module entry of `public/modules/presets.json` — pure data, so
 * dropping a new module under public/modules/ needs no code change (edit the
 * JSON by hand or run `npm run presets`).
 */
interface PresetDef {
  name: string;
  detail: string;
  files: string[];
  pieceScale?: number;
  /** Directory of lazy board archives under public/modules/ (has manifest.json). */
  boards?: string;
  /** Board names to auto-select, tried in order (exact name, then substring). */
  defaultBoards?: string[];
}

class App {
  private archives: ModuleArchive[] = [];
  private model!: ModuleModel;
  private prototypes = new Map<string, string>();
  private images!: ImageStore;
  private map!: MapWindow;
  private toolbar!: Toolbar;
  private chatter!: Chatter;
  private currentMap!: MapDef;
  private mapStates = new Map<string, MapState>();
  private cardDecks: CardDeckState[] = [];
  private pieceScale = 1;
  /** Loader-provided board preference (preset data / ?board= URL param). */
  private defaultBoards: string[] = [];
  private preservedSaveCommands: string[] = [];
  private notes: NotesState = emptyNotes();
  private wm!: WindowManager;
  private overview: OverviewMap | null = null;
  private notesWindow: NotesWindow | null = null;
  private turnView: TurnTrackerView | null = null;
  /** Rendered ChartWindow contents, keyed by window name (built on first open). */
  private chartViews = new Map<string, ChartWindowView>();
  private turnState: TurnState | null = null;
  private preview: PiecePreview | null = null;
  /** Base URL of the preset's lazy board-archive directory, if it has one. */
  private boardsUrl: string | null = null;
  private loadingBoards = new Set<string>();
  /** Board archives carried inside a dropped bundle zip, by file name. */
  private localBoardFiles = new Map<string, Uint8Array>();
  /** Stable window id -> opener, so toolbar/debug can open windows by id. */
  private windowOpeners = new Map<string, () => void>();

  /**
   * Load any mix of modules and extensions. Files are classified by the root
   * element of their buildFile (`GameModule` vs `ModuleExtension`) rather than
   * by filename — some modules' extensions ship with no file extension. Multiple modules
   * are merged (palettes, maps and prototypes combined) for hotseat play.
   */
  async loadFiles(
    files: { name: string; data: Uint8Array }[],
    opts: { pieceScale?: number; boardsUrl?: string; defaultBoards?: string[] } = {},
  ): Promise<void> {
    const opened = await Promise.all(
      files.map(async (f) => {
        const arc = await ModuleArchive.open(f.data);
        return { name: f.name, arc, kind: archiveKind(arc) };
      }),
    );
    // A plain zip that isn't itself a module/extension is treated as a
    // bundle: its nested module/extension archives load as if the player had
    // multi-selected them, and a boards/ folder becomes lazy board archives.
    const expanded: typeof opened = [];
    const bundleBoards: BundleBoard[] = [];
    for (const o of opened) {
      if (o.kind !== "unknown") {
        expanded.push(o);
        continue;
      }
      const inner = await expandBundle(o.arc);
      if (inner.archives.length === 0 && inner.boards.length === 0) {
        expanded.push(o); // genuinely unknown; kept so the error below names it
        continue;
      }
      expanded.push(...inner.archives);
      bundleBoards.push(...inner.boards);
    }
    const modules = expanded.filter((o) => o.kind === "module");
    const extensions = expanded.filter((o) => o.kind === "extension");
    if (modules.length === 0) {
      throw new Error(
        "No VASSAL module found. Provide at least one .vmod — either directly, or inside a bundle zip (module + extensions + optional boards/).",
      );
    }

    this.archives = expanded.map((o) => o.arc);
    this.localBoardFiles.clear();
    this.mapStates.clear();
    this.cardDecks = [];
    this.preservedSaveCommands = [];
    this.notes = emptyNotes();
    this.pieceScale = opts.pieceScale ?? 1;
    this.defaultBoards = opts.defaultBoards ?? [];
    this.model = parseBuildFile(modules[0].arc.text(buildFileEntry(modules[0].arc)));
    this.prototypes = new Map(this.model.prototypes);

    // Merge any additional modules into the primary one.
    for (const m of modules.slice(1)) {
      try {
        const other = parseBuildFile(m.arc.text(buildFileEntry(m.arc)));
        mergeModuleInto(this.model, other);
        for (const [k, v] of other.prototypes) this.prototypes.set(k, v);
      } catch (e) {
        console.error("module merge failed:", m.name, e);
      }
    }

    // Graft extension rosters into the palette + merge their prototypes.
    for (const e of extensions) {
      try {
        const ext = parseExtension(e.arc.text(buildFileEntry(e.arc)), e.name);
        if (this.model.palette) applyExtension(this.model.palette, ext);
        applyExtensionBoards(this.model.maps, ext);
        this.model.predefinedSetups.push(...ext.predefinedSetups);
        for (const [k, v] of ext.prototypes) this.prototypes.set(k, v);
      } catch (err) {
        console.error("extension load failed:", e.name, err);
      }
    }
    applyPredefinedSetupBoards(this.model.maps, this.model.predefinedSetups, modules[0].arc);
    setPrototypes(this.prototypes);
    setGlobalProperties(this.model.globalProperties);

    // New-game setup: instantiate each map's DrawPile decks and place its
    // SetupStack pieces (many modules keep their whole counter mix here).
    for (const m of this.model.maps) {
      const st = this.stateFor(m);
      st.decks = instantiateDecks(m);
      for (const ss of m.setupStacks ?? []) {
        for (const slot of ss.slots) {
          try {
            const piece = buildPiece(slot.def);
            // Java SetupStack.setup: position translates by the owning
            // board's origin, which is the map's edge buffer.
            piece.x = ss.x + (m.edgeWidth ?? 0);
            piece.y = ss.y + (m.edgeHeight ?? 0);
            piece.mapId = m.name;
            piece.paletteCategory = slot.category ?? null;
            st.pieces.push(piece);
          } catch (err) {
            console.error("setup stack piece failed:", ss.name, err);
          }
        }
      }
    }

    // Lazy board-archive directory: the module ships no boards; a manifest
    // lists the bundled board archives, loaded on demand when picked.
    this.boardsUrl = opts.boardsUrl ?? null;
    if (this.boardsUrl) {
      try {
        const res = await fetch(new URL("manifest.json", this.boardsUrl));
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const manifest: Array<{ file: string; name: string }> = await res.json();
        const map = this.model.maps[0];
        if (map) {
          for (const b of manifest) {
            map.boards.push({ id: b.file, name: b.name, image: "", reversible: false, archiveFile: b.file });
          }
        }
      } catch (err) {
        console.error("board manifest load failed:", err);
      }
    }

    // Boards carried inside a bundle zip: register like manifest boards, but
    // resolve from memory instead of a fetch when picked.
    if (bundleBoards.length) {
      const map = this.model.maps[0];
      for (const b of bundleBoards) {
        this.localBoardFiles.set(b.file, b.bytes);
        map?.boards.push({ id: b.file, name: b.name, image: "", reversible: false, archiveFile: b.file });
      }
    }

    document.title = `${this.model.name} — VASSAL Browser`;
    this.buildUI();
  }

  /** Composite image source across the base module + all extensions. */
  private imageSource(): ImageSource {
    return { imageUrl: (n) => {
      for (const a of this.archives) { const u = a.imageUrl(n); if (u) return u; }
      return null;
    } };
  }

  private buildUI(): void {
    const app = document.getElementById("app")!;
    app.innerHTML = "";
    app.classList.add("loaded");
    // On phone widths the side panels are slide-over drawers: start closed so
    // the table gets the full screen.
    if (window.innerWidth <= 860) app.classList.add("hide-left", "hide-right");

    const imgSource = this.imageSource();
    this.images = new ImageStore(this.archives, () => this.map?.requestDraw());

    // Layout: toolbar on top, palette left, map right.
    this.currentMap = this.model.maps[0];
    this.toolbar = new Toolbar(this.model.maps, {
      onSelectMap: (m) => this.switchMap(m),
      onSelectBoard: (img) => this.setCurrentBoard(img || null),
      onOpenBoardPicker: () => this.openBoardPicker(),
      onSelectScenario: (file) => this.applyScenario(file),
      onSetInteractionLayer: (layer) => this.map.setInteractionLayer(layer),
      onSetPointerTool: (tool) => this.map.setPointerTool(tool),
      onZoom: (f) => this.zoomStep(f),
      onToggleLock: () => this.toggleLock(),
      onToggleMeasure: () => {
        this.map.setMeasureMode(!this.map.isMeasuring());
        this.toolbar.setMeasuring(this.map.isMeasuring());
      },
      onToggleLeftPanel: () => app.classList.toggle("hide-left"),
      onToggleRightPanel: () => app.classList.toggle("hide-right"),
      onDeleteSelected: () => this.deleteSelected(),
      onMarkMoved: () => this.markMoved(),
      onClearMoved: () => this.clearMoved(),
      onSaveGame: () => this.saveGame(),
      onLoadGame: () => this.pickAndLoadGame(),
    });

    const moduleToolbar = new ModuleToolbar(
      this.model.toolbar,
      imgSource,
      { notes: true, turnTracker: true },
      {
        onOpenNotes: () => this.toggleNotes(),
        onOpenTurnTracker: () => this.toggleTurnTracker(),
        onOpenOverview: () => this.toggleOverview(),
        onSwitchMap: (mapName) => {
          const m = this.model.maps.find((x) => x.name === mapName || x.buttonName === mapName);
          if (m) this.switchMap(m);
        },
        onRollDice: (d) => this.rollDiceButton(d),
        onTogglePalette: () => app.classList.toggle("hide-left"),
        onOpenChartWindow: (item) => this.toggleChartWindow(item),
      },
    );
    app.appendChild(moduleToolbar.el);
    app.appendChild(this.toolbar.el);

    const body = document.createElement("div");
    body.className = "body";
    app.appendChild(body);

    const paletteHost = document.createElement("div");
    paletteHost.className = "palette-host";
    body.appendChild(paletteHost);
    this.preview = new PiecePreview(this.images, {
      onPlace: (slot) => this.placePiece(slot),
      onDrop: (slot, clientX, clientY) => this.placePieceAt(slot, clientX, clientY),
    });
    const palette = new Palette(
      this.model.palette,
      imgSource,
      {
        onSelect: (slot) => this.preview!.show(slot),
        onPlace: (slot) => this.placePiece(slot),
      },
      this.images,
    );
    paletteHost.append(palette.el, this.preview.el);

    const mapHost = document.createElement("div");
    mapHost.className = "map-host";
    body.appendChild(mapHost);

    this.chatter = new Chatter();
    this.chatter.setDiceButtons(this.model.diceButtons);
    // DR/dr dice row when the module declares a dice-bot component.
    this.chatter.setDiceBotRow(this.model.hasDiceBot);
    this.chatter.setAreas(
      this.model.maps.map((m) => ({ id: m.name, name: m.name })),
      (id) => {
        const m = this.model.maps.find((map) => map.name === id);
        if (!m) return;
        this.toolbar.setCurrentMap(m.name);
        this.toolbar.setBoards(m);
        this.switchMap(m);
      },
    );
    this.cardDecks = collectCardDecks(this.model.palette);
    this.chatter.setCardDecks(
      this.cardDecks.map((d) => ({ id: d.id, name: d.name, count: d.remaining.length })),
      (deckId) => this.drawCard(deckId, imgSource),
    );
    body.appendChild(this.chatter.el);

    this.wm = new WindowManager(app);
    this.overview = null;
    this.notesWindow = null;
    this.turnView = null;
    this.turnState = null;
    this.windowOpeners = new Map([
      ["overview", () => this.toggleOverview()],
      ["notes", () => this.toggleNotes()],
      ["turn-tracker", () => this.toggleTurnTracker()],
    ]);
    this.chartViews.clear();
    for (const item of this.model.toolbar) {
      if (item.kind === "chartWindow") {
        this.windowOpeners.set(`charts:${item.name}`, () => this.toggleChartWindow(item));
      }
    }
    this.images.addListener(() => this.overview?.refresh());

    this.map = new MapWindow(mapHost, this.images, {
      onSelect: (p, count) => this.toolbar.setSelection(
        p ? p.name() : null,
        this.selectedPieces().some((piece) => piece.isImmobile()),
        this.selectedPieces().some((piece) => piece.movedStatus()),
        count,
      ),
      onContextMenu: (p, x, y) => ContextMenu.show(p, x, y, (cmd) => this.runCommand(p, cmd), this.mapTransferCommands()),
      onDeckPickUp: (id, x, y) => this.deckDraw(id, x, y),
      onDeckMenu: (id, cx, cy) => this.deckMenu(id, cx, cy),
      onChange: () => this.map.requestDraw(),
      onViewChanged: () => this.overview?.refresh(),
      // Map moveWithinFormat: "$pieceName$ moves $previousLocation$ -> $location$ *"
      onMoved: (p, from, to) => this.chatter.add(`${p.name()} moves ${from} -> ${to} *`),
    });
    this.map.setPieceScale(this.pieceScale);
    this.toolbar.setScenarios(this.scenarioSetups());
    this.switchMap(this.currentMap);

    installKeymap({
      getSelected: () => this.map.getSelected(),
      run: (p, cmd) => this.runCommand(p, cmd),
      deleteSelected: () => this.deleteSelected(),
    });

    // Default board: the loader-provided preference (preset data / ?board=),
    // each entry tried as exact name then substring; else Java BoardPicker
    // parity — auto-pick only a map's single non-reversible board.
    const boards = this.currentMap.boards;
    let defaultBoard: BoardDef | undefined;
    for (const want of this.defaultBoards) {
      defaultBoard = boards.find((b) => b.name === want)
        ?? boards.find((b) => b.name.toLowerCase().includes(want.toLowerCase()));
      if (defaultBoard) break;
    }
    if (!defaultBoard && boards.length === 1 && !boards[0].reversible) defaultBoard = boards[0];
    // Java BoardPicker.getDefaultSetup(): a <setup> command inside the picker
    // pre-places the boards at fixed cells, so the game-start prompt is
    // skipped (isFinished() === true) — apply it instead of opening the dialog.
    if (!defaultBoard && this.currentMap.boardPicker?.defaultSetup) {
      const parsed = parseBoardPickerCommand(this.currentMap.boardPicker.defaultSetup);
      const fixed = parsed ? findOrCreatePickerBoard(this.currentMap, parsed.tiles) : null;
      if (fixed) defaultBoard = fixed;
    }
    if (defaultBoard) {
      // The composed default board may not be in the dropdown yet.
      this.toolbar.setBoards(this.currentMap);
      this.toolbar.selectBoardByName(defaultBoard.name);
    }
    // Java BoardPicker.setup(true): with no default setup and several
    // possible boards, prompt for the board grid at game start.
    else if (this.currentMap.boardPicker && boards.length > 1) {
      queueMicrotask(() => this.openBoardPicker());
    }

    // Debug hook for automated verification (harmless in production).
    (window as unknown as { __vb: unknown }).__vb = {
      map: () => this.map,
      maps: () => this.model.maps.map((m) => ({
        name: m.name,
        buttonName: m.buttonName,
        boards: m.boards.map((b) => b.name),
        boardDetails: m.boards.map(boardDebugInfo),
      })),
      currentMap: () => this.currentMap.name,
      currentBoard: () => this.stateFor(this.currentMap).boardImage,
      currentBoardInfo: () => {
        const key = this.stateFor(this.currentMap).boardImage;
        const board = key ? this.currentMap.boards.find((b) => boardKey(b) === key) : null;
        return board ? boardDebugInfo(board) : null;
      },
      selectBoard: (name: string) => {
        const board = this.currentMap.boards.find((b) => b.name === name || boardKey(b) === name);
        if (!board) return false;
        this.setCurrentBoard(boardKey(board));
        return true;
      },
      switchMap: (name: string) => {
        const m = this.model.maps.find((map) => map.name === name || map.buttonName === name);
        if (!m) return false;
        this.switchMap(m);
        return true;
      },
      pieceCount: () => this.map.pieceCount(),
      selectedName: () => this.map.getSelected()?.name() ?? null,
      selectedNames: () => this.map.getSelectedPieces().map((p) => p.name()),
      selectedRotation: () => this.map.getSelected()?.rotationDegrees() ?? null,
      selectedLayers: () => this.map.getSelected()?.activeLayers().map((l) => l.name) ?? [],
      selectedCommands: () => this.map.getSelected()?.keyCommands().map((c) => c.name).filter(Boolean) ?? [],
      selectedClientPos: () => { const p = this.map.getSelected(); return p ? this.map.clientPosOf(p) : null; },
      zoom: (f: number) => this.map.zoomBy(f),
      selectedLayer: () => this.map.getSelected()?.layerName() ?? null,
      toggleMeasure: () => { this.map.setMeasureMode(!this.map.isMeasuring()); this.toolbar.setMeasuring(this.map.isMeasuring()); },
      setMeasure: (sx: number, sy: number, ex: number, ey: number) => {
        this.map.setMeasure({ x: sx, y: sy }, { x: ex, y: ey });
        this.toolbar.setMeasuring(this.map.isMeasuring());
      },
      measureInfo: () => this.map.measureInfo(),
      pieces: () => this.map.piecesSnapshot(),
      setPiecePos: (name: string, x: number, y: number) => {
        const p = this.map.findPiece(name);
        if (!p) return false;
        this.map.setPiecePosition(p, x, y);
        return true;
      },
      setSelectedPos: (x: number, y: number) => {
        const p = this.map.getSelected();
        if (!p) return false;
        this.map.setPiecePosition(p, x, y);
        return true;
      },
      selectPiece: (name: string) => {
        const p = this.map.findPiece(name);
        if (!p) return false;
        this.map.select(p);
        return true;
      },
      setInteractionLayer: (layer: Parameters<MapWindow["setInteractionLayer"]>[0]) => this.map.setInteractionLayer(layer),
      setPointerTool: (tool: PointerTool) => { this.map.setPointerTool(tool); this.toolbar.setPointerTool(tool, false); },
      selectedCount: () => this.map.getSelectedPieces().length,
      deleteSelected: () => this.deleteSelected(),
      markMoved: () => this.markMoved(),
      clearMoved: () => this.clearMoved(),
      runCommand: (name: string) => this.runCommandByName(name),
      roll: (expr: string) => this.chatter.roll(expr),
      chatLog: () => this.chatter.log(),
      diceButtons: () => this.model.diceButtons.map((b) => ({ ...b })),
      cardDecks: () => this.cardDecks.map((d) => ({ id: d.id, name: d.name, count: d.remaining.length, total: d.slots.length })),
      decks: () => this.stateFor(this.currentMap).decks.map((d) => ({ id: d.id, name: d.def.name, count: d.remaining.length, x: d.def.x, y: d.def.y, faceDown: d.faceDown })),
      labelDebug: () => {
        const p = this.map.getSelected();
        if (!p) return "no-selection";
        const views = p.labelViews().map((v) => ({ html: v.html ? v.html.length : 0, text: v.text ? v.text.length : 0, placement: v.placement }));
        const v = p.labelViews().find((vv) => vv.html);
        if (!v?.html) return { views };
        const e = htmlLabelImage(v.html, () => this.map.requestDraw());
        return { views, entry: e ? { ready: e.ready, w: e.width, h: e.height } : null };
      },
      deckDraw: (id: string) => this.deckDraw(id) != null,
      moveSelectedToMap: (name: string) => {
        const m = this.model.maps.find((mm) => mm.name === name || mm.buttonName === name);
        return m ? this.moveSelectedToMap(m) : false;
      },
      drawCard: (deckId: string) => this.drawCard(deckId, imgSource),
      preservedSaveCommands: () => [...this.preservedSaveCommands],
      /** @deprecated flattened note texts; use notesState() */
      savedNotes: () => flattenNotes(this.notes),
      notesState: () => ({
        scenario: this.notes.scenario,
        publicNotes: this.notes.publicNotes,
        private: Object.fromEntries(this.notes.privateNotes),
        secret: this.notes.secretNotes.map((n: SecretNote) => ({ ...n })),
      }),
      setNote: (kind: "scenario" | "public", text: string) => {
        if (kind === "scenario") this.notes.scenario = text;
        else this.notes.publicNotes = text;
        return true;
      },
      turnState: () => {
        const def = this.turnTrackerDef();
        if (!def || !this.turnState) return null;
        return {
          id: this.turnState.id,
          formatted: formatTurn(def, this.turnState),
          values: turnLevelValues(def, this.turnState),
        };
      },
      turnNext: () => {
        const def = this.turnTrackerDef();
        if (!def) return false;
        nextTurn(def, this.ensureTurnState(def));
        this.turnView?.render();
        return true;
      },
      turnPrev: () => {
        const def = this.turnTrackerDef();
        if (!def) return false;
        prevTurn(def, this.ensureTurnState(def));
        this.turnView?.render();
        return true;
      },
      // Palette preview pane
      previewSlot: (name: string, groups?: string[]) => {
        const slot = this.findSlot(name, groups ?? []);
        if (!slot || !this.preview) return false;
        this.preview.show(slot);
        return true;
      },
      previewInfo: () => this.preview?.info() ?? { slotName: null, hasPixels: false },
      placePreviewed: () => {
        const slot = this.preview?.currentSlot();
        if (!slot) return false;
        this.placePiece(slot);
        return true;
      },
      // In-page save round-trip for verification (base64 to survive JSON eval).
      saveBytes: () => bytesToBase64(this.buildSaveBytes()),
      loadSaveBytes: (b64: string) => this.applyVassalSave(base64ToBytes(b64)),
      // Window manager
      windows: () => this.wm.list(),
      wmMode: () => this.wm.mode(),
      openWindow: (id: string) => {
        const opener = this.windowOpeners.get(id);
        if (!opener) return false;
        if (!this.wm.isOpen(id)) opener();
        return this.wm.isOpen(id);
      },
      closeWindow: (id: string) => this.wm.close(id),
      toolbarButtons: () => summarizeToolbar(this.model.toolbar),
      overviewInfo: () => ({
        open: this.wm.isOpen("overview"),
        ...(this.wm.isOpen("overview") ? this.overview?.info() ?? {} : {}),
      }),
      viewCenter: () => this.map.viewCenterWorld(),
      // Hex grid (null-safe before a gridded board loads)
      gridPresent: () => this.map.grid() != null,
      hexCenter: (hex: string) => {
        try {
          return this.map.hexCenter(hex);
        } catch {
          return null;
        }
      },
      locationOf: (name: string) => {
        const p = this.map.findPiece(name);
        return p ? this.map.locationOf(p) : null;
      },
      selectedLocation: () => {
        const p = this.map.getSelected();
        return p ? this.map.locationOf(p) : null;
      },
      rollDR: (category: string) => this.chatter.rollDR(category),
      rollDr: (category: string) => this.chatter.rollDr(category),
      // Hit/selection shape diagnostics (drag hit-box parity work)
      selectedBounds: () => {
        const p = this.map.getSelected();
        if (!p) return null;
        return {
          shape: pieceShapeHalfExtent(p, this.images, this.pieceScale),
          visual: pieceHalfExtent(p, this.images, this.pieceScale),
          base: p.baseImageName(),
          layers: p.activeLayers().map((l) => {
            const li = this.images.get(l.name);
            return { name: l.name, w: li?.width ?? 0, h: li?.height ?? 0, xOff: l.xOff, yOff: l.yOff, scale: l.scale, underneath: !!l.underneath };
          }),
        };
      },
    };
  }

  /** Roll a module-declared DiceButton through the chatter log. */
  private rollDiceButton(d: DiceButtonDef): void {
    let count = d.nDice;
    if (d.prompt) {
      const raw = window.prompt(`Number of d${d.nSides}`, String(d.nDice));
      if (raw == null) return;
      count = Number.parseInt(raw, 10);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        this.chatter.add(`Invalid roll: ${raw}d${d.nSides}`);
        return;
      }
    }
    this.chatter.rollDice(count, d.nSides, d.plus, d.name || `${count}d${d.nSides}`);
  }

  /**
   * Zoom step: with a module Zoomer, walk its declared levels (Java behavior);
   * without one, apply the free factor.
   */
  private zoomStep(factor: number): void {
    const zoomer = this.currentMap.zoomer;
    if (!zoomer || zoomer.levels.length === 0) {
      this.map.zoomBy(factor);
      return;
    }
    // Levels are ascending: snap to the next declared level in the direction.
    const current = this.map.zoomScale();
    const eps = current * 0.02;
    const target = factor > 1
      ? zoomer.levels.find((l) => l > current + eps) ?? zoomer.levels[zoomer.levels.length - 1]
      : [...zoomer.levels].reverse().find((l) => l < current - eps) ?? zoomer.levels[0];
    this.map.zoomTo(target);
  }

  /** The module's TurnTracker definition, if declared. */
  private turnTrackerDef(): TurnTrackerDef | null {
    const item = this.model.toolbar.find((t) => t.kind === "turnTracker");
    return item?.kind === "turnTracker" ? item.def : null;
  }

  /** Lazily created tracker state (fresh games start at the defined lows). */
  private ensureTurnState(def: TurnTrackerDef): TurnState {
    if (!this.turnState) this.turnState = initialTurnState(def);
    return this.turnState;
  }

  /** Open (or close) the Turn Counter window. */
  private toggleTurnTracker(): void {
    const def = this.turnTrackerDef();
    if (!def) return;
    if (this.wm.isOpen("turn-tracker")) {
      this.wm.close("turn-tracker");
      return;
    }
    this.ensureTurnState(def);
    if (!this.turnView) {
      this.turnView = new TurnTrackerView(def, () => loadPlayerId(), {
        getState: () => this.ensureTurnState(def),
        onAdvanced: (report) => this.chatter.add(report),
      });
    }
    this.turnView.render();
    this.wm.open({
      id: "turn-tracker",
      title: def.buttonText.trim() || def.name || "Turn Counter",
      content: this.turnView.el,
      width: 320,
      height: 240,
      minWidth: 240,
      minHeight: 160,
    });
  }

  /** Open (or close) the VASSAL NotesWindow with capture/Save/Cancel semantics. */
  private toggleNotes(): void {
    if (this.wm.isOpen("notes")) {
      this.wm.close("notes");
      return;
    }
    if (!this.notesWindow) {
      this.notesWindow = new NotesWindow({
        getState: () => this.notes,
        onCommit: (state) => {
          this.notes = state;
          this.chatter.add("Notes updated.");
          this.wm.close("notes");
        },
        onCancel: () => this.wm.close("notes"),
      });
    }
    this.notesWindow.capture();
    const item = this.model.toolbar.find((t) => t.kind === "notes");
    this.wm.open({
      id: "notes",
      title: item?.text || "Notes",
      content: this.notesWindow.el,
      width: 430,
      height: 470,
      minWidth: 300,
      minHeight: 280,
    });
  }

  /** Open (or close) a module ChartWindow (quick-reference charts). */
  private toggleChartWindow(item: Extract<ToolbarItemDef, { kind: "chartWindow" }>): void {
    const id = `charts:${item.name}`;
    if (this.wm.isOpen(id)) {
      this.wm.close(id);
      return;
    }
    let view = this.chartViews.get(item.name);
    if (!view) {
      view = new ChartWindowView(item.charts, this.imageSource());
      this.chartViews.set(item.name, view);
    }
    this.wm.open({
      id,
      title: item.text || item.name,
      content: view.el,
      width: 720,
      height: 520,
      minWidth: 320,
      minHeight: 240,
    });
  }

  /** Open (or close, if open) the GlobalMap-style overview window. */
  private toggleOverview(): void {
    if (!this.overview) this.overview = new OverviewMap(() => this.map);
    this.wm.toggle("overview", () => ({
      id: "overview",
      title: "Overview",
      content: this.overview!.el,
      width: 300,
      height: 250,
      minWidth: 180,
      minHeight: 140,
    }));
    this.overview.refresh();
  }

  /** Test/scripting helper: run the selected piece's named command. */
  private runCommandByName(name: string): boolean {
    const p = this.map.getSelected();
    if (!p) return false;
    const cmd = p.keyCommands().find((c) => c.name === name);
    if (!cmd) return false;
    this.runCommand(p, cmd);
    return true;
  }

  private switchMap(m: MapDef): void {
    this.currentMap = m;
    const state = this.stateFor(m);
    this.toolbar.setCurrentMap(m.name);
    this.toolbar.setBoards(m);
    this.toolbar.setBoardImage(state.boardImage);
    this.map.setBoardDefs(m.boards);
    this.map.setLayerOrder(m.layerOrder);
    this.map.setLosThread(m.losThread ?? null);
    this.map.setStackMetrics(m.stackMetrics ?? null);
    this.map.setBoardOrigin(m.edgeWidth ?? 0, m.edgeHeight ?? 0);
    this.map.setPieces(state.pieces);
    this.map.setBoard(state.boardImage);
    this.applyBoardGrid(state.boardImage);
    this.refreshDecks();
    // A save import can select a lazy board archive that was never fetched.
    const board = state.boardImage ? m.boards.find((b) => boardKey(b) === state.boardImage) : null;
    if (board?.archiveFile && !board.image) void this.loadBoardArchive(board, state.boardImage!);
    else if (board?.tiles?.some((t) => t.archiveFile && !t.image)) void this.loadBoardTileArchives(board, state.boardImage!);
  }

  private setCurrentBoard(imageName: string | null): void {
    const board = imageName ? this.currentMap.boards.find((b) => boardKey(b) === imageName) : null;
    if (board?.archiveFile && !board.image) {
      void this.loadBoardArchive(board, imageName!);
      return;
    }
    if (board?.tiles?.some((t) => t.archiveFile && !t.image)) {
      void this.loadBoardTileArchives(board, imageName!);
      return;
    }
    const state = this.stateFor(this.currentMap);
    state.boardImage = imageName;
    this.toolbar.setBoardImage(imageName);
    this.map.setBoard(imageName);
    this.applyBoardGrid(imageName);
  }

  /**
   * Open the stock BoardPicker grid dialog for the current map: pick several
   * boards into cells (add row/column), flip reversible ones, OK composes
   * them into one multi-board layout (same rendering as a saved layout).
   */
  private openBoardPicker(): void {
    const map = this.currentMap;
    const def = map.boardPicker;
    if (!def) return;
    const state = this.stateFor(map);
    const cur = state.boardImage ? map.boards.find((b) => boardKey(b) === state.boardImage) : null;
    const initial = cur?.tiles
      ? cur.tiles.map((t) => ({ boardName: t.boardName, x: t.x, y: t.y, reversed: !!t.reversed }))
      : null;
    BoardPickerDialog.open(def, map, initial, {
      onApply: (tiles) => {
        if (!tiles.length) {
          this.setCurrentBoard(null);
          this.chatter.add("Boards cleared.");
          return;
        }
        const board = findOrCreatePickerBoard(map, tiles);
        if (!board) return;
        this.toolbar.setBoards(map);
        this.setCurrentBoard(boardKey(board));
        this.chatter.add(`Boards: ${tiles.map((t) => t.boardName).join(", ")}`);
      },
      onCancel: () => {},
    }, (entry) => this.imageSource().imageUrl(entry));
  }

  /** Attach the active board's hex grid, if any, to the map window. */
  private applyBoardGrid(imageName: string | null): void {
    const board = imageName ? this.currentMap.boards.find((b) => boardKey(b) === imageName) : null;
    this.map.setGrid(board?.grid ? new HexGridModel(board.grid) : null);
  }

  /**
   * Multi-board `bd` layout: fetch every tile's board archive, then anchor
   * the first tile's grid over the whole layout — geomorphic boards tile
   * exactly (1800px = 32 columns, 645px = 10 rows), so one grid snaps every
   * cell; cropped tiles drift at the seam (known simplification).
   */
  private async loadBoardTileArchives(board: BoardDef, key: string): Promise<void> {
    if (this.loadingBoards.has(key)) return;
    this.loadingBoards.add(key);
    this.chatter.add(`Loading boards ${board.name}…`);
    try {
      let grid: BoardDef["grid"];
      for (const tile of board.tiles ?? []) {
        if (!tile.archiveFile || tile.image) continue;
        const local = this.localBoardFiles.get(tile.archiveFile);
        if (!local && !this.boardsUrl) continue;
        const bytes = local ?? (await fetchBytes(new URL(tile.archiveFile, this.boardsUrl!).toString()));
        const arc = await ModuleArchive.open(bytes);
        const info = parseBoardArchive(arc, tile.archiveFile);
        this.archives.push(arc);
        tile.image = info.imageEntry;
        grid ??= info.grid;
      }
      this.images.clearMissing();
      if (grid && !board.grid) board.grid = grid;
      this.chatter.add(`Boards ready (${board.name}).`);
      this.setCurrentBoard(key);
    } catch (err) {
      this.chatter.add(`Failed to load boards ${board.name}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.loadingBoards.delete(key);
    }
  }

  /**
   * Fetch + open a board archive, graft its image/grid onto the BoardDef,
   * and re-select it. The archive joins the image-source list so the board GIF
   * (and overlay art) resolves like any module image.
   */
  private async loadBoardArchive(board: BoardDef, key: string): Promise<void> {
    const local = this.localBoardFiles.get(board.archiveFile ?? "");
    if ((!this.boardsUrl && !local) || this.loadingBoards.has(key)) return;
    this.loadingBoards.add(key);
    this.chatter.add(`Loading board ${board.name}…`);
    try {
      const bytes = local ?? (await fetchBytes(new URL(board.archiveFile!, this.boardsUrl!).toString()));
      const arc = await ModuleArchive.open(bytes);
      const info = parseBoardArchive(arc, board.archiveFile!);
      this.archives.push(arc);
      this.images.clearMissing();
      board.image = info.imageEntry;
      board.grid = info.grid;
      this.chatter.add(`Board ${info.name} ready (${info.widthHexes}×${info.heightHexes} hexes).`);
      this.setCurrentBoard(key);
    } catch (err) {
      this.chatter.add(`Failed to load board ${board.name}: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.loadingBoards.delete(key);
    }
  }

  private stateFor(map: MapDef): MapState {
    let state = this.mapStates.get(map.name);
    if (!state) {
      state = { boardImage: null, pieces: [], decks: [] };
      this.mapStates.set(map.name, state);
    }
    return state;
  }

  private placePiece(slot: PieceSlotDef): void {
    const c = this.map.viewCenterWorld();
    this.placePieceCore(slot, c.x, c.y);
  }

  /** Drop from the preview drag ghost: only when released over the map canvas. */
  private placePieceAt(slot: PieceSlotDef, clientX: number, clientY: number): void {
    const r = this.map.canvas.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return;
    const w = this.map.clientToWorld(clientX, clientY);
    this.placePieceCore(slot, w.x, w.y);
  }

  private placePieceCore(slot: PieceSlotDef, x: number, y: number): void {
    const piece = buildPiece(slot.def);
    piece.paletteCategory = slot.category ?? null;
    piece.x = x;
    piece.y = y;
    piece.mapId = this.currentMap.name;
    this.map.addPiece(piece);
    // Map createFormat: "$pieceName$ created in $location$ *"
    const loc = this.map.locationOf(piece);
    this.chatter.add(loc
      ? `${piece.name()} created in ${loc} *`
      : `Placed ${piece.name()} on ${this.currentMap.name}.`);
  }

  /**
   * Depth-first slot lookup by exact entry name (debug/verifier). Optional
   * `groups` restricts matches to slots whose ancestor groups contain the
   * given names in order (e.g. ["Axis O/B","German"] for the German 4-6-8).
   */
  private findSlot(name: string, groups: string[] = []): PieceSlotDef | null {
    const walk = (node: WidgetNode, matched: number): PieceSlotDef | null => {
      const next = matched < groups.length && node.name === groups[matched] ? matched + 1 : matched;
      if (next >= groups.length) {
        for (const slot of node.slots) if (slot.name === name) return slot;
      }
      for (const child of node.children) {
        const found = walk(child, next);
        if (found) return found;
      }
      return null;
    };
    return this.model.palette ? walk(this.model.palette, 0) : null;
  }

  /** Run a command, then resolve any delete/clone/place/report it requested. */
  private runCommand(piece: GamePiece, cmd: KeyCommand): void {
    cmd.perform();
    this.flushPieceEffects(piece);
    if (piece.pendingDelete) {
      piece.pendingDelete = false;
      this.deletePiece(piece);
      return;
    }
    if (piece.pendingClone) {
      piece.pendingClone = false;
      const copy = buildPiece(piece.sourceDef);
      copy.x = piece.x + 24;
      copy.y = piece.y + 24;
      copy.mapId = piece.mapId;
      copy.paletteCategory = piece.paletteCategory;
      this.map.addPiece(copy);
      this.chatter.add(`Cloned ${piece.name()}.`);
    }
    this.map.requestDraw();
    // refresh lock label in case it changed
    this.refreshSelectionToolbar();
  }

  /** Consume trait-queued reports and PlaceMarker/Replace/PlaceDM spawns. */
  private flushPieceEffects(piece: GamePiece): void {
    for (const line of piece.pendingReports.splice(0)) {
      const loc = this.map.locationOf(piece) ?? this.currentMap.name;
      this.chatter.add(line.replace(/\$(location|newLocation|oldLocation)\$/g, loc).trim());
    }
    for (const pl of piece.pendingPlacements.splice(0)) {
      const def = this.resolvePlacementDef(pl.spec);
      if (!def) continue;
      const marker = buildPiece(def);
      marker.mapId = piece.mapId;
      marker.paletteCategory = piece.paletteCategory;
      marker.x = pl.replaceSelf ? piece.x : piece.x + pl.dx;
      marker.y = pl.replaceSelf ? piece.y : piece.y + pl.dy;
      this.map.addPiece(marker, pl.replaceSelf);
      const loc = this.map.locationOf(marker);
      this.chatter.add(`${marker.name() || "Marker"} placed${loc ? ` in ${loc}` : ""}.`);
      if (pl.replaceSelf) this.deletePiece(piece);
    }
  }

  /**
   * PlaceMarker.createBaseMarker: markerSpec is either an inline AddPiece
   * (`+/id/type/state`) or a component path whose last segment names a
   * palette PieceSlot.
   */
  private resolvePlacementDef(spec: string): string | null {
    if (spec.startsWith("+")) return spec;
    const m = /PieceSlot:(.+)$/.exec(spec);
    const slot = m ? this.findSlot(m[1]) : null;
    return slot?.def ?? null;
  }

  private toggleLock(): void {
    const selected = this.selectedPieces();
    if (!selected.length) return;
    const shouldLock = selected.some((p) => !p.userLocked);
    for (const p of selected) p.userLocked = shouldLock;
    this.refreshSelectionToolbar();
    this.map.requestDraw();
  }

  private deleteSelected(): boolean {
    const selected = this.selectedPieces();
    if (!selected.length) return false;
    for (const p of selected) this.deletePiece(p);
    return true;
  }

  private deletePiece(piece: GamePiece): void {
    this.map.removePiece(piece);
    this.chatter.add(`Deleted ${piece.name()}.`);
  }

  private markMoved(): boolean {
    const selected = this.selectedPieces();
    if (!selected.length) return false;
    for (const p of selected) this.map.markMoved(p);
    this.refreshSelectionToolbar();
    return true;
  }

  private clearMoved(): boolean {
    const selected = this.selectedPieces();
    if (!selected.length) return false;
    for (const p of selected) this.map.clearMoved(p);
    this.refreshSelectionToolbar();
    return true;
  }

  private selectedPieces(): GamePiece[] {
    return this.map?.getSelectedPieces() ?? [];
  }

  private refreshSelectionToolbar(): void {
    const selected = this.selectedPieces();
    const primary = this.map.getSelected();
    this.toolbar.setSelection(
      primary ? primary.name() : null,
      selected.some((p) => p.isImmobile()),
      selected.some((p) => p.movedStatus()),
      selected.length,
    );
  }

  /** Deck views for the current map, honoring owningBoard visibility. */
  private refreshDecks(): void {
    const state = this.stateFor(this.currentMap);
    const boardName = this.currentBoardName();
    this.map.setDecks(
      state.decks
        .filter((d) => {
          if (!d.def.owningBoard) return true;
          // Hide only when the owning board exists on this map and another
          // board is currently in play (we render one board at a time).
          const owned = this.currentMap.boards.some((b) => b.name === d.def.owningBoard);
          return !owned || boardName === d.def.owningBoard || boardName == null;
        })
        .map((d) => {
          if (!d.topPiece && !d.faceDown && d.remaining.length) {
            try {
              d.topPiece = buildPiece(d.remaining[0].def);
            } catch {
              d.topPiece = null;
            }
          }
          // DrawPile subclasses SetupStack: positions offset by the edge
          // buffer (owning-board origin) like at-start stacks.
          return {
            id: d.id,
            x: d.def.x + (this.currentMap.edgeWidth ?? 0),
            y: d.def.y + (this.currentMap.edgeHeight ?? 0),
            w: d.def.width || 72,
            h: d.def.height || 72,
            count: d.remaining.length,
            name: d.def.name,
            color: cssColor(d.def.color),
            faceDown: d.faceDown,
            topPiece: d.faceDown ? null : d.topPiece,
          };
        }),
    );
  }

  private currentBoardName(): string | null {
    const key = this.stateFor(this.currentMap).boardImage;
    const board = key ? this.currentMap.boards.find((b) => boardKey(b) === key) : null;
    return board?.name ?? null;
  }

  private findDeck(id: string): DeckState | null {
    return this.stateFor(this.currentMap).decks.find((d) => d.id === id || d.def.name === id) ?? null;
  }

  /** Draw the top piece of a map deck onto the table (drag or menu). */
  private deckDraw(id: string, atX?: number, atY?: number): GamePiece | null {
    const deck = this.findDeck(id);
    if (!deck) return null;
    const slot = drawFromDeck(deck);
    if (!slot) return null;
    let piece: GamePiece;
    try {
      piece = buildPiece(slot.def);
    } catch (err) {
      console.error("deck draw failed:", deck.def.name, err);
      return null;
    }
    piece.x = atX ?? deck.def.x + (this.currentMap.edgeWidth ?? 0) + (deck.def.width || 72);
    piece.y = atY ?? deck.def.y + (this.currentMap.edgeHeight ?? 0);
    piece.mapId = this.currentMap.name;
    piece.paletteCategory = slot.category ?? null;
    this.map.addPiece(piece);
    this.chatter.add(`Drew ${slot.name || piece.name() || "a piece"} from ${deck.def.name} (${deck.remaining.length} left).`);
    this.refreshDecks();
    return piece;
  }

  private deckMenu(id: string, clientX: number, clientY: number): void {
    const deck = this.findDeck(id);
    if (!deck) return;
    const commands: KeyCommand[] = [];
    if (deck.remaining.length > 0) {
      commands.push({ name: "Draw", stroke: null, perform: () => this.deckDraw(id) != null });
    }
    if (deck.remaining.length > 1) {
      commands.push({
        name: deck.def.shuffleCommand || "Shuffle",
        stroke: null,
        perform: () => {
          shuffleDeck(deck);
          this.refreshDecks();
          this.chatter.add(`Shuffled ${deck.def.name}.`);
          return true;
        },
      });
    }
    if (!commands.length) return;
    ContextMenu.showCommands(commands, clientX, clientY, (cmd) => {
      cmd.perform();
      this.map.requestDraw();
    });
  }

  /** "Move to map ▸" — sends the selection to another map window. */
  private mapTransferCommands(): KeyCommand[] {
    const targets = this.model.maps.filter((m) => m !== this.currentMap);
    if (!targets.length) return [];
    const label = (m: MapDef) => `→ ${m.buttonName || m.name}`;
    return [
      { name: "Move to map", stroke: null, perform: () => false, subCommands: targets.map(label) },
      ...targets.map((m) => ({
        name: label(m),
        stroke: null,
        perform: () => this.moveSelectedToMap(m),
      })),
    ];
  }

  private moveSelectedToMap(target: MapDef): boolean {
    const pieces = this.selectedPieces();
    if (!pieces.length) return false;
    const st = this.stateFor(target);
    for (const p of pieces) {
      this.map.removePiece(p);
      p.mapId = target.name;
      st.pieces.push(p);
    }
    this.chatter.add(`Moved ${pieces.length} piece(s) to ${target.buttonName || target.name}.`);
    return true;
  }

  private drawCard(deckId: string, source: ImageSource): CardPreview | null {
    const deck = this.cardDecks.find((d) => d.id === deckId || d.name === deckId);
    if (!deck || deck.remaining.length === 0) return null;
    const i = Math.floor(Math.random() * deck.remaining.length);
    const [slot] = deck.remaining.splice(i, 1);
    const piece = buildPiece(slot.def);
    const cardName = slot.name || piece.name() || "Card";
    const imageName = piece.baseImageName();
    return {
      deckName: deck.name,
      cardName,
      remaining: deck.remaining.length,
      imageUrl: imageName ? source.imageUrl(imageName) : null,
    };
  }

  /** Serialize the current game to .vsav bytes (download + in-page tests). */
  private buildSaveBytes(): Uint8Array {
    const turnDef = this.turnTrackerDef();
    return writeVassalSave({
      model: this.model,
      mapStates: this.mapStates as Map<string, MapImportState>,
      preservedCommands: this.preservedSaveCommands,
      notes: this.notes,
      extraCommands: turnDef && this.turnState ? [encodeTurnCommand(turnDef, this.turnState)] : [],
    });
  }

  private saveGame(): void {
    const data = this.buildSaveBytes();
    const blob = new Blob([new Uint8Array(data).buffer], { type: "application/x-vassal-save" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${safeFileName(this.model.name || "vassal-browser")}.vsav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.chatter.add("Saved Java VASSAL-compatible .vsav.");
  }

  private pickAndLoadGame(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vsav,application/x-vassal-save,application/zip";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        this.applyVassalSave(new Uint8Array(await file.arrayBuffer()));
        this.chatter.add(`Loaded VASSAL save ${file.name}.`);
      } catch (err) {
        alert("Failed to load save: " + (err instanceof Error ? err.message : String(err)));
      }
    });
    input.click();
  }

  /** Playable predefined setups: non-menu, file-backed, present in an archive. */
  private scenarioSetups(): { name: string; file: string; menu: string }[] {
    return this.model.predefinedSetups
      .filter((s) => !s.isMenu && s.useFile && s.file)
      .filter((s) => this.archives.some((a) => a.hasEntry(s.file)))
      .map((s) => ({ name: s.name, file: s.file, menu: s.menu.filter(Boolean).join(" / ") }));
  }

  /** Load a predefined-setup scenario: a full `.vsav` embedded in the module. */
  private applyScenario(file: string): void {
    const arc = this.archives.find((a) => a.hasEntry(file));
    const bytes = arc?.bytes(file);
    if (!bytes) {
      this.chatter.add(`Scenario file ${file} not found in the module.`);
      return;
    }
    try {
      const name = this.scenarioSetups().find((s) => s.file === file)?.name ?? file;
      this.applyVassalSave(bytes);
      this.chatter.add(`Scenario loaded: ${name}.`);
    } catch (err) {
      this.chatter.add(`Failed to load scenario: ${err instanceof Error ? err.message : err}`);
    }
  }

  private applyVassalSave(bytes: Uint8Array): boolean {
    const imported = readVassalSave(bytes, this.model);
    // Saves don't carry deck state yet (TODO): keep each map's freshly
    // instantiated decks and adopt the imported board/piece state.
    const merged = new Map<string, MapState>();
    for (const [name, st] of imported.mapStates) {
      merged.set(name, {
        boardImage: st.boardImage,
        pieces: st.pieces,
        decks: this.mapStates.get(name)?.decks ?? [],
      });
    }
    for (const [name, st] of this.mapStates) {
      if (!merged.has(name)) merged.set(name, { boardImage: null, pieces: [], decks: st.decks });
    }
    this.mapStates = merged;
    this.preservedSaveCommands = imported.preservedCommands;
    this.notes = imported.notes;

    // Adopt the tracker state from TURN commands we can decode; commands we
    // can't stay preserved untouched so saves never corrupt.
    const turnDef = this.turnTrackerDef();
    if (turnDef) {
      const remaining: string[] = [];
      for (const command of this.preservedSaveCommands) {
        const decoded = command.startsWith(TURN_PREFIX) ? decodeTurnCommand(command, turnDef) : null;
        if (decoded) this.turnState = decoded;
        else remaining.push(command);
      }
      this.preservedSaveCommands = remaining;
      this.turnView?.render();
    }

    const summary = notesSummary(this.notes);
    if (summary) this.chatter.add(summary);

    const target =
      this.model.maps.find((m) => (this.mapStates.get(m.name)?.pieces.length ?? 0) > 0)
      ?? this.model.maps.find((m) => this.mapStates.get(m.name)?.boardImage)
      ?? this.currentMap;
    this.switchMap(target);
    return true;
  }
}

function boardDebugInfo(board: BoardDef): { id: string; name: string; image: string; tiles: number; tileNames: string[] } {
  return {
    id: boardKey(board),
    name: board.name,
    image: board.image,
    tiles: board.tiles?.length ?? 0,
    tileNames: board.tiles?.map((tile) => tile.boardName) ?? [],
  };
}

// ---- helpers ---------------------------------------------------------------

function collectCardDecks(root: WidgetNode | null): CardDeckState[] {
  if (!root) return [];
  const decks: CardDeckState[] = [];
  const walk = (node: WidgetNode, path: string[]) => {
    const nextPath = node.name ? [...path, node.name] : path;
    if (node.slots.length && looksLikeCardDeck(node.slots, nextPath)) {
      const nameParts = nextPath.slice(-3).filter(Boolean);
      decks.push({
        id: `card-deck-${decks.length + 1}`,
        name: nameParts.join(" / ") || `Card Deck ${decks.length + 1}`,
        slots: node.slots,
        remaining: [...node.slots],
      });
    }
    for (const child of node.children) walk(child, nextPath);
  };
  walk(root, []);
  return decks;
}

function looksLikeCardDeck(slots: PieceSlotDef[], path: string[]): boolean {
  const inCardWindow = path.some((p) => /cards?|tactical objectives|open war/i.test(p));
  const cardLikeSlot = slots.some((s) => /(^TO-|^OW-|prototype;Card-|Open_War|TO-RULEBOOK)/i.test(`${s.name}\n${s.def}`));
  return (inCardWindow || cardLikeSlot) && slots.some((s) => s.width >= 180 && s.height >= 180);
}

// ---- boot: accumulating multi-file loader ----------------------------------

const app = new App();

interface Pending { name: string; data: Uint8Array }
const pending: Pending[] = [];
let bundledPresets: PresetDef[] = [];

function renderLoader(): void {
  const loader = document.getElementById("loader");
  if (!loader) return;
  loader.innerHTML = "";

  const h = document.createElement("h1");
  h.textContent = "VASSAL Browser";
  const p = document.createElement("p");
  p.textContent = "Add a module (.vmod) and any extension files — select or drop them together, or drop ONE plain .zip bundle holding the module, its extensions, and an optional boards/ folder.";

  const presets = document.createElement("div");
  presets.className = "preset-list";
  for (const preset of bundledPresets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.textContent = preset.name;
    btn.title = preset.detail;
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Loading...";
      loadHostedFiles(preset).catch((err) => {
        btn.disabled = false;
        btn.textContent = preset.name;
        alert("Failed to load bundled preset: " + err.message);
        console.error(err);
      });
    });
    presets.appendChild(btn);
  }

  const drop = document.createElement("div");
  drop.className = "drop-zone";
  drop.textContent = "Drop .vmod / extension / bundle .zip files here, or choose files";
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true; // no accept filter: extensions ship without a suffix
  drop.appendChild(document.createElement("br"));
  drop.appendChild(input);

  const list = document.createElement("ul");
  list.className = "file-list";
  for (const f of pending) {
    const li = document.createElement("li");
    li.textContent = f.name;
    list.appendChild(li);
  }

  const load = document.createElement("button");
  load.className = "load-btn";
  load.textContent = pending.length ? `Load ${pending.length} file(s)` : "Add files to begin";
  load.disabled = pending.length === 0;
  load.addEventListener("click", () => {
    app.loadFiles(pending).catch((err) => {
      alert("Failed to load: " + err.message);
      console.error(err);
    });
  });

  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Nothing is uploaded — files are read locally in your browser. Hotseat only (no networking).";

  loader.append(h, p, presets, drop, list, load, hint);

  const addFiles = async (files: File[]) => {
    for (const f of files) pending.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
    renderLoader();
  };
  input.addEventListener("change", () => addFiles(Array.from(input.files ?? [])));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    addFiles(Array.from(e.dataTransfer?.files ?? []));
  });
}
renderLoader();

// Bundled presets are pure data shipped next to the module assets: the code
// has no knowledge of specific modules. Missing/invalid file = no presets.
fetch(new URL("modules/presets.json", location.href))
  .then((r) => (r.ok ? r.json() : []))
  .then((list: PresetDef[]) => {
    bundledPresets = Array.isArray(list) ? list : [];
    renderLoader();
  })
  .catch(() => {});

// Auto-load hosted files (works in dev and production builds alike):
//   ?module=<url>&ext=<url>,<url>&board=<name>,<name>
// URLs must be same-origin or CORS-readable. See README "Loading modules".
const params = new URLSearchParams(location.search);
const moduleUrl = params.get("module");
if (moduleUrl) {
  const extUrls = (params.get("ext") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const defaultBoards = (params.get("board") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  Promise.all([fetchBytes(moduleUrl), ...extUrls.map(fetchBytes)])
    .then(([mod, ...exts]) => app.loadFiles(
      [{ name: "module.vmod", data: mod }, ...exts.map((data, i) => ({ name: `ext${i}.vmdx`, data }))],
      { defaultBoards },
    ))
    .catch((err) => console.error("auto-load failed", err));
}

function loadHostedFiles(preset: PresetDef): Promise<void> {
  return Promise.all(
    preset.files.map(async (name) => ({
      name,
      data: await fetchBytes(new URL(`modules/${name}`, location.href).toString()),
    })),
  ).then((loaded) => app.loadFiles(loaded, {
    pieceScale: preset.pieceScale ?? 1,
    boardsUrl: preset.boards ? new URL(`modules/${preset.boards}/`, location.href).toString() : undefined,
    defaultBoards: preset.defaultBoards,
  }));
}

function fetchBytes(u: string): Promise<Uint8Array> {
  return fetch(u).then((r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${u}`);
    return r.arrayBuffer();
  }).then((b) => new Uint8Array(b));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000; // avoid call-stack limits on large saves
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "vassal-browser";
}

export {};
