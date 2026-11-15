// githttp.ts — the git smart-HTTP server: info/refs, upload-pack (protocol
// v2) and receive-pack (protocol v0). Written from the git wire format and
// the client's expectations; no git binary anywhere.
//
// Pkt-lines: a 4-hex-digit length (including the 4 header bytes) then the
// payload; "0000" is a flush, "0001" a delim, "0002" a response end.
// Sideband: inside a packfile section, each pkt-line's payload starts with a
// band byte (1 = pack data, 2 = progress, 3 = error).

import {
  collectReachable,
  hashObject,
  isOid,
  objectsToSend,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  ZERO_OID,
  type ObjType,
} from './gitobj.ts';
import { type Forge, type Repo, VIEWER } from './store.ts';

export const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line payload too large');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export type Packet =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole request body into pkt-line packets. */
export function decodePktLines(body: Buffer): Packet[] {
  const packets: Packet[] = [];
  let pos = 0;
  while (pos < body.length) {
    if (pos + 4 > body.length) throw new Error('truncated pkt-line header');
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      pos += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    packets.push({ kind: 'data', payload: Buffer.from(body.subarray(pos + 4, pos + len)) });
    pos += len;
  }
  return packets;
}

/** Split a request body at the first flush packet: [pkt-lines, rest]. */
export function splitAtFlush(body: Buffer): { packets: Packet[]; rest: Buffer } {
  let pos = 0;
  const packets: Packet[] = [];
  while (pos < body.length) {
    if (pos + 4 > body.length) throw new Error('truncated pkt-line header');
    const head = body.subarray(pos, pos + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      return { packets, rest: Buffer.from(body.subarray(pos + 4)) };
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (head === '0002') {
      packets.push({ kind: 'response-end' });
      pos += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > body.length) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    packets.push({ kind: 'data', payload: Buffer.from(body.subarray(pos + 4, pos + len)) });
    pos += len;
  }
  return { packets, rest: Buffer.alloc(0) };
}

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The peeled (commit) oid for a ref, when it points at an annotated tag. */
function peeledOf(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj?.type !== 'tag') return undefined;
  let cur = parseTag(obj.data).object;
  for (let i = 0; i < 10; i += 1) {
    const o = repo.objects.get(cur);
    if (o === undefined) return undefined;
    if (o.type === 'commit') return cur;
    if (o.type === 'tag') cur = parseTag(o.data).object;
    else return undefined;
  }
  return undefined;
}

// ------------------------------------------------------------------ info/refs

const UPLOAD_V2_CAPS = 'ls-refs=unborn fetch=shallow object-format=sha1 agent=forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=forge/1.0';

/** GET info/refs?service=... — the advertisement. */
export function infoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  // The Git-Protocol header carries "version=2" (not "2").
  const isV2 = gitProtocol !== undefined && gitProtocol.includes('version=2');
  if (service === 'git-upload-pack') {
    if (isV2) {
      // v2 capability advertisement
      const body = pktLines([
        `# service=git-upload-pack\n`,
        'flush',
        'version 2\n',
        'ls-refs=unborn\n',
        'fetch=shallow\n',
        'object-format=sha1\n',
        'agent=forge/1.0\n',
        'flush',
      ]);
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body };
    }
    // v0 ref advertisement
    const lines: (string | 'flush')[] = [`# service=git-upload-pack\n`, 'flush'];
    const refs = sortedRefs(repo);
    const headTarget = defaultBranchRef(repo);
    const caps = `symref=HEAD:${headTarget} side-band-64k ofs-delta agent=forge/1.0`;
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      refs.forEach((ref, i) => {
        const peeled = peeledOf(repo, ref.oid);
        if (i === 0) lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
        else lines.push(`${ref.oid} ${ref.name}\n`);
        if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
      });
      // HEAD line (with the same oid as the default branch, or zero)
      const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
      lines.push(`${headOid} HEAD\n`);
    }
    lines.push('flush');
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: pktLines(lines) };
  }
  if (service === 'git-receive-pack') {
    // v0 only, always
    const lines: (string | 'flush')[] = [`# service=git-receive-pack\n`, 'flush'];
    const refs = sortedRefs(repo);
    const headTarget = defaultBranchRef(repo);
    const caps = `report-status report-status-v2 delete-refs side-band-64k ofs-delta symref=HEAD:${headTarget} agent=forge/1.0`;
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      refs.forEach((ref, i) => {
        if (i === 0) lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
        else lines.push(`${ref.oid} ${ref.name}\n`);
        const peeled = peeledOf(repo, ref.oid);
        if (peeled !== undefined) lines.push(`${peeled} ${ref.name}^{}\n`);
      });
    }
    lines.push('flush');
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: pktLines(lines) };
  }
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
}

// --------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

/** Parse a v2 fetch request body into its arguments. */
function parseFetchV2(packets: Packet[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) {
      // command line and agent/object-format lines; ignore
      continue;
    }
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
    // thin-pack, no-progress, ofs-delta, filter: accepted, no behaviour change
  }
  return args;
}

/** Parse a v2 ls-refs request body. */
function parseLsRefs(packets: Packet[]): { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean } {
  const out = { prefixes: [] as string[], peel: false, symrefs: false, unborn: false };
  let seenDelim = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line === 'peel') out.peel = true;
    else if (line === 'symrefs') out.symrefs = true;
    else if (line === 'unborn') out.unborn = true;
    else if (line.startsWith('ref-prefix ')) out.prefixes.push(line.slice('ref-prefix '.length));
  }
  return out;
}

/** Build the ls-refs answer lines for a repo. */
function lsRefsLines(repo: Repo, opts: { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean }): string[] {
  const lines: string[] = [];
  const headTarget = defaultBranchRef(repo);
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (opts.symrefs && keep('HEAD')) {
    const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
    if (headOid === ZERO_OID) {
      if (opts.unborn) lines.push(`unborn HEAD symref-target:${headTarget}`);
    } else {
      lines.push(`${headOid} HEAD symref-target:${headTarget}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (opts.peel) {
      const peeled = peeledOf(repo, ref.oid);
      if (peeled !== undefined) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  // Note: an unborn default branch is conveyed ONLY by the HEAD line above
  // (as `unborn HEAD symref-target:...`). Emitting `unborn refs/heads/<branch>`
  // as its own line would make a client read the branch as existing with the
  // zero oid, which breaks empty-repo clones and the fixture's branch checks.
  return lines;
}

/** Compute the objects for a fetch: wants minus haves, honouring depth. */
function fetchObjects(
  repo: Repo,
  args: FetchArgs,
): { objects: Map<string, { type: ObjType; data: Buffer }>; shallow: string[]; unshallow: string[] } {
  const get = (oid: string) => repo.objects.get(oid);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== undefined && args.depth > 0) {
    // Shallow (deepen N): walk N levels from each want. Commits at depth
    // 0..N-1 are sent with their full trees; the commits at depth N-1 are
    // the shallow boundary (their parents are not sent). A previously
    // shallow commit whose parents are now included becomes unshallow.
    const N = args.depth;
    const objects = new Map<string, { type: ObjType; data: Buffer }>();
    const haves = new Set(args.haves);
    const addTree = (treeOid: string): void => {
      const stack = [treeOid];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = get(oid);
        if (obj === undefined) continue;
        objects.set(oid, obj);
        if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
        else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
      }
    };
    const queue: Array<{ oid: string; depth: number }> = [];
    const seenDepth = new Map<string, number>();
    for (const want of args.wants) {
      queue.push({ oid: want, depth: 0 });
    }
    while (queue.length > 0) {
      const { oid, depth } = queue.shift()!;
      const prev = seenDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
      seenDepth.set(oid, depth);
      const obj = get(oid);
      if (obj === undefined) continue;
      if (obj.type === 'commit') {
        if (depth >= N) continue;
        // A commit the client already has is not re-sent, but the walk
        // still passes THROUGH it: a deepen fetch wants the parents of a
        // tip the client holds (its haves name that tip).
        if (!haves.has(oid)) {
          objects.set(oid, obj);
          addTree(parseCommit(obj.data).tree);
        }
        if (depth === N - 1) {
          if (!shallow.includes(oid)) shallow.push(oid);
        } else {
          for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: depth + 1 });
        }
      } else if (obj.type === 'tag') {
        if (!haves.has(oid)) objects.set(oid, obj);
        queue.push({ oid: parseTag(obj.data).object, depth });
      } else {
        if (!haves.has(oid)) objects.set(oid, obj);
      }
    }
    for (const s of args.shallow) {
      const d = seenDepth.get(s);
      if (d !== undefined && d < N - 1 && !shallow.includes(s)) unshallow.push(s);
    }
    return { objects, shallow, unshallow };
  }
  const haves = new Set(args.haves);
  const objects = objectsToSend(get, args.wants, haves);
  return { objects, shallow, unshallow };
}

/** Wrap pack bytes in sideband band-1 pkt-lines (<= 65520 each). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65500;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

/** POST git-upload-pack: v2 ls-refs / fetch. */
export function uploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string | undefined,
): { status: number; contentType: string; body: Buffer } {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  let packets: Packet[];
  try {
    packets = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }
  const first = packets.find((p) => p.kind === 'data');
  const command = first?.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command.startsWith('command=ls-refs')) {
    const opts = parseLsRefs(packets);
    const lines = lsRefsLines(repo, opts);
    const out: (string | 'flush')[] = lines.map((l) => `${l}\n`);
    out.push('flush');
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: pktLines(out) };
  }
  if (command.startsWith('command=fetch')) {
    const args = parseFetchV2(packets);
    const wants = [...new Set(args.wants)].filter((w) => isOid(w));
    if (wants.length === 0) {
      // No wants: an empty fetch answers just the acknowledgments + flush.
      const body = pktLines(['acknowledgments\n', 'NAK\n', 'flush']);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body };
    }
    const { objects, shallow, unshallow } = fetchObjects(repo, args);
    const parts: Buffer[] = [];
    // acknowledgments section
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
      parts.push(pktDelim());
    }
    // packfile section
    parts.push(pktLine('packfile\n'));
    const pack = writePack(objects.values());
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  // Unknown command: a 400 with a JSON body keeps the server healthy.
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
}

// -------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST git-receive-pack (v0): apply a push. */
export function receivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) {
    return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Not Found' }) + '\n') };
  }
  let commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  try {
    const { packets, rest } = splitAtFlush(body);
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      let line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    if (rest.length > 0) pack = rest;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }
  if (commands.length === 0) {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message: 'Bad Request' }) + '\n') };
  }
  // Store the pack's objects (if any).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null && pack.length > 0) {
    try {
      const read = readPack(pack);
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: obj.type, data: obj.data });
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  // Apply each command; collect per-ref results.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // create or update: the new object must exist and be a commit/tag
      const newObj = repo.objects.get(cmd.newOid);
      if (newObj === undefined || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      // fast-forward check (branches only; tags may move only if forced — the
      // client never forces, so a non-fast-forward tag update is refused too)
      const newCommit = forge.peelToCommit(repo, cmd.newOid);
      if (newCommit === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'object is not a commit' });
        continue;
      }
      if (!forge.isAncestor(repo, current, newCommit)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }
  // Report, sideband-framed (band 1) as the client expects with side-band-64k.
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const report = pktLines(reportLines.map((l) => l as string));
  // Wrap the whole report in one band-1 sideband packet (it is small).
  const banded = pktLine(Buffer.concat([Buffer.from([1]), report]));
  const out = Buffer.concat([banded, pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: out };
}

// ------------------------------------------------------------ helpers for REST

/** The git object a ref resolves to, for the REST /git/refs surface. */
export function refTarget(repo: Repo, ref: string): { oid: string; type: ObjType } | undefined {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return undefined;
  const obj = repo.objects.get(oid);
  if (obj === undefined) return undefined;
  return { oid, type: obj.type };
}

export { hashObject, VIEWER };
export type { Repo };
