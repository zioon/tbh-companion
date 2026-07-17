// app/src/core/unityAssets/serializedFile.ts
// Minimal SerializedFile parser. Reads the object table so callers can locate
// raw object bytes by path_id / typeID. Does NOT parse TypeTrees (only skips
// them). Reference: AssetStudio SerializedFile.cs + UnityPy SerializedFile.py.
//
// Key format details discovered from the TBH shared_assets.bundle fixture:
//   - The standard 20-byte header is BIG ENDIAN (bundle convention).
//   - For SerializedFile version >= 22, 28 extra header bytes follow (also BE):
//       metadataSize (uint32), fileSize (int64), dataOffset (int64), unknown (int64)
//     The metadataSize/dataOffset from the standard 20-byte header are placeholders
//     and overwritten by these.
//   - After the header, reader endianness switches based on the endianness byte
//     (byte 16): 0 = LE, 1 = BE. TBH bundles use LE metadata.
//   - TypeTree (when enabled) uses the "blob" format (v >= 12):
//       nodeCount (int32), stringBlobSize (int32),
//       nodeCount * nodeSize bytes, stringBlobSize bytes
//     nodeSize = 24 for v < 19, 32 for v >= 19 (adds m_RefTypeHash uint64).
//   - For v >= 21, an int32 dependency-count + N int32 dependencies (align4)
//     follows the TypeTree blob.
//   - Objects (v >= 14): align4, pathId (int64), offset (int64 for v22 else uint32),
//     size (uint32), typeID (int32 index into types array).

export interface SerializedType {
  classID: number;
  isStrippedType: boolean;
  scriptTypeIndex: number;
  scriptID: Buffer; // 16 bytes (only meaningful when classID === 114 and scriptTypeIndex >= 0)
  oldTypeHash: Buffer; // 16 bytes
}

export interface SerializedObjectInfo {
  pathId: bigint;
  offset: number;
  size: number;
  typeID: number; // resolved class ID (e.g. 114 for MonoBehaviour)
  classID: number; // resolved class ID via types[typeID].classID
}

export interface ParsedSerializedFile {
  version: number;
  dataOffset: number;
  endianness: number;
  types: SerializedType[];
  objects: SerializedObjectInfo[];
  /** Returns the raw bytes for a given object within the SerializedFile buffer. */
  getObjectRaw(info: SerializedObjectInfo, data: Buffer): Buffer;
}

function readCString(buf: Buffer, offset: number): [string, number] {
  const end = buf.indexOf(0, offset);
  if (end === -1) return ["", offset];
  return [buf.subarray(offset, end).toString("utf-8"), end + 1];
}

function align4(n: number): number {
  return (n + 3) & ~3;
}

// TypeTree blob (v >= 12). Skips without parsing node contents.
// Layout: nodeCount (int32), stringBlobSize (int32), nodeCount*nodeSize, stringBlob.
// nodeSize = 24 (v < 19) or 32 (v >= 19, adds m_RefTypeHash uint64).
function skipTypeTree(buf: Buffer, p: number, version: number, le: boolean): number {
  const nodeCount = le ? buf.readInt32LE(p) : buf.readInt32BE(p); p += 4;
  const stringBlobSize = le ? buf.readInt32LE(p) : buf.readInt32BE(p); p += 4;
  const nodeSize = version >= 19 ? 32 : 24;
  p += nodeCount * nodeSize;
  p += stringBlobSize;
  return p;
}

export function parseSerializedFile(buf: Buffer): ParsedSerializedFile {
  if (buf.length < 20) throw new Error("SerializedFile too small");

  // Standard 20-byte header is BIG ENDIAN (UnityFS bundle convention).
  // For v < 22 these are the real metadataSize/dataOffset; for v >= 22 they
  // are placeholders and overwritten by the extra fields below.
  const metadataSize0 = buf.readUInt32BE(0);
  const fileType = buf.readInt32BE(4);
  const version = buf.readInt32BE(8);
  const dataOffset0 = buf.readUInt32BE(12);
  const endianness = buf.readUInt8(16);
  // 3 reserved bytes at 17-19.

  if (version < 17) {
    throw new Error(`Unsupported SerializedFile version: ${version} (need >= 17)`);
  }
  void fileType; // not exposed; kept for clarity

  let metadataSize: number = metadataSize0;
  let dataOffset: number = dataOffset0;
  let metaStart = 20;

  // For v >= 22, 28 extra header bytes follow (also BE, read before the
  // endianness byte takes effect).
  if (version >= 22) {
    metadataSize = buf.readUInt32BE(20);
    // fileSize (int64) at 24 — not needed
    dataOffset = Number(buf.readBigInt64BE(32));
    // unknown (int64) at 40 — not needed
    metaStart = 48;
  }

  const le = endianness === 0; // 0 = LE, 1 = BE

  const meta = buf.subarray(metaStart, metaStart + metadataSize);
  let p = 0;

  // unityVersion: cstring (read to advance p; value not exposed)
  const uv = readCString(meta, p);
  p = uv[1];

  // targetPlatform: int32
  p += 4;

  // enableTypeTree: byte
  const enableTypeTree = meta.readUInt8(p) !== 0; p += 1;

  // Types.
  const typeCount = le ? meta.readInt32LE(p) : meta.readInt32BE(p); p += 4;
  const types: SerializedType[] = [];
  for (let i = 0; i < typeCount; i++) {
    const classID = le ? meta.readInt32LE(p) : meta.readInt32BE(p); p += 4;
    const isStrippedType = meta.readUInt8(p) !== 0; p += 1;
    const scriptTypeIndex = le ? meta.readInt16LE(p) : meta.readInt16BE(p); p += 2;
    // scriptID (16 bytes) only when classID === 114 (MonoBehaviour) for v >= 16.
    // Default to a zeroed buffer; replaced by a subarray view when present.
    // Explicit `Buffer` annotation widens to `Buffer<ArrayBufferLike>` so both
    // `Buffer.alloc` (Buffer<ArrayBuffer>) and `subarray` (Buffer<ArrayBufferLike>)
    // are assignable.
    let scriptID: Buffer = Buffer.alloc(16);
    if (classID === 114) {
      scriptID = meta.subarray(p, p + 16); p += 16;
    }
    const oldTypeHash: Buffer = meta.subarray(p, p + 16); p += 16;
    if (enableTypeTree) {
      p = skipTypeTree(meta, p, version, le);
      // type_dependencies (int32 count + N int32) for v >= 21. No alignment
      // after this field (matches the read-side behavior of AssetStudio/UnityPy;
      // alignment happens later before each object's pathId).
      if (version >= 21) {
        const depCount = le ? meta.readInt32LE(p) : meta.readInt32BE(p); p += 4;
        p += depCount * 4;
      }
    }
    types.push({ classID, isStrippedType, scriptTypeIndex, scriptID, oldTypeHash });
  }

  // Objects.
  const objectCount = le ? meta.readInt32LE(p) : meta.readInt32BE(p); p += 4;
  const objects: SerializedObjectInfo[] = [];
  for (let i = 0; i < objectCount; i++) {
    p = align4(p);
    // pathId: int64 (v >= 14)
    const pathId = le ? meta.readBigInt64LE(p) : meta.readBigInt64BE(p); p += 8;
    // offset: int64 (v >= 22) or uint32 (older). Relative to dataOffset.
    let offset: number;
    if (version >= 22) {
      offset = Number(le ? meta.readBigInt64LE(p) : meta.readBigInt64BE(p)); p += 8;
    } else {
      offset = le ? meta.readUInt32LE(p) : meta.readUInt32BE(p); p += 4;
    }
    // size: uint32
    const size = le ? meta.readUInt32LE(p) : meta.readUInt32BE(p); p += 4;
    // typeID: int32 (index into types array)
    const typeIDIndex = le ? meta.readInt32LE(p) : meta.readInt32BE(p); p += 4;
    const resolvedClassID = types[typeIDIndex]?.classID ?? typeIDIndex;
    objects.push({
      pathId,
      offset,
      size,
      typeID: resolvedClassID,
      classID: resolvedClassID,
    });
  }

  // Scripts, externals, refTypes, userInformation are not needed for object
  // raw-byte access; we stop reading here.

  return {
    version,
    dataOffset,
    endianness,
    types,
    objects,
    getObjectRaw: (info, data) => {
      const start = dataOffset + info.offset;
      return data.subarray(start, start + info.size);
    },
  };
}
