# QR Code generator library (vendored)

- **Source:** https://github.com/nayuki/QR-Code-generator, `typescript-javascript/qrcodegen.ts`, from commit `bcfe1b018cec5f1f91b5705eca5bb4cdd34e9f8d` (2026-10-29).
- **Author:** Project Nayuki. **Licence:** MIT; see `LICENSE`, copied from the file's header.

The upstream file is unchanged except for two marked lines:

1. A `// @ts-nocheck` line at the top. ContextDeck compiles with `noUncheckedIndexedAccess`, which the upstream code wasn't written for.
2. An `export default qrcodegen;` line at the end. Upstream declares a global namespace, and ContextDeck is ES modules.

Don't edit it otherwise. To update it, replace the body with a newer upstream copy, keep those two lines, and change the commit above.
