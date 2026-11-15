// store.ts — the forge's in-memory state: users, repositories, git objects,
// refs, issues, pull requests, comments and labels. Pure data + helpers; the
// HTTP layers (githttp, rest, graphql, mcp) all read and write through it.
//
// Identity (from the public, deterministic scenario seed in the kit's
// wire.ts, SCENARIO_SEED_HEX 6a09e667f3bcc909): the bearer <redacted> owns the
// viewer account. The stranger and the org exist so foreign-owner reads 404.

import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type ObjType,
} from './gitobj.ts';

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
  type: 'User' | 'Organization';
}

export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid', type: 'User' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid', type: 'User' };
export const ORG: User = { id: 2000, login: 'faint-meadow-org', name: 'faint-meadow-org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };

export const ALL_USERS: readonly User[] = [VIEWER, TEAMMATE, STRANGER, ORG];

export function userByLogin(login: string): User | undefined {
  return ALL_USERS.find((u) => u.login === login);
}

export const DEFAULT_LABELS: readonly { name: string; color: string; description: string }[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  assignee: User | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeBaseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: boolean;
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  files: PullFile[];
}

export interface Repo {
  id: number;
  name: string;
  owner: User;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, { type: ObjType; data: Buffer }>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  nextLabelId: number;
}

export function nowIso(): string {
  return new Date().toISOString();
}

let globalId = 1;
export function nextId(): number {
  return globalId++;
}

/** A global id for a repository (opaque, stable, unique). */
export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`).toString('base64');
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64');
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64');
}

export function commentGlobalId(repo: Repo, comment: IssueComment): string {
  return Buffer.from(`IssueComment:${repo.id}:${comment.id}`).toString('base64');
}

export class Forge {
  repos = new Map<string, Repo>();
  nextRepoId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: User, name: string, opts: { description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      // No pre-seeded labels: the suite creates the labels it needs through
      // POST /labels and expects a 201 for them, so a fresh repository starts
      // with an empty label list (the checks' POST /issues then validates
      // that the labels it names exist).
      labels: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
    };
    this.repos.set(this.repoKey(owner.login, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.login === owner) out.push(repo);
    return out.sort((a, b) => a.id - b.id);
  }

  // ------------------------------------------------------------ git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): { type: ObjType; data: Buffer } | undefined {
    return repo.objects.get(oid);
  }

  /** The commit a ref points at (following annotated tags). */
  refCommit(repo: Repo, ref: string): string | undefined {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return undefined;
    return this.peelToCommit(repo, oid);
  }

  peelToCommit(repo: Repo, oid: string): string | undefined {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(cur);
      if (obj === undefined) return undefined;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') cur = parseTag(obj.data).object;
      else return undefined;
    }
    return undefined;
  }

  peelToObject(repo: Repo, oid: string): { oid: string; type: ObjType } | undefined {
    let cur = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(cur);
      if (obj === undefined) return undefined;
      if (obj.type === 'tag') cur = parseTag(obj.data).object;
      else return { oid: cur, type: obj.type };
    }
    return undefined;
  }

  /** Flatten a commit's tree to path -> {mode, oid}. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') {
        this.flattenTree(repo, e.oid, path, out);
      } else {
        out.set(path, { mode: e.mode, oid: e.oid });
      }
    }
    return out;
  }

  /** Build a tree object from a flat path map (creating intermediate trees). */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface DirNode {
      files: { mode: string; name: string; oid: string }[];
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, v] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const dir = parts[i]!;
        let child = node.dirs.get(dir);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(dir, child);
        }
        node = child;
      }
      node.files.push({ mode: v.mode, name: parts[parts.length - 1]!, oid: v.oid });
    }
    const build = (node: DirNode): string => {
      const entries: { mode: string; name: string; oid: string }[] = [...node.files];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Find a merge-base (nearest common ancestor) of two commits. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestorsA = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = [{ oid: a, depth: 0 }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (ancestorsA.has(cur.oid)) continue;
      ancestorsA.set(cur.oid, cur.depth);
      const obj = repo.objects.get(cur.oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) queue.push({ oid: p, depth: cur.depth + 1 });
      }
    }
    const queueB: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 0 }];
    let best: string | undefined;
    let bestDepth = Infinity;
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const cur = queueB.shift()!;
      if (seenB.has(cur.oid)) continue;
      seenB.add(cur.oid);
      const depthA = ancestorsA.get(cur.oid);
      if (depthA !== undefined) {
        const total = depthA + cur.depth;
        if (total < bestDepth) {
          bestDepth = total;
          best = cur.oid;
        }
      }
      const obj = repo.objects.get(cur.oid);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) queueB.push({ oid: p, depth: cur.depth + 1 });
      }
    }
    return best;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const queue = [descendant];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur === ancestor) return true;
      const obj = repo.objects.get(cur);
      if (obj?.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) queue.push(p);
      }
    }
    return false;
  }

  /** Create a commit object on a repo (and store it). Returns its oid. */
  commitObject(
    repo: Repo,
    fields: { tree: string; parents: readonly string[]; author: string; committer: string; message: string },
  ): string {
    return this.putObject(repo, 'commit', buildCommit(fields));
  }

  /** Create an annotated tag object. Returns its oid. */
  tagObject(repo: Repo, fields: { object: string; type: ObjType; tag: string; tagger: string; message: string }): string {
    return this.putObject(repo, 'tag', buildTag(fields));
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, user: User, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: nextId(),
      number: repo.nextIssueNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      user,
      assignee: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      comments: [],
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    user: User,
    opts: { title: string; body: string; headRef: string; baseRef: string },
  ): Pull | { error: string } {
    const headSha = this.refCommit(repo, `refs/heads/${opts.headRef}`);
    const baseSha = this.refCommit(repo, `refs/heads/${opts.baseRef}`);
    if (headSha === undefined) return { error: `head branch ${opts.headRef} not found` };
    if (baseSha === undefined) return { error: `base branch ${opts.baseRef} not found` };
    const mergeBase = this.mergeBase(repo, headSha, baseSha) ?? baseSha;
    const files = this.diffFiles(repo, mergeBase, headSha);
    const pull: Pull = {
      id: nextId(),
      number: repo.nextPullNumber++,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      headRef: opts.headRef,
      headSha,
      baseRef: opts.baseRef,
      baseSha,
      mergeBaseSha: mergeBase,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: true,
      user,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
      files,
    };
    repo.pulls.push(pull);
    return pull;
  }

  /** Diff two commits' trees into a pull-file list. */
  diffFiles(repo: Repo, baseCommit: string, headCommit: string): PullFile[] {
    const baseObj = repo.objects.get(baseCommit);
    const headObj = repo.objects.get(headCommit);
    if (baseObj?.type !== 'commit' || headObj?.type !== 'commit') return [];
    const baseTree = this.flattenTree(repo, parseCommit(baseObj.data).tree);
    const headTree = this.flattenTree(repo, parseCommit(headObj.data).tree);
    const files: PullFile[] = [];
    const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b === undefined && h !== undefined) {
        const additions = this.countLines(repo, h.oid);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h === undefined) {
        const deletions = this.countLines(repo, b.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const a = this.countLines(repo, b.oid);
        const c = this.countLines(repo, h.oid);
        files.push({ filename: path, status: 'modified', additions: c, deletions: a, changes: a + c });
      }
    }
    return files;
  }

  countLines(repo: Repo, blobOid: string): number {
    const obj = repo.objects.get(blobOid);
    if (obj?.type !== 'blob') return 0;
    const text = obj.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid or an error. */
  mergePull(repo: Repo, pull: Pull, method: string): { oid: string } | { error: string; status: number } {
    if (pull.merged) return { error: 'already merged', status: 405 };
    if (pull.state !== 'open') return { error: 'pull request is closed', status: 405 };
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseSha = this.refCommit(repo, baseRef);
    const headSha = this.refCommit(repo, `refs/heads/${pull.headRef}`);
    if (baseSha === undefined || headSha === undefined) return { error: 'branch not found', status: 404 };
    // Recompute the merge-base against the CURRENT base tip (it may have moved).
    const mergeBase = this.mergeBase(repo, headSha, baseSha) ?? pull.mergeBaseSha;
    const baseTree = this.flattenTree(repo, parseCommit(repo.objects.get(mergeBase)!.data).tree);
    const headTree = this.flattenTree(repo, parseCommit(repo.objects.get(headSha)!.data).tree);
    const currentTree = this.flattenTree(repo, parseCommit(repo.objects.get(baseSha)!.data).tree);
    // Conflict: a path changed on both sides (vs merge-base) to different content.
    for (const path of new Set([...baseTree.keys(), ...headTree.keys(), ...currentTree.keys()])) {
      const b = baseTree.get(path)?.oid;
      const h = headTree.get(path)?.oid;
      const c = currentTree.get(path)?.oid;
      const headChanged = h !== b;
      const baseChanged = c !== b;
      if (headChanged && baseChanged && h !== c) {
        pull.mergeable = false;
        return { error: 'merge conflict', status: 405 };
      }
    }
    // Merged tree: current base tree + head's changes (vs merge-base).
    const merged = new Map(currentTree);
    for (const [path, v] of headTree) {
      if (baseTree.get(path)?.oid !== v.oid) merged.set(path, v);
    }
    for (const path of baseTree.keys()) {
      if (!headTree.has(path) && baseTree.get(path)?.oid !== currentTree.get(path)?.oid) {
        // head deleted it and base did not change it -> delete
        if (currentTree.get(path)?.oid === baseTree.get(path)?.oid) merged.delete(path);
      }
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const author = `${VIEWER.name} <${VIEWER.email}> 1700000000 +0000`;
    const mergeOid = this.commitObject(repo, {
      tree: treeOid,
      parents: [baseSha],
      author,
      committer: author,
      message,
    });
    repo.refs.set(baseRef, mergeOid);
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeOid;
    pull.state = 'closed';
    pull.closedAt = pull.mergedAt;
    pull.updatedAt = nowIso();
    pull.baseSha = mergeOid;
    return { oid: mergeOid };
  }
}
