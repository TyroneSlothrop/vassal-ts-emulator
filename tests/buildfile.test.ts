// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyExtensionBoards, normalizeCustomClasses, parseBuildFile, stockClassFor, type ExtensionModel, type MapDef } from "../src/vmod/buildfile";

describe("extension board grafts", () => {
  it("merges BoardPicker boards from extensions into the target map", () => {
    const maps = [tableMap([{ name: "22x30 Meadow", image: "22x30Meadow.png", reversible: false }])];
    const ext = boardExtension([
      { name: "2x2 Meadow", image: "2x2Meadow.png", reversible: true },
      { name: "Side Table Meadow", image: "SideTableMeadow.png", reversible: false },
    ]);

    applyExtensionBoards(maps, ext);

    expect(maps[0].boards.map((b) => b.name)).toEqual(["22x30 Meadow", "2x2 Meadow", "Side Table Meadow"]);
  });

  it("does not duplicate boards already present on the map", () => {
    const maps = [tableMap([{ name: "2x2 Meadow", image: "2x2Meadow.png", reversible: false }])];
    const ext = boardExtension([{ name: "2x2 Meadow", image: "2x2Meadow.png", reversible: false }]);

    applyExtensionBoards(maps, ext);

    expect(maps[0].boards).toHaveLength(1);
  });
});

function tableMap(boards: MapDef["boards"]): MapDef {
  return {
    name: "Table",
    buttonName: "Table",
    boards,
    drawPiles: [],
    layerOrder: [],
    losScale: 0,
  };
}

function boardExtension(boards: MapDef["boards"]): ExtensionModel {
  return {
    id: "boards",
    name: "BoardsExt",
    category: "models",
    grafts: [],
    boardGrafts: [{ target: "VASSAL.build.module.Map:Table/VASSAL.build.module.map.BoardPicker", mapName: "Table", boards }],
    prototypes: new Map(),
    predefinedSetups: [],
  };
}

describe("custom class resolution (no per-module alias tables)", () => {
  it("resolves custom subclasses to stock components by name suffix", () => {
    // Exact suffix match ("...Map" -> Map), incl. nested map components.
    expect(stockClassFor("MOD.build.module.XyzMap")).toBe("VASSAL.build.module.Map");
    expect(stockClassFor("MOD.build.module.map.XyzBoardPicker")).toBe("VASSAL.build.module.map.BoardPicker");
    // Longest-common-word-suffix match ("XyzThread" -> LOS_Thread via "Thread").
    expect(stockClassFor("MOD.build.module.map.XyzThread")).toBe("VASSAL.build.module.map.LOS_Thread");
    expect(stockClassFor("MOD.build.module.map.XyzGlobalMap")).toBe("VASSAL.build.module.map.GlobalMap");
    // Any other module's custom subclasses resolve the same way.
    expect(stockClassFor("com.example.MyGameMap")).toBe("VASSAL.build.module.Map");
    // Non-component custom classes stay unknown (ignored like any odd tag).
    expect(stockClassFor("MOD.build.module.XyzNightMapShader")).toBeNull();
    expect(stockClassFor("MOD.build.module.map.XyzCasbin")).toBeNull();
    expect(stockClassFor("MOD.build.module.XyzDiceBot")).toBeNull();
  });

  it("normalizes custom tags in XML and leaves stock/unknown tags alone", () => {
    const xml = `<VASSAL.build.GameModule name="X" version="1">
      <mymod.game.CustomMap mapName="Table"><mymod.game.CustomBoardPicker/></mymod.game.CustomMap>
      <mymod.game.WeirdShader/>
      <NoNamespaceTag/>
    </VASSAL.build.GameModule>`;
    const out = normalizeCustomClasses(xml);
    expect(out).toContain("<VASSAL.build.module.Map mapName=");
    expect(out).toContain("</VASSAL.build.module.Map>");
    expect(out).toContain("<VASSAL.build.module.map.BoardPicker/>");
    expect(out).toContain("<mymod.game.WeirdShader/>");
    expect(out).toContain("<NoNamespaceTag/>");
  });
});

describe("PrivateMap / PlayerHand parsing", () => {
  it("parses Map subclasses as ordinary map windows, in document order", () => {
    const model = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Main Map" launch="false"/>
  <VASSAL.build.module.PrivateMap mapName="Blue" buttonName="Blue" launch="true" side="Blue,Solo">
    <VASSAL.build.module.map.DrawPile name="BlueShips" x="10" y="20" width="60" height="60">
      <VASSAL.build.widget.CardSlot entryName="Blue Ship" gpid="1" height="60" width="60">+/null/piece;;;ship.png;Blue Ship/null;0;0;1;0</VASSAL.build.widget.CardSlot>
    </VASSAL.build.module.map.DrawPile>
  </VASSAL.build.module.PrivateMap>
  <VASSAL.build.module.PlayerHand mapName="Blue Hand" launch="true"/>
</VASSAL.build.GameModule>`);
    expect(model.maps.map((m) => m.name)).toEqual(["Main Map", "Blue", "Blue Hand"]);
    expect(model.maps[1].drawPiles.map((p) => p.name)).toEqual(["BlueShips"]);
    // Launchable subclasses get toolbar map buttons like any Map.
    const buttons = model.toolbar.filter((t) => t.kind === "map").map((t) => t.text);
    expect(buttons).toEqual(["Blue", "Blue Hand"]);
  });
});

describe("DrawPile / SetupStack parsing", () => {
  const XML = `<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Side Table">
    <VASSAL.build.module.map.boardPicker.Board image="tray.png" name="Tray"/>
    <VASSAL.build.module.folder.MapSubFolder name="Piles">
      <VASSAL.build.module.map.DrawPile name="Blue Chits" owningBoard="Tray" x="80" y="100"
          width="90" height="90" faceDown="Always" shuffle="Always" color="114,199,238">
        <VASSAL.build.widget.CardSlot entryName="Chit A" gpid="1" height="90" width="90">+/null/piece;;;chitA.png;Chit A/null;0;0;1;0</VASSAL.build.widget.CardSlot>
        <VASSAL.build.widget.CardSlot entryName="Chit B" gpid="2" height="90" width="90">+/null/piece;;;chitB.png;Chit B/null;0;0;2;0</VASSAL.build.widget.CardSlot>
      </VASSAL.build.module.map.DrawPile>
    </VASSAL.build.module.folder.MapSubFolder>
    <VASSAL.build.module.map.SetupStack name="Home" owningBoard="Tray" useGridLocation="false" x="183" y="154">
      <VASSAL.build.widget.PieceSlot entryName="Flagship" gpid="3" height="60" width="60">+/null/piece;;;ship.png;Flagship/null;0;0;3;0</VASSAL.build.widget.PieceSlot>
    </VASSAL.build.module.map.SetupStack>
  </VASSAL.build.module.Map>
</VASSAL.build.GameModule>`;

  it("finds DrawPiles nested under folders, with placement + deck attrs", () => {
    const model = parseBuildFile(XML);
    const piles = model.maps[0].drawPiles;
    expect(piles).toHaveLength(1);
    expect(piles[0]).toMatchObject({
      name: "Blue Chits",
      mapName: "Side Table",
      x: 80,
      y: 100,
      width: 90,
      height: 90,
      faceDown: "Always",
      shuffle: "Always",
      color: "114,199,238",
      owningBoard: "Tray",
    });
    expect(piles[0].slots.map((s) => s.name)).toEqual(["Chit A", "Chit B"]);
  });

  it("parses SetupStack pieces with their fixed position", () => {
    const model = parseBuildFile(XML);
    const stacks = model.maps[0].setupStacks!;
    expect(stacks).toHaveLength(1);
    expect(stacks[0]).toMatchObject({ name: "Home", owningBoard: "Tray", x: 183, y: 154 });
    expect(stacks[0].slots.map((s) => s.name)).toEqual(["Flagship"]);
  });
});

describe("LOS_Thread declaration", () => {
  it("parses scale, color, snapping, and rounding into MapDef.losThread", () => {
    const model = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Main Map">
    <VASSAL.build.module.map.LOS_Thread threadName="LOS" drawRange="true" scale="25.5"
        threadColor="255,0,0" snapStart="true" snapEnd="false" round="Nearest whole number"/>
  </VASSAL.build.module.Map>
</VASSAL.build.GameModule>`);
    expect(model.maps[0].losScale).toBeCloseTo(25.5);
    expect(model.maps[0].losThread).toEqual({
      scale: 25.5,
      color: "rgb(255,0,0)",
      snapStart: true,
      snapEnd: false,
      round: "nearest",
    });
  });

  it("snapLOS implies snapping both ends; rounding defaults to Up", () => {
    const model = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Main Map">
    <VASSAL.build.module.map.LOS_Thread threadName="LOS" snapLOS="true"/>
  </VASSAL.build.module.Map>
</VASSAL.build.GameModule>`);
    expect(model.maps[0].losThread).toMatchObject({ snapStart: true, snapEnd: true, round: "up", color: null });
  });
});

describe("dice-bot detection", () => {
  it("flags modules declaring a *DiceBot component", () => {
    const withBot = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <MOD.build.module.XyzDiceBot/>
  <VASSAL.build.module.Map mapName="Main Map"/>
</VASSAL.build.GameModule>`);
    expect(withBot.hasDiceBot).toBe(true);

    const without = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Table"/>
</VASSAL.build.GameModule>`);
    expect(without.hasDiceBot).toBe(false);
  });
});

describe("legacy module format (VASSAL 3.1 era)", () => {
  it("parses a VASSAL.launch.BasicModule root (Java: BasicModule extends GameModule)", () => {
    const model = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.launch.BasicModule VassalVersion="3.1.15" name="Legacy Sample" version="2.1" nextPieceSlotId="137">
  <VASSAL.build.module.BasicCommandEncoder/>
  <VASSAL.build.module.Map mapName="Main Map">
    <VASSAL.build.module.map.BoardPicker>
      <VASSAL.build.module.map.boardPicker.Board image="map.png" name="Star Map"/>
    </VASSAL.build.module.map.BoardPicker>
  </VASSAL.build.module.Map>
  <VASSAL.build.module.PieceWindow name="Counters">
    <VASSAL.build.widget.ListWidget entryName="Ships">
      <VASSAL.build.widget.PieceSlot entryName="Cruiser" gpid="0" height="75" width="75">+/null/piece;;;cruiser.png;Cruiser/null;0;0;0;0</VASSAL.build.widget.PieceSlot>
    </VASSAL.build.widget.ListWidget>
  </VASSAL.build.module.PieceWindow>
</VASSAL.launch.BasicModule>`);
    expect(model.name).toBe("Legacy Sample");
    expect(model.version).toBe("2.1");
    expect(model.maps.map((m) => m.name)).toEqual(["Main Map"]);
    expect(model.maps[0].boards.map((b) => b.name)).toEqual(["Star Map"]);
    expect(model.palette?.children[0]?.slots[0]?.name).toBe("Cruiser");
  });
});

describe("imageless boards with buildFile grids (old modules)", () => {
  it("parses width/height/color boards and their HexGrid + numbering", () => {
    const model = parseBuildFile(`<?xml version="1.0"?>
<VASSAL.build.GameModule name="Legacy Grid Sample" version="0.65">
  <VASSAL.build.module.Map mapName="Main Map">
    <VASSAL.build.module.map.BoardPicker>
      <VASSAL.build.module.map.boardPicker.Board name="Space" reversible="false" width="1999" height="1984" color="0,0,153">
        <VASSAL.build.module.map.boardPicker.board.HexGrid sideways="false" x0="0" y0="32" dy="64.0" dx="55.42562584220407" visible="true" dotsVisible="false" color="102,204,255">
          <VASSAL.build.module.map.boardPicker.board.mapgrid.HexGridNumbering first="H" sep="" hType="N" hLeading="1" hOff="1" hDescend="false" vType="N" vLeading="1" vOff="1" vDescend="false" visible="true" fontSize="9" color="102,204,255" stagger="true"/>
        </VASSAL.build.module.map.boardPicker.board.HexGrid>
      </VASSAL.build.module.map.boardPicker.Board>
    </VASSAL.build.module.map.BoardPicker>
  </VASSAL.build.module.Map>
</VASSAL.build.GameModule>`);
    const board = model.maps[0].boards[0];
    expect(board.name).toBe("Space");
    expect(board.image).toBe("");
    expect(board.width).toBe(1999);
    expect(board.height).toBe(1984);
    expect(board.color).toBe("0,0,153");
    expect(board.grid).toBeTruthy();
    expect(board.grid!.dy).toBe(64);
    expect(board.grid!.dx).toBeCloseTo(55.4256, 3);
    expect(board.grid!.originY).toBe(32);
    expect(board.grid!.visible).toBe(true);
    expect(board.grid!.color).toBe("rgb(102,204,255)");
    const n = board.grid!.numbering!;
    expect(n).toMatchObject({ first: "H", hType: "N", vType: "N", hOff: 1, vOff: 1, stagger: true, visible: true, fontSize: 9, color: "rgb(102,204,255)" });
  });
});

describe("BoardPicker declaration", () => {
  const XML = `<?xml version="1.0"?>
<VASSAL.build.GameModule name="M" version="1">
  <VASSAL.build.module.Map mapName="Main Map" buttonName="Map" allowMultiple="true" launch="false">
    <VASSAL.build.module.map.BoardPicker title="Choose Boards" boardPrompt="Select board" slotWidth="350" slotHeight="125" slotScale="0.2">
      <setup>Main MapBoardPicker\tmap A\t0\t0\tmap B\t1\t0</setup>
      <VASSAL.build.module.map.boardPicker.Board image="a.png" name="map A" reversible="false"/>
      <VASSAL.build.module.map.boardPicker.Board image="b.png" name="map B" reversible="false"/>
    </VASSAL.build.module.map.BoardPicker>
  </VASSAL.build.module.Map>
</VASSAL.build.GameModule>`;

  it("parses picker attrs, Map.allowMultiple and the <setup> default command", () => {
    const model = parseBuildFile(XML);
    const picker = model.maps[0].boardPicker!;
    expect(model.maps[0].allowMultiple).toBe(true);
    expect(picker.title).toBe("Choose Boards");
    expect(picker.allowMultiple).toBe(true);
    expect(picker.slotWidth).toBe(350);
    // Verbatim, tabs included — Java keeps the raw text of <setup>.
    expect(picker.defaultSetup).toBe("Main MapBoardPicker\tmap A\t0\t0\tmap B\t1\t0");
    expect(model.maps[0].boards.map((b) => b.name)).toEqual(["map A", "map B"]);
  });

  it("leaves defaultSetup undefined when the picker has no <setup>", () => {
    const xml2 = XML.replace(/<setup>[^<]*<\/setup>/, "");
    const model = parseBuildFile(xml2);
    expect(model.maps[0].boardPicker!.defaultSetup).toBeUndefined();
  });
});
