// Type declarations for the untyped `lz4js` package (v0.2.0).
// The package ships only CommonJS JavaScript with no .d.ts; we declare the
// raw-block primitive used by the UnityFS bundle parser here.
//
// We use `export =` so both `import lz4 from "lz4js"` (with esModuleInterop)
// and `import * as lz4 from "lz4js"` work at the call site.
//
// Resolution: tsconfig.json maps `"lz4js"` -> this file via `paths`, so TS uses
// these types for type-checking while the bundler still resolves to
// node_modules/lz4js/lz4.js at runtime.

declare const lz4: {
  compressBound(n: number): number;
  decompressBound(src: Uint8Array): number;
  makeBuffer(n: number): Uint8Array;
  decompressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    dIndex: number,
  ): number;
  compressBlock(
    src: Uint8Array,
    dst: Uint8Array,
    sIndex: number,
    sLength: number,
    hashTable: number[],
  ): number;
  decompressFrame(src: Uint8Array, dst: Uint8Array): number;
  compressFrame(src: Uint8Array, dst: Uint8Array): number;
  decompress(src: Uint8Array, maxSize?: number): Uint8Array;
  compress(src: Uint8Array, maxSize?: number): Uint8Array;
};

export = lz4;
