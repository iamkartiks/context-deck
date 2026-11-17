import qrcodegen from './vendor/qrcodegen/qrcodegen.js';

/**
 * QR codes for pairing a phone, drawn for a terminal or as an SVG.
 * Uses Project Nayuki's generator, vendored unmodified (MIT).
 */

/** The four-module light border the QR spec asks for, so phones can find the code. */
const QUIET = 4;

/** Dark modules as rows of booleans, with the quiet zone included. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const size = qr.size + QUIET * 2;
  const rows: boolean[][] = [];
  for (let y = 0; y < size; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) row.push(qr.getModule(x - QUIET, y - QUIET));
    rows.push(row);
  }
  return rows;
}

/**
 * A QR code for a terminal, two rows per line with half blocks.
 * With `color`, it's drawn black on white whatever the terminal's theme.
 * Without, light modules are drawn as blocks, which reads right on the
 * usual dark terminal background.
 */
export function qrTerminal(text: string, opts: { color: boolean }): string {
  const m = qrModules(text);
  const lines: string[] = [];
  for (let y = 0; y < m.length; y += 2) {
    let line = '';
    for (let x = 0; x < m.length; x++) {
      const top = m[y]![x]!;
      const bottom = m[y + 1]?.[x] ?? false;
      if (opts.color) {
        // Same colour top and bottom: a space on a background colour, never a glyph
        // in the same colour as its background (some terminals, VS Code's among
        // them, recolour low-contrast text, which breaks the code). Mixed cells are
        // always black on white, with ▀ or ▄ for the dark half.
        line += top === bottom ? `\x1b[0;${top ? 40 : 107}m ` : `\x1b[0;30;107m${top ? '▀' : '▄'}`;
      } else {
        line += !top && !bottom ? '█' : !top ? '▀' : !bottom ? '▄' : ' ';
      }
    }
    lines.push(opts.color ? `${line}\x1b[0m` : line);
  }
  return lines.join('\n');
}

/** A QR code as a small standalone SVG: black modules on white, one path. */
export function qrSvg(text: string): string {
  const m = qrModules(text);
  let d = '';
  m.forEach((row, y) => row.forEach((dark, x) => (d += dark ? `M${x} ${y}h1v1h-1z` : '')));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${m.length} ${m.length}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
