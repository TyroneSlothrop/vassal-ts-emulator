/**
 * Modal "choose boards" dialog — the browser analogue of VASSAL's stock
 * BoardPicker setup step (BoardPicker.selectBoards / getControls): a grid of
 * BoardSlots with add-row/add-column/clear buttons and OK/Cancel. Pure slot
 * logic lives in vmod/boardpicker.ts (BoardPickerModel); this class only
 * renders it.
 */

import type { BoardDef, BoardPickerDef, MapDef } from "../vmod/buildfile";
import { BoardPickerModel, type PickerTile } from "../vmod/boardpicker";

export interface BoardPickerDialogCallbacks {
  onApply: (tiles: PickerTile[]) => void;
  onCancel: () => void;
}

export class BoardPickerDialog {
  private constructor(
    private readonly def: BoardPickerDef,
    private readonly map: MapDef,
    private readonly model: BoardPickerModel,
    private readonly overlay: HTMLElement,
    private readonly gridEl: HTMLElement,
    private readonly addColBtn: HTMLButtonElement,
  ) {}

  static open(
    def: BoardPickerDef,
    map: MapDef,
    initialTiles: PickerTile[] | null,
    cb: BoardPickerDialogCallbacks,
    imageUrl?: (entry: string) => string | null,
  ): BoardPickerDialog {
    const model = new BoardPickerModel();
    if (initialTiles?.length) model.loadTiles(initialTiles);

    const overlay = document.createElement("div");
    overlay.className = "boardpicker-overlay";

    const dialog = document.createElement("div");
    dialog.className = "boardpicker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", def.title);

    const title = document.createElement("div");
    title.className = "boardpicker-title";
    title.textContent = def.title;
    dialog.appendChild(title);

    // Toolbar with add row/column/clear — hidden unless the map allows
    // multiple boards (Java setAllowMultiple hides multipleButtons).
    const bar = document.createElement("div");
    bar.className = "boardpicker-bar";
    const mkBtn = (text: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "toolbar-btn";
      b.textContent = text;
      b.addEventListener("click", fn);
      return b;
    };
    const addRowBtn = mkBtn(def.addRowText, () => d.render());
    const addColBtn = mkBtn(def.addColumnText, () => d.render());
    const clearBtn = mkBtn(def.clearText, () => d.render());
    const multi = def.allowMultiple;
    bar.style.display = multi ? "" : "none";
    bar.append(addRowBtn, addColBtn, clearBtn);
    dialog.appendChild(bar);
    addRowBtn.addEventListener("click", () => model.addRow());
    addColBtn.addEventListener("click", () => model.addColumn());
    clearBtn.addEventListener("click", () => model.clear());

    const gridEl = document.createElement("div");
    gridEl.className = "boardpicker-grid";
    dialog.appendChild(gridEl);

    const buttons = document.createElement("div");
    buttons.className = "boardpicker-buttons";
    const ok = mkBtn("OK", () => {
      const tiles = model.tiles();
      d.close();
      cb.onApply(tiles);
    });
    const cancel = mkBtn("Cancel", () => {
      d.close();
      cb.onCancel();
    });
    buttons.append(ok, cancel);
    dialog.appendChild(buttons);

    overlay.appendChild(dialog);
    // DISPOSE_ON_CLOSE semantics: clicking the backdrop cancels.
    overlay.addEventListener("pointerdown", (e) => {
      if (e.target === overlay) {
        d.close();
        cb.onCancel();
      }
    });

    const d = new BoardPickerDialog(def, map, model, overlay, gridEl, addColBtn);
    document.body.appendChild(overlay);
    d.render();
    if (imageUrl) d.imageUrl = imageUrl;
    return d;
  }

  private imageUrl: ((entry: string) => string | null) | null = null;

  close(): void {
    this.overlay.remove();
  }

  /** Re-render the slot grid from the model (after add row/column/clear). */
  render(): void {
    const { model, def, map } = this;
    this.gridEl.innerHTML = "";
    this.gridEl.style.gridTemplateColumns = `repeat(${model.nx}, ${def.slotWidth}px)`;
    model.slots.forEach((slot, i) => {
      const cell = document.createElement("div");
      cell.className = "boardpicker-slot";
      cell.style.minHeight = `${def.slotHeight}px`;

      const select = document.createElement("select");
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = def.boardPrompt;
      select.appendChild(prompt);
      for (const b of map.boards.filter((b) => !b.tiles)) {
        const opt = document.createElement("option");
        opt.value = b.name;
        opt.textContent = b.name;
        select.appendChild(opt);
      }
      // Java BoardSlot: preselect when there is exactly one allowable board.
      select.value = slot.boardName ?? (map.boards.filter((b) => !b.tiles).length === 1 ? map.boards.filter((b) => !b.tiles)[0].name : "");
      const extras = document.createElement("div");
      extras.className = "boardpicker-slot-extras";
      select.addEventListener("change", () => {
        model.setSlot(i, { boardName: select.value || null, reversed: slot.reversed });
        this.renderSlotExtras(extras, select.value, i);
      });
      cell.appendChild(select);
      cell.appendChild(extras);
      this.renderSlotExtras(extras, select.value, i);

      this.gridEl.appendChild(cell);
    });

    // maxColumns gate (Java actionPerformed: maxColumns == 0 || nx < maxColumns).
    this.addColBtn.disabled = !model.canAddColumn(def.maxColumns);
  }

  private renderSlotExtras(cell: HTMLElement, boardName: string, index?: number): void {
    // Flip checkbox (visible only for reversible boards) + thumbnail.
    const map = this.map;
    const board: BoardDef | undefined = map.boards.find((b) => b.name === boardName);
    const slotIndex = index ?? -1;
    const slot = slotIndex >= 0 ? this.model.slots[slotIndex] : undefined;
    cell.innerHTML = "";
    if (!board) return;
    const flip = document.createElement("label");
    flip.className = "boardpicker-flip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = slot?.reversed ?? false;
    cb.disabled = !board.reversible;
    cb.addEventListener("change", () => {
      if (slotIndex >= 0) this.model.setSlot(slotIndex, { boardName: board.name, reversed: cb.checked });
    });
    flip.append(cb, document.createTextNode("Flip"));
    flip.style.visibility = board.reversible ? "" : "hidden";
    cell.appendChild(flip);
    if (board.image && this.imageUrl) {
      const url = this.imageUrl(board.image);
      if (url) {
        const img = document.createElement("img");
        img.className = "boardpicker-thumb";
        img.src = url;
        img.alt = board.name;
        cell.appendChild(img);
      }
    }
  }
}
