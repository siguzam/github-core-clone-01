// rest.ts — the GitHub REST v3 surface under /api/v3. Repositories, branches,
// commits, contents, labels, issues (+ comments) and pull requests (+ files,
// merges). Shapes and status codes follow GitHub's v3 API as the suite's
// checks read them; error bodies are always {"message": string}.

import { buildCommit, buildTree, hashObject, parseCommit, parseTree, type ObjType } from './gitobj.ts';
import {
  VIEWER,
  type Forge,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type User,
} from './store.ts';

export interface RestContext {
  forge: Forge;
  baseUrl: string;
  token: string | undefined;
}

export type Json = Record<string, unknown>;

export function jsonError(message: string): Json {
  return { message };
}

export function userJson(u: User): Json {
  return {
    login: u.login,
    id: u.id,
    node_id: Buffer.from(`User:${u.id}`).toString('base64'),
    avatar_url: `https://example.invalid/avatar/${u.login}`,
    gravatar_id: '',
    url: `/api/v3/users/${u.login}`,
    html_url: `https://example.invalid/${u.login}`,
    type: u.type,
    site_admin: false,
  };
}

export function repoJson(repo: Repo, baseUrl: string): Json {
  const owner = repo.owner;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${owner.login}/${repo.name}`,
    owner: userJson(owner),
    private: repo.private,
    html_url: `https://example.invalid/${owner.login}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${owner.login}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${owner.login}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${owner.login}/${repo.name}.git`,
    clone_url: `https://example.invalid/${owner.login}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: repo.issues.filter((i) => i.state === 'open').length,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

export function labelJson(repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: Buffer.from(`Label:${repo.id}:${label.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner.login}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://example.invalid/${repo.owner.login}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((l) => l.name === name);
      return found !== undefined
        ? labelJson(repo, found)
        : { id: 0, node_id: '', url: '', name, color: 'ededed', description: '', default: false };
    }),
    assignee: issue.assignee !== null ? userJson(issue.assignee) : null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

export function pullJson(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner.login}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://example.invalid/${repo.owner.login}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://example.invalid/${repo.owner.login}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userJson(VIEWER) : null,
    head: {
      label: `${repo.owner.login}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, ''),
    },
    base: {
      label: `${repo.owner.login}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: userJson(repo.owner),
      repo: repoJson(repo, ''),
    },
    _links: {},
    author_association: 'OWNER',
    draft: false,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Json {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${comment.id}`).toString('base64'),
    url: `/api/v3/repos/${repo.owner.login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner.login}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

// ------------------------------------------------------------------ helpers

export function paginate<T>(items: readonly T[], page: number, perPage: number): { page: T[]; total: number; pageCount: number } {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const p = Math.min(Math.max(1, page), pageCount);
  const start = (p - 1) * perPage;
  return { page: items.slice(start, start + perPage), total, pageCount };
}

/** Build a GitHub-style Link header for a paginated collection. */
export function linkHeader(base: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (page < pageCount) parts.push(`${urlFor(page + 1)}; rel="next"`);
  if (pageCount > 1) parts.push(`${urlFor(pageCount)}; rel="last"`);
  if (page > 1) {
    parts.push(`${urlFor(1)}; rel="first"`);
    parts.push(`${urlFor(page - 1)}; rel="prev"`);
  }
  return parts.join(', ');
}

export function parsePage(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function authorLine(user: User): string {
  return `${user.name} <${user.email}> 1700000000 +0000`;
}

/** Commit a file change (create/update/delete) on a branch; returns the new commit oid. */
export function commitFile(
  forge: Forge,
  repo: Repo,
  opts: { branch: string; path: string; content: Buffer | null; message: string },
): { commitOid: string; blobOid: string | null } {
  const ref = `refs/heads/${opts.branch}`;
  const tip = forge.refCommit(repo, ref);
  const parentTree = tip !== undefined ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  const flat = parentTree !== null ? forge.flattenTree(repo, parentTree) : new Map<string, { mode: string; oid: string }>();
  let blobOid: string | null = null;
  if (opts.content !== null) {
    blobOid = forge.putObject(repo, 'blob', opts.content);
    flat.set(opts.path, { mode: '100644', oid: blobOid });
  } else {
    flat.delete(opts.path);
  }
  const treeOid = forge.buildTreeFromFlat(repo, flat);
  const author = authorLine(VIEWER);
  const commitOid = forge.commitObject(repo, {
    tree: treeOid,
    parents: tip !== undefined ? [tip] : [],
    author,
    committer: author,
    message: opts.message,
  });
  repo.refs.set(ref, commitOid);
  repo.updatedAt = new Date().toISOString();
  return { commitOid, blobOid };
}

/** List commits reachable from a ref, newest first (by commit order, BFS by date). */
export function listCommits(forge: Forge, repo: Repo, ref: string): string[] {
  const tip = forge.refCommit(repo, ref);
  if (tip === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    out.push(oid);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  return out;
}

export function commitJson(repo: Repo, oid: string): Json {
  const obj = repo.objects.get(oid);
  if (obj?.type !== 'commit') return {};
  const c = parseCommit(obj.data);
  const [authorName = '', authorEmail = ''] = c.author.split(' <');
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author: { name: authorName, email: authorEmail.replace(/>.*$/, ''), date: new Date(1700000000000).toISOString() },
      committer: { name: authorName, email: authorEmail.replace(/>.*$/, ''), date: new Date(1700000000000).toISOString() },
      message: c.message,
      tree: { sha: c.tree, url: '' },
      url: '',
      comment_count: 0,
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: null,
    committer: null,
    parents: c.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

export function branchJson(repo: Repo, ref: string): Json {
  const oid = repo.refs.get(ref) ?? '';
  return {
    name: ref.replace('refs/heads/', ''),
    commit: { sha: oid, url: '' },
    protected: false,
  };
}

// ------------------------------------------------------------------ the router

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  bodyText: string;
}

export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The bearer token the caller presented, or null. */
export function bearerToken(headers: Record<string, string | undefined>): string | null {
  const h = headers.authorization ?? headers.Authorization;
  if (h === undefined) return null;
  const m = /^Bearer\s+(.+)$/.exec(h.trim());
  return m === null ? null : m[1]!;
}

/** Is the presented token the entry's token? (No token configured = accept any non-empty token, local dev only.) */
export function tokenOk(ctx: RestContext, presented: string | null): boolean {
  if (presented === null || presented === '') return false;
  if (ctx.token === undefined || ctx.token === '') return true;
  return presented === ctx.token;
}

function parseBody(req: RestRequest): { ok: true; json: unknown } | { ok: false; error: string } {
  if (req.bodyText === '') return { ok: true, json: {} };
  try {
    return { ok: true, json: JSON.parse(req.bodyText) };
  } catch {
    return { ok: false, error: 'Problems parsing JSON' };
  }
}

function bodyObj(json: unknown): Record<string, unknown> | null {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
  return null;
}

/** Resolve a repo the token owner may see; foreign-owner names are 404, never 403. */
function visibleRepo(ctx: RestContext, owner: string, name: string): Repo | undefined {
  const repo = ctx.forge.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (repo.owner.login !== VIEWER.login && repo.owner.login !== 'faint-meadow-org') return undefined;
  return repo;
}

export function handleRest(ctx: RestContext, req: RestRequest): RestResponse {
  const { forge } = ctx;
  const segs = req.path.split('/').filter((s) => s !== '');
  // segs[0] === 'api', segs[1] === 'v3'
  const rest = segs.slice(2);

  // ---- API root
  if (rest.length === 0) {
    if (req.method !== 'GET') return { status: 404, body: jsonError('Not Found') };
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  // ---- /meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (req.method !== 'GET') return { status: 404, body: jsonError('Not Found') };
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: true } };
  }

  // ---- /user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (req.method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
      const body = bodyObj(parsed.json);
      const name = body !== null ? String(body.name ?? '') : '';
      if (name === '') return { status: 422, body: jsonError('name is required') };
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return { status: 422, body: jsonError('name already exists on this account') };
      }
      const repo = forge.createRepo(VIEWER, name, {
        description: body !== null && typeof body.description === 'string' ? body.description : '',
        private: body !== null && body.private === true,
        defaultBranch: body !== null && typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      return { status: 201, body: repoJson(repo, ctx.baseUrl) };
    }
    if (req.method === 'GET') {
      const { page, perPage } = parsePage(req.query);
      const all = forge.reposOf(VIEWER.login);
      const { page: items, total } = paginate(all, page, perPage);
      const link = linkHeader(`${ctx.baseUrl}/api/v3/user/repos`, req.query, page, perPage, total);
      return {
        status: 200,
        body: items.map((r) => repoJson(r, ctx.baseUrl)),
        headers: link !== '' ? { link } : {},
      };
    }
    return { status: 404, body: jsonError('Not Found') };
  }

  // ---- /orgs/{org}/repos
  if (rest.length === 3 && rest[0] === 'orgs' && rest[2] === 'repos') {
    const org = userByLoginLocal(rest[1]!);
    if (org === undefined || org.type !== 'Organization') return { status: 404, body: jsonError('Not Found') };
    if (req.method === 'POST') {
      const parsed = parseBody(req);
      if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
      const body = bodyObj(parsed.json);
      const name = body !== null ? String(body.name ?? '') : '';
      if (name === '') return { status: 422, body: jsonError('name is required') };
      if (forge.getRepo(org.login, name) !== undefined) {
        return { status: 422, body: jsonError('name already exists on this account') };
      }
      const repo = forge.createRepo(org, name, {
        description: body !== null && typeof body.description === 'string' ? body.description : '',
        private: body !== null && body.private === true,
        defaultBranch: body !== null && typeof body.default_branch === 'string' ? body.default_branch : 'main',
      });
      return { status: 201, body: repoJson(repo, ctx.baseUrl) };
    }
    return { status: 404, body: jsonError('Not Found') };
  }

  // ---- /repos/{owner}/{repo}/...
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1]!;
    const name = rest[2]!;
    const repo = visibleRepo(ctx, owner, name);
    const sub = rest.slice(3);
    if (repo === undefined) return { status: 404, body: jsonError('Not Found') };

    // GET / PATCH / DELETE the repo itself
    if (sub.length === 0) {
      if (req.method === 'GET') return { status: 200, body: repoJson(repo, ctx.baseUrl) };
      if (req.method === 'PATCH') {
        const parsed = parseBody(req);
        if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
        const body = bodyObj(parsed.json);
        if (body !== null) {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.private = body.private;
          if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch;
        }
        repo.updatedAt = new Date().toISOString();
        return { status: 200, body: repoJson(repo, ctx.baseUrl) };
      }
      if (req.method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204, body: '' };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    // ---- /git/refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (req.method === 'POST' && sub.length === 2) {
        const parsed = parseBody(req);
        if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
        const body = bodyObj(parsed.json);
        const ref = body !== null ? String(body.ref ?? '') : '';
        const sha = body !== null ? String(body.sha ?? '') : '';
        if (ref === '' || sha === '') return { status: 422, body: jsonError('ref and sha are required') };
        if (repo.refs.has(ref)) return { status: 422, body: jsonError('Reference already exists') };
        const obj = repo.objects.get(sha);
        if (obj === undefined) return { status: 422, body: jsonError('Object does not exist') };
        repo.refs.set(ref, sha);
        return { status: 201, body: { ref, node_id: Buffer.from(`Ref:${sha}`).toString('base64'), url: '', object: { sha, type: obj.type, url: '' } } };
      }
      if (req.method === 'GET') {
        // GET /git/refs[/heads/...] — list, or one ref
        const refPath = sub.slice(2).join('/');
        if (refPath === '') {
          const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
          return { status: 200, body: refs };
        }
        const ref = `refs/${refPath}`;
        const oid = repo.refs.get(ref);
        if (oid === undefined) return { status: 404, body: jsonError('Not Found') };
        return { status: 200, body: { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } } };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    // ---- /branches
    if (sub.length === 1 && sub[0] === 'branches' && req.method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => branchJson(repo, r));
      return { status: 200, body: branches };
    }

    // ---- /commits
    if (sub.length === 1 && sub[0] === 'commits' && req.method === 'GET') {
      const sha = req.query.get('sha');
      const ref = sha !== null && sha !== '' ? (sha.startsWith('refs/') ? sha : `refs/heads/${sha}`) : `refs/heads/${repo.defaultBranch}`;
      const { page, perPage } = parsePage(req.query);
      const all = listCommits(forge, repo, ref);
      const { page: items, total } = paginate(all, page, perPage);
      const link = linkHeader(`${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits`, req.query, page, perPage, total);
      return {
        status: 200,
        body: items.map((oid) => commitJson(repo, oid)),
        headers: link !== '' ? { link } : {},
      };
    }

    // ---- /contents/{path...}
    if (sub[0] === 'contents') {
      const filePath = sub.slice(1).join('/');
      const refParam = req.query.get('ref');
      const branch = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;
      const refName = `refs/heads/${branch}`;
      if (req.method === 'PUT') {
        const parsed = parseBody(req);
        if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
        const body = bodyObj(parsed.json);
        if (body === null) return { status: 400, body: jsonError('Problems parsing JSON') };
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        const branchName = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
        const sha = typeof body.sha === 'string' ? body.sha : undefined;
        const content = Buffer.from(contentB64, 'base64');
        // stale-sha check
        const tip = forge.refCommit(repo, `refs/heads/${branchName}`);
        let existingBlob: string | undefined;
        if (tip !== undefined) {
          const flat = forge.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
          existingBlob = flat.get(filePath)?.oid;
        }
        if (sha !== undefined && existingBlob !== undefined && sha !== existingBlob) {
          return { status: 409, body: jsonError('sha does not match') };
        }
        const isUpdate = existingBlob !== undefined;
        const { commitOid, blobOid } = commitFile(forge, repo, { branch: branchName, path: filePath, content, message });
        return {
          status: isUpdate ? 200 : 201,
          body: {
            content: {
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              sha: blobOid,
              size: content.length,
              url: '',
              html_url: '',
              git_url: '',
              download_url: '',
              type: 'file',
              encoding: 'base64',
              content: contentB64,
            },
            commit: { sha: commitOid, message, url: '', html_url: '' },
          },
        };
      }
      if (req.method === 'DELETE') {
        const parsed = parseBody(req);
        if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
        const body = bodyObj(parsed.json);
        const message = body !== null && typeof body.message === 'string' ? body.message : 'Delete file';
        const sha = body !== null && typeof body.sha === 'string' ? body.sha : undefined;
        const tip = forge.refCommit(repo, refName);
        if (tip === undefined) return { status: 404, body: jsonError('Not Found') };
        const flat = forge.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const existing = flat.get(filePath);
        if (existing === undefined) return { status: 404, body: jsonError('Not Found') };
        if (sha !== undefined && sha !== existing.oid) return { status: 409, body: jsonError('sha does not match') };
        const { commitOid } = commitFile(forge, repo, { branch, path: filePath, content: null, message });
        return { status: 200, body: { commit: { sha: commitOid, message, url: '', html_url: '' } } };
      }
      if (req.method === 'GET') {
        const tip = forge.refCommit(repo, refName);
        if (tip === undefined) return { status: 404, body: jsonError('Not Found') };
        const flat = forge.flattenTree(repo, parseCommit(repo.objects.get(tip)!.data).tree);
        const exact = flat.get(filePath);
        if (exact !== undefined) {
          const obj = repo.objects.get(exact.oid);
          const data = obj?.type === 'blob' ? obj.data : Buffer.alloc(0);
          return {
            status: 200,
            body: {
              type: 'file',
              encoding: 'base64',
              size: data.length,
              name: filePath.split('/').pop() ?? filePath,
              path: filePath,
              content: data.toString('base64'),
              sha: exact.oid,
              url: '',
              html_url: '',
              git_url: '',
              download_url: '',
            },
          };
        }
        // directory listing
        const prefix = filePath === '' ? '' : `${filePath}/`;
        const entries = new Map<string, { type: string; name: string; path: string; sha: string; size: number }>();
        for (const [path, v] of flat) {
          if (prefix !== '' && !path.startsWith(prefix)) continue;
          const rest = prefix === '' ? path : path.slice(prefix.length);
          const slash = rest.indexOf('/');
          if (slash < 0) {
            const obj = repo.objects.get(v.oid);
            entries.set(rest, { type: 'file', name: rest, path, sha: v.oid, size: obj?.type === 'blob' ? obj.data.length : 0 });
          } else {
            const dir = rest.slice(0, slash);
            if (!entries.has(dir)) entries.set(dir, { type: 'dir', name: dir, path: prefix + dir, sha: '', size: 0 });
          }
        }
        if (entries.size === 0) return { status: 404, body: jsonError('Not Found') };
        return {
          status: 200,
          body: [...entries.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => ({
            type: e.type,
            size: e.size,
            name: e.name,
            path: e.path,
            sha: e.sha,
            url: '',
            html_url: '',
            git_url: '',
            download_url: e.type === 'file' ? '' : null,
          })),
        };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    // ---- /labels
    if (sub.length === 1 && sub[0] === 'labels') {
      if (req.method === 'POST') {
        const parsed = parseBody(req);
        if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
        const body = bodyObj(parsed.json);
        const name = body !== null ? String(body.name ?? '') : '';
        const color = body !== null && typeof body.color === 'string' ? body.color : 'ededed';
        if (name === '') return { status: 422, body: jsonError('name is required') };
        if (repo.labels.some((l) => l.name === name)) return { status: 422, body: jsonError('Label already exists') };
        const label: Label = { id: repo.nextLabelId++, name, color, description: body !== null && typeof body.description === 'string' ? body.description : '' };
        repo.labels.push(label);
        return { status: 201, body: labelJson(repo, label) };
      }
      if (req.method === 'GET') {
        return { status: 200, body: repo.labels.map((l) => labelJson(repo, l)) };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    // ---- /issues
    if (sub[0] === 'issues') {
      if (sub.length === 1) {
        if (req.method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
          const body = bodyObj(parsed.json);
          if (body === null) return { status: 400, body: jsonError('Problems parsing JSON') };
          const title = typeof body.title === 'string' ? body.title : '';
          const issueBody = typeof body.body === 'string' ? body.body : '';
          const labels = Array.isArray(body.labels) ? body.labels.map((l) => String(l)) : [];
          for (const name of labels) {
            if (!repo.labels.some((l) => l.name === name)) {
              return { status: 422, body: jsonError(`Label does not exist: ${name}`) };
            }
          }
          const issue = forge.createIssue(repo, VIEWER, title, issueBody, labels);
          return { status: 201, body: issueJson(repo, issue) };
        }
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') {
            list.sort((a, b) => {
              const d = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
              return direction === 'asc' ? d : -d;
            });
          }
          const { page, perPage } = parsePage(req.query);
          const { page: items, total } = paginate(list, page, perPage);
          const link = linkHeader(`${ctx.baseUrl}/api/v3/repos/${owner}/${name}/issues`, req.query, page, perPage, total);
          return {
            status: 200,
            body: items.map((i) => issueJson(repo, i)),
            headers: link !== '' ? { link } : {},
          };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      const num = parseInt(sub[1]!, 10);
      if (Number.isNaN(num)) return { status: 404, body: jsonError('Not Found') };
      const issue = repo.issues.find((i) => i.number === num);
      if (sub.length === 2) {
        if (issue === undefined) return { status: 404, body: jsonError('Not Found') };
        if (req.method === 'GET') return { status: 200, body: issueJson(repo, issue) };
        if (req.method === 'PATCH') {
          const parsed = parseBody(req);
          if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
          const body = bodyObj(parsed.json);
          if (body !== null) {
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
              issue.state = body.state;
              issue.closedAt = body.state === 'closed' ? new Date().toISOString() : null;
            }
            if (Array.isArray(body.labels)) {
              const names = body.labels.map((l) => String(l));
              for (const n of names) {
                if (!repo.labels.some((l) => l.name === n)) return { status: 422, body: jsonError(`Label does not exist: ${n}`) };
              }
              issue.labels = names;
            }
          }
          issue.updatedAt = new Date().toISOString();
          return { status: 200, body: issueJson(repo, issue) };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      if (sub.length === 3 && sub[2] === 'comments') {
        if (issue === undefined) return { status: 404, body: jsonError('Not Found') };
        if (req.method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
          const body = bodyObj(parsed.json);
          const text = body !== null && typeof body.body === 'string' ? body.body : '';
          const comment = {
            id: repo.nextCommentId++,
            body: text,
            user: VIEWER,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          issue.comments.push(comment);
          issue.updatedAt = new Date().toISOString();
          return { status: 201, body: commentJson(repo, issue, comment) };
        }
        if (req.method === 'GET') {
          return { status: 200, body: issue.comments.map((c) => commentJson(repo, issue, c)) };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    // ---- /pulls
    if (sub[0] === 'pulls') {
      if (sub.length === 1) {
        if (req.method === 'POST') {
          const parsed = parseBody(req);
          if (!parsed.ok) return { status: 400, body: jsonError(parsed.error) };
          const body = bodyObj(parsed.json);
          if (body === null) return { status: 400, body: jsonError('Problems parsing JSON') };
          const title = typeof body.title === 'string' ? body.title : '';
          const pullBody = typeof body.body === 'string' ? body.body : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          const result = forge.createPull(repo, VIEWER, { title, body: pullBody, headRef: head, baseRef: base });
          if ('error' in result) return { status: 422, body: jsonError(result.error) };
          return { status: 201, body: pullJson(repo, result) };
        }
        if (req.method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.number - a.number);
          const { page, perPage } = parsePage(req.query);
          const { page: items, total } = paginate(list, page, perPage);
          const link = linkHeader(`${ctx.baseUrl}/api/v3/repos/${owner}/${name}/pulls`, req.query, page, perPage, total);
          return {
            status: 200,
            body: items.map((p) => pullJson(repo, p)),
            headers: link !== '' ? { link } : {},
          };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      const num = parseInt(sub[1]!, 10);
      if (Number.isNaN(num)) return { status: 404, body: jsonError('Not Found') };
      const pull = repo.pulls.find((p) => p.number === num);
      if (sub.length === 2) {
        if (pull === undefined) return { status: 404, body: jsonError('Not Found') };
        if (req.method === 'GET') return { status: 200, body: pullJson(repo, pull) };
        return { status: 404, body: jsonError('Not Found') };
      }
      if (sub.length === 3 && sub[2] === 'files') {
        if (pull === undefined) return { status: 404, body: jsonError('Not Found') };
        if (req.method === 'GET') {
          return {
            status: 200,
            body: pull.files.map((f) => ({
              sha: '',
              filename: f.filename,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              changes: f.changes,
              blob_url: '',
              raw_url: '',
              contents_url: '',
              patch: '',
            })),
          };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      if (sub.length === 3 && sub[2] === 'merge') {
        if (pull === undefined) return { status: 404, body: jsonError('Not Found') };
        if (req.method === 'PUT') {
          const result = forge.mergePull(repo, pull, 'squash');
          if ('error' in result) return { status: result.status, body: jsonError(result.error) };
          return {
            status: 200,
            body: { sha: result.oid, merged: true, message: `Pull Request successfully merged` },
          };
        }
        return { status: 404, body: jsonError('Not Found') };
      }
      return { status: 404, body: jsonError('Not Found') };
    }

    return { status: 404, body: jsonError('Not Found') };
  }

  return { status: 404, body: jsonError('Not Found') };
}

function userByLoginLocal(login: string): User | undefined {
  if (login === 'faint-meadow-org') {
    return { id: 2000, login: 'faint-meadow-org', name: 'faint-meadow-org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };
  }
  return undefined;
}

export { buildCommit, buildTree, hashObject, parseCommit, parseTree };
export type { ObjType };
