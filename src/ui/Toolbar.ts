import { boardKey, type MapDef } from "../vmod/buildfile";
import type { InteractionLayer, PointerTool } from "../board/MapWindow";

export interface ToolbarCallbacks {
  onSelectMap: (map: MapDef) => void;
  onSelectBoard: (board: string) => void;
  /** Open the stock BoardPicker "choose boards" grid dialog. */
  onOpenBoardPicker: () => void;
  /** A predefined-setup scenario was picked (value = its file name). */
  onSelectScenario: (file: string) => void;
  onSetInteractionLayer: (layer: InteractionLayer) => void;
  onSetPointerTool: (tool: PointerTool) => void;
  onZoom: (factor: number) => void;
  onToggleLock: () => void;
  onToggleMeasure: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onDeleteSelected: () => void;
  onMarkMoved: () => void;
  onClearMoved: () => void;
  onSaveGame: () => void;
  onLoadGame: () => void;
}

/**
 * Top bar: map window picker, board picker (choose the table/terrain), zoom
 * controls, and a lock toggle for the selected piece. This is the browser
 * analogue of a VASSAL Map's toolbar (BoardPicker + Zoomer + …).
 */
export class Toolbar {
  readonly el: HTMLElement;
  private mapSelect: HTMLSelectElement;
  private boardSelect: HTMLSelectElement;
  private pickerBtn: HTMLButtonElement;
  private scenarioSelect: HTMLSelectElement;
  private scenarioWrap: HTMLElement;
  private focusSelect: HTMLSelectElement;
  private lockBtn: HTMLButtonElement;
  private deleteBtn: HTMLButtonElement;
  private movedBtn: HTMLButtonElement;
  private clearMovedBtn: HTMLButtonElement;
  private measureBtn: HTMLButtonElement;
  private selectToolBtn: HTMLButtonElement;
  private panToolBtn: HTMLButtonElement;
  private leftPanelBtn: HTMLButtonElement;
  private rightPanelBtn: HTMLButtonElement;
  private selInfo: HTMLElement;

  constructor(maps: MapDef[], private readonly cb: ToolbarCallbacks) {
    this.el = document.createElement("div");
    this.el.className = "toolbar";

    // Map window picker
    this.mapSelect = document.createElement("select");
    this.mapSelect.title = "Map window";
    for (const m of maps) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name;
      this.mapSelect.appendChild(opt);
    }
    this.mapSelect.addEventListener("change", () => {
      const m = maps.find((x) => x.name === this.mapSelect.value);
      if (m) {
        this.setBoards(m);
        this.cb.onSelectMap(m);
      }
    });
    this.el.appendChild(labelled("Map", this.mapSelect));

    // Board picker
    this.boardSelect = document.createElement("select");
    this.boardSelect.title = "Board / terrain";
    this.boardSelect.addEventListener("change", () => this.cb.onSelectBoard(this.boardSelect.value));
    this.el.appendChild(labelled("Board", this.boardSelect));
    // Stock BoardPicker dialog (choose several boards on a grid), when the
    // map declares one.
    this.pickerBtn = button("🗺", () => this.cb.onOpenBoardPicker());
    this.pickerBtn.title = "Choose boards…";
    this.pickerBtn.style.display = "none";
    this.el.appendChild(this.pickerBtn);

    // Predefined-setup scenarios (module "New Game" setups); hidden when the
    // module declares none.
    this.scenarioSelect = document.createElement("select");
    this.scenarioSelect.title = "Load a predefined scenario setup";
    this.scenarioSelect.addEventListener("change", () => {
      if (this.scenarioSelect.value) this.cb.onSelectScenario(this.scenarioSelect.value);
    });
    this.scenarioWrap = labelled("Scenario", this.scenarioSelect);
    this.scenarioWrap.style.display = "none";
    this.el.appendChild(this.scenarioWrap);

    // Edit focus controls which board-piece categories can be selected/dragged.
    this.focusSelect = document.createElement("select");
    this.focusSelect.title = "Editable layer";
    for (const [value, text] of [
      ["models", "Models"],
      ["terrain", "Terrain"],
      ["aids", "Aids"],
      ["map", "Map"],
      ["all", "All"],
    ] as const) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      this.focusSelect.appendChild(opt);
    }
    this.focusSelect.value = "models";
    this.focusSelect.addEventListener("change", () => this.cb.onSetInteractionLayer(this.focusSelect.value as InteractionLayer));
    this.el.appendChild(labelled("Edit", this.focusSelect));

    this.selectToolBtn = button("Select", () => this.setPointerTool("select"));
    this.selectToolBtn.title = "Select, move, and marquee-select pieces";
    this.panToolBtn = button("Pan", () => this.setPointerTool("pan"));
    this.panToolBtn.title = "Pan the table";
    const toolGroup = document.createElement("div");
    toolGroup.className = "toolbar-zoom";
    toolGroup.append(this.selectToolBtn, this.panToolBtn);
    this.el.appendChild(labelled("Tool", toolGroup));
    this.setPointerTool("select", false);

    // Zoom
    const zoomOut = button("−", () => this.cb.onZoom(1 / 1.2));
    const zoomIn = button("+", () => this.cb.onZoom(1.2));
    const zoomGroup = document.createElement("div");
    zoomGroup.className = "toolbar-zoom";
    zoomGroup.append(zoomOut, zoomIn);
    this.el.appendChild(labelled("Zoom", zoomGroup));

    // Range / LOS measuring tool
    this.measureBtn = button("📏 Range", () => this.cb.onToggleMeasure());
    this.measureBtn.title = "Measure range / line of sight (drag on the board)";
    this.el.appendChild(this.measureBtn);

    this.leftPanelBtn = button("◀ Palette", () => this.cb.onToggleLeftPanel());
    this.leftPanelBtn.title = "Show / hide the unit palette";
    this.el.appendChild(this.leftPanelBtn);
    this.rightPanelBtn = button("Log ▶", () => this.cb.onToggleRightPanel());
    this.rightPanelBtn.title = "Show / hide the log and cards panel";
    this.el.appendChild(this.rightPanelBtn);

    const saveBtn = button("Save", () => this.cb.onSaveGame());
    saveBtn.title = "Save this table state";
    this.el.appendChild(saveBtn);
    const loadBtn = button("Load", () => this.cb.onLoadGame());
    loadBtn.title = "Load a saved table state";
    this.el.appendChild(loadBtn);

    // Lock
    this.lockBtn = button("🔓 Lock", () => this.cb.onToggleLock());
    this.lockBtn.disabled = true;
    this.el.appendChild(this.lockBtn);

    this.deleteBtn = button("Delete", () => this.cb.onDeleteSelected());
    this.deleteBtn.disabled = true;
    this.el.appendChild(this.deleteBtn);

    this.movedBtn = button("Moved", () => this.cb.onMarkMoved());
    this.movedBtn.disabled = true;
    this.el.appendChild(this.movedBtn);

    this.clearMovedBtn = button("Clear", () => this.cb.onClearMoved());
    this.clearMovedBtn.disabled = true;
    this.el.appendChild(this.clearMovedBtn);

    // Selected info
    this.selInfo = document.createElement("div");
    this.selInfo.className = "toolbar-sel";
    this.selInfo.textContent = "No selection";
    this.el.appendChild(this.selInfo);

    if (maps[0]) this.setBoards(maps[0]);
  }

  setScenarios(list: Array<{ name: string; file: string; menu?: string }>): void {
    this.scenarioSelect.innerHTML = "";
    this.scenarioWrap.style.display = list.length ? "" : "none";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(choose)";
    this.scenarioSelect.appendChild(none);
    // Group by the module's setup-menu hierarchy (scenario books/series).
    const groups = new Map<string, HTMLElement>();
    for (const s of list) {
      let parent: HTMLElement = this.scenarioSelect;
      if (s.menu) {
        let g = groups.get(s.menu);
        if (!g) {
          g = document.createElement("optgroup");
          (g as HTMLOptGroupElement).label = s.menu;
          groups.set(s.menu, g);
          this.scenarioSelect.appendChild(g);
        }
        parent = g;
      }
      const opt = document.createElement("option");
      opt.value = s.file;
      opt.textContent = s.name;
      parent.appendChild(opt);
    }
  }

  setBoards(map: MapDef): void {
    this.boardSelect.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(none)";
    this.boardSelect.appendChild(none);
    for (const b of map.boards) {
      const opt = document.createElement("option");
      opt.value = boardKey(b);
      opt.textContent = b.name;
      this.boardSelect.appendChild(opt);
    }
    this.pickerBtn.style.display = map.boardPicker ? "" : "none";
    if (map.boardPicker) this.pickerBtn.title = `${map.boardPicker.title}…`;
  }

  setCurrentMap(name: string): void {
    this.mapSelect.value = name;
  }

  setBoardImage(image: string | null): void {
    this.boardSelect.value = image ?? "";
  }

  selectBoardByName(name: string): void {
    const opt = Array.from(this.boardSelect.options).find((o) => o.textContent === name || o.value === name);
    if (opt) {
      this.boardSelect.value = opt.value;
      this.cb.onSelectBoard(opt.value);
    }
  }

  setPointerTool(tool: PointerTool, notify = true): void {
    this.selectToolBtn.classList.toggle("active", tool === "select");
    this.panToolBtn.classList.toggle("active", tool === "pan");
    if (notify) this.cb.onSetPointerTool(tool);
  }

  setSelection(name: string | null, locked: boolean, moved = false, count = 0): void {
    const hasSelection = count > 0 || name != null;
    this.lockBtn.disabled = !hasSelection;
    this.deleteBtn.disabled = !hasSelection;
    this.movedBtn.disabled = !hasSelection;
    this.clearMovedBtn.disabled = !hasSelection;
    this.lockBtn.textContent = locked ? "🔒 Locked" : "🔓 Lock";
    this.movedBtn.classList.toggle("active", moved);
    if (count > 1) this.selInfo.textContent = `Selected: ${count} pieces`;
    else this.selInfo.textContent = name ? `Selected: ${name}${moved ? " (moved)" : ""}` : "No selection";
  }

  setMeasuring(on: boolean): void {
    this.measureBtn.classList.toggle("active", on);
    this.measureBtn.textContent = on ? "📏 Range (on)" : "📏 Range";
  }
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "toolbar-field";
  const span = document.createElement("span");
  span.textContent = text;
  wrap.append(span, control);
  return wrap;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "toolbar-btn";
  b.textContent = text;
  b.addEventListener("click", onClick);
  return b;
}
