import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const APP = readFileSync(fileURLToPath(new URL('../../ui/app.js', import.meta.url)), 'utf8');

/** The top-level arguments of every `replaceChildren(...)` call, with the line it starts on. */
function replaceChildrenArgs(src: string): { line: number; arg: string }[] {
  const out: { line: number; arg: string }[] = [];
  let i = 0;
  while ((i = src.indexOf('replaceChildren(', i)) >= 0) {
    const line = src.slice(0, i).split('\n').length;
    let depth = 1;
    let cur = '';
    let j = i + 'replaceChildren('.length;
    for (; j < src.length; j++) {
      const c = src[j] ?? '';
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      if (depth === 0) break;
      if (c === ',' && depth === 1) {
        out.push({ line, arg: cur.trim() });
        cur = '';
      } else cur += c;
    }
    if (cur.trim()) out.push({ line, arg: cur.trim() });
    i = j;
  }
  return out;
}

test('ui: replaceChildren is never given a null, which it would show as the text "null"', () => {
  // h() skips null children, but the DOM's replaceChildren turns them into text
  const bad = replaceChildrenArgs(APP).filter(({ arg }) => /(:\s*null|^null)$/.test(arg.replace(/\s+/g, ' ')));
  assert.deepEqual(
    bad.map((b) => `line ${b.line}: ${b.arg.slice(0, 80)}`),
    [],
  );
});
