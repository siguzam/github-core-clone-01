// gitobj.ts — the git object model, in pure Node 22 (node:crypto, node:zlib only).
//
// This is my own implementation of the git object format, written for this
// bounty. It covers: loose objects (zlib of "type size\0data", SHA-1 addressed),
// trees / commits / tags (parse + build), pack files (read + write, OFS_DELTA
// and REF_DELTA resolution), and reachability walks. No git binary is used.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

export const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isOid(v: string): boolean {
  return /^[0-9a-f]{40}$/.test(v);
}

/** SHA-1 of a git object: sha1("<type> <size>\0" + data). */
export function hashObject(type: ObjType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** The loose-object bytes for an object (zlib of the header + data). */
export function encodeLoose(type: ObjType, data: Uint8Array): Buffer {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return deflateSync(Buffer.concat([head, Buffer.from(data)]));
}

/** Decode loose-object bytes back to {type, data}. */
export function decodeLoose(raw: Uint8Array): { type: ObjType; data: Buffer } {
  const inflated = inflateSync(raw);
  const nul = inflated.indexOf(0);
  const head = inflated.subarray(0, nul).toString('ascii');
  const [type, sizeStr] = head.split(' ');
  const size = parseInt(sizeStr ?? '0', 10);
  const data = Buffer.from(inflated.subarray(nul + 1));
  if (data.length !== size) throw new Error(`loose object size mismatch: header ${size}, got ${data.length}`);
  if (type !== 'blob' && type !== 'tree' && type !== 'commit' && type !== 'tag') throw new Error(`unknown object type ${type}`);
  return { type: type as ObjType, data };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries (in stored order). */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree entry has no space after mode');
    const nul = data.indexOf(0, sp);
    if (nul < 0) throw new Error('tree entry has no NUL after name');
    const mode = Buffer.from(data.subarray(off, sp)).toString('ascii');
    const name = Buffer.from(data.subarray(sp + 1, nul)).toString('utf8');
    const oid = Buffer.from(data.subarray(nul + 1, nul + 21)).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directories sort as if their name had a trailing '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

/** Build a tree object's bytes from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Uint8Array): CommitView {
  const raw = Buffer.from(data);
  const text = raw.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const p of fields.parents) lines.push(`parent ${p}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: { object: string; type: ObjType; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- packs

export interface PackObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

export interface PackRead {
  objects: Map<string, PackObject>;
  count: number;
  deltaCount: number;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta varint overruns');
      const b = delta[pos++]!;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++]!;
      if (op & 0x02) offset |= delta[pos++]! << 8;
      if (op & 0x04) offset |= delta[pos++]! << 16;
      if (op & 0x08) offset |= delta[pos++]! << 24;
      if (op & 0x10) size = delta[pos++]!;
      if (op & 0x20) size |= delta[pos++]! << 8;
      if (op & 0x40) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy overruns base');
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert overruns');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== resultSize) throw new Error(`delta result size ${total} != ${resultSize}`);
  return Buffer.concat(out);
}

function readPackObjectHeader(buf: Buffer, start: number): { typeNum: number; size: number; next: number } {
  let pos = start;
  const first = buf[pos++]!;
  const typeNum = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let shift = 4;
  let b = first;
  while ((b & 0x80) !== 0) {
    if (pos >= buf.length) throw new Error('pack object header overruns');
    b = buf[pos++]!;
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { typeNum, size, next: pos };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes, so the stream's length is found by
  // binary search for the smallest prefix that inflates.
  const max = buf.length - offset;
  if (max <= 0) throw new Error('pack object zlib stream is empty');
  try {
    inflateSync(buf.subarray(offset, offset + max));
  } catch {
    throw new Error('pack object zlib stream does not terminate');
  }
  let lo = 1;
  let hi = max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, offset + lo));
  return { data, next: offset + lo };
}

/** Read a pack file (v2) into objects, resolving deltas. */
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack file');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // trailer checksum: last 20 bytes must be sha1 of the rest
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, PackObject>();
  const offsetToOid = new Map<number, string>();
  const pending: Array<{ offset: number; data: Buffer; baseOid?: string; baseOffset?: number }> = [];
  let deltaCount = 0;
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const startOffset = pos;
    const { typeNum, size, next } = readPackObjectHeader(pack, pos);
    pos = next;
    if (typeNum === 6 || typeNum === 7) {
      deltaCount += 1;
      let baseOid: string | undefined;
      let baseOffset: number | undefined;
      if (typeNum === 7) {
        baseOid = pack.subarray(pos, pos + 20).toString('hex');
        pos += 20;
      } else {
        // OFS_DELTA: offset encoded as a variable-length value
        let b = pack[pos++]!;
        let baseOff = b & 0x7f;
        while (b & 0x80) {
          b = pack[pos++]!;
          baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
        }
        baseOffset = startOffset - baseOff;
      }
      const { data, next: after } = inflateAt(pack, pos);
      pos = after;
      pending.push({ offset: startOffset, data, baseOid, baseOffset });
      void size;
    } else {
      const type = CODE_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const { data, next: after } = inflateAt(pack, pos);
      pos = after;
      if (data.length !== size) throw new Error(`pack object size mismatch: header ${size}, got ${data.length}`);
      const oid = hashObject(type, data);
      objects.set(oid, { type, data, oid });
      offsetToOid.set(startOffset, oid);
    }
  }
  // Resolve deltas (possibly chained): iterate until all resolve.
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0) {
    if (guard++ > count + 5) throw new Error('delta chain does not resolve');
    const next: typeof remaining = [];
    let progressed = false;
    for (const d of remaining) {
      let base: PackObject | undefined;
      if (d.baseOid !== undefined) base = objects.get(d.baseOid);
      else if (d.baseOffset !== undefined) {
        const oid = offsetToOid.get(d.baseOffset);
        if (oid) base = objects.get(oid);
      }
      if (base === undefined) {
        next.push(d);
        continue;
      }
      const data = applyDelta(base.data, d.data);
      const oid = hashObject(base.type, data);
      objects.set(oid, { type: base.type, data, oid });
      offsetToOid.set(d.offset, oid);
      progressed = true;
    }
    if (!progressed && next.length > 0) throw new Error('unresolvable delta base');
    remaining = next;
  }
  return { objects, count, deltaCount };
}

/** Write a pack file (v2) from objects, without deltas (all full objects). */
export function writePack(objects: Iterable<{ type: ObjType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const obj of list) {
    const typeNum = TYPE_CODE[obj.type];
    const size = obj.data.length;
    // pack object header: type in bits 4-6, size low 4 bits, continuation
    const headerBytes: number[] = [];
    let s = size;
    let first = (typeNum << 4) | (s & 0x0f);
    s >>= 4;
    if (s > 0) first |= 0x80;
    headerBytes.push(first);
    while (s > 0) {
      let b = s & 0x7f;
      s >>= 7;
      if (s > 0) b |= 0x80;
      headerBytes.push(b);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Collect the objects reachable from `tips` in `get` (object store lookup). */
export function collectReachable(
  get: (oid: string) => { type: ObjType; data: Buffer } | undefined,
  tips: readonly string[],
): Map<string, { type: ObjType; data: Buffer }> {
  const out = new Map<string, { type: ObjType; data: Buffer }>();
  const stack = [...tips];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Objects reachable from `tips` but NOT from `haves` (for fetch negotiation). */
export function objectsToSend(
  get: (oid: string) => { type: ObjType; data: Buffer } | undefined,
  wants: readonly string[],
  haves: ReadonlySet<string>,
): Map<string, { type: ObjType; data: Buffer }> {
  const haveReachable = new Set<string>();
  {
    const stack = [...haves];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      haveReachable.add(oid);
      const obj = get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        if (c.tree) stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
  }
  const out = new Map<string, { type: ObjType; data: Buffer }>();
  const stack = [...wants];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || haveReachable.has(oid)) continue;
    seen.add(oid);
    const obj = get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
