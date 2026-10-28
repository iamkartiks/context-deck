#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on Node 22. Hide only that one,
// before the module is loaded, and let every other warning through.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { main } = await import('../dist/src/cli.js');
process.exitCode = await main(process.argv.slice(2));
