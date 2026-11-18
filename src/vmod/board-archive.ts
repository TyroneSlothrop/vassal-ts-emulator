/**
 * Board archive reader. A board archive (`bd01`, `bdAAC`, …) is a ZIP holding
 * the board image plus grid metadata in one of two formats:
 *
 * - `BoardMetadata.xml` (modern): attributes name/boardImageFileName/width/
 *   height plus optional hexWidth/hexHeight/A1CenterX/A1CenterY/altHexGrain/
 *   snapScale grid overrides ($VASL_SRC/.../boardArchive/BoardMetadata.java).
 * - `data` (legacy): whitespace key/value lines with optional x0/y0/dx/dy/
 *   snapscale/name keys (.../boardArchive/DataFile.java).
 *
 * Missing values fall back to the geomorphic constants, exactly like
 * BoardArchive.getA1CenterX() & co.
 */

import type { ModuleArchive } from "./zip";
import { geoGridDef, type HexGridDef } from "./hexgrid";

export interface BoardArchiveInfo {
  /** Display name from metadata ("01", "AAC"), falling back to the file name. */
  name: string;
  /** Archive entry of the board image (e.g. "bd01.gif"). */
  imageEntry: string;
  grid: HexGridDef;
  widthHexes: number;
  heightHexes: number;
}

export function parseBoardArchive(archive: ModuleArchive, fileName: string): BoardArchiveInfo {
  const fallbackName = fileName.replace(/^bd/, "");
  if (archive.hasEntry("BoardMetadata.xml")) {
    return fromBoardMetadata(archive, fallbackName);
  }
  return fromLegacyData(archive, fallbackName);
}

function fromBoardMetadata(archive: ModuleArchive, fallbackName: string): BoardArchiveInfo {
  const doc = new DOMParser().parseFromString(archive.text("BoardMetadata.xml"), "application/xml");
  const root = doc.documentElement;
  const num = (attr: string, dflt: number): number => {
    const v = root.getAttribute(attr);
    const n = v == null ? NaN : Number.parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const bool = (attr: string, dflt: boolean): boolean => {
    const v = root.getAttribute(attr);
    return v == null ? dflt : v === "true" || v === "TRUE";
  };
  const geo = geoGridDef();
  const grid: HexGridDef = {
    dx: num("hexWidth", geo.dx),
    dy: num("hexHeight", geo.dy),
    originX: num("A1CenterX", geo.originX),
    originY: num("A1CenterY", geo.originY),
    alternate: root.getAttribute("altHexGrain") === "TRUE" || root.getAttribute("altHexGrain") === "true",
    snapScale: num("snapScale", 0),
    snapTo: bool("snapTo", true),
    edgesLegal: bool("edgesLegal", false),
    cornersLegal: bool("cornersLegal", false),
  };
  // A1CenterX=-901 / A1CenterY=-612.75 are sentinel values on half-board
  // variants (BoardArchive "b board"/"DW board" tests); the real origin there
  // is the geo one.
  if (grid.originX === -901) grid.originX = geo.originX;
  if (grid.originY === -612.75) grid.originY = geo.originY;
  return {
    name: root.getAttribute("name") || fallbackName,
    imageEntry: findImageEntry(archive, root.getAttribute("boardImageFileName")),
    grid,
    widthHexes: num("width", 33),
    heightHexes: num("height", 10),
  };
}

function fromLegacyData(archive: ModuleArchive, fallbackName: string): BoardArchiveInfo {
  const attrs = new Map<string, string>();
  if (archive.hasEntry("data")) {
    for (const line of archive.text("data").split(/\r?\n/)) {
      const tok = line.trim().split(/\s+/);
      if (tok.length >= 2) attrs.set(tok[0].toLowerCase(), tok[1]);
    }
  }
  const geo = geoGridDef();
  const num = (key: string, dflt: number): number => {
    const n = Number.parseFloat(attrs.get(key) ?? "");
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    name: fallbackName,
    imageEntry: findImageEntry(archive, attrs.get("name") ?? null),
    grid: {
      dx: num("dx", geo.dx),
      dy: num("dy", geo.dy),
      originX: num("x0", geo.originX),
      originY: num("y0", geo.originY),
      alternate: (attrs.get("althexgrain") ?? "") === "true",
      snapScale: num("snapscale", 0),
      snapTo: (attrs.get("snapto") ?? "true") === "true",
      edgesLegal: (attrs.get("edgeslegal") ?? "false") === "true",
      cornersLegal: (attrs.get("cornerslegal") ?? "false") === "true",
    },
    widthHexes: 33,
    heightHexes: 10,
  };
}

/** The declared image if present, else the biggest root-level image entry. */
function findImageEntry(archive: ModuleArchive, declared: string | null): string {
  if (declared && archive.hasEntry(declared)) return declared;
  const images = archive
    .entryNames()
    .filter((n) => !n.includes("/") && /\.(gif|png|jpe?g)$/i.test(n));
  // Prefer the conventional bd*.gif full-board image over overlay variants.
  const bd = images.find((n) => /^bd/i.test(n));
  if (bd) return bd;
  images.sort((a, b) => (archive.bytes(b)?.length ?? 0) - (archive.bytes(a)?.length ?? 0));
  return images[0] ?? "";
}
