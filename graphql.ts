// graphql.ts — GitHub GraphQL v4, for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts). A small
// recursive-descent parser for the query language plus a resolver over the
// forge store. Unknown fields are GraphQL errors (HTTP 200 with `errors`),
// never HTTP errors; unauthenticated requests are HTTP 401 (handled by the
// app layer). Operation batching (a JSON array body) answers in order.

import {
  VIEWER,
  commentGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
  type Forge,
  type Issue,
  type Pull,
  type Repo,
  type User,
} from './store.ts';

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Record<string, Value>;
  selections: Selection[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { type: string; defaultValue: Value | null }>;
  selections: Selection[];
}

class ParseError extends Error {}

class Lexer {
  private pos = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos += 1;
      else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  next(): string {
    this.skipWs();
    return this.src[this.pos++] ?? '';
  }

  expect(ch: string): void {
    const got = this.next();
    if (got !== ch) throw new ParseError(`expected ${JSON.stringify(ch)}, got ${JSON.stringify(got)}`);
  }

  readName(): string {
    this.skipWs();
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (/[A-Za-z0-9_]/.test(c)) {
        out += c;
        this.pos += 1;
      } else break;
    }
    if (out === '') throw new ParseError(`expected a name at offset ${this.pos}`);
    return out;
  }

  readString(): string {
    // current char is '"'
    this.pos += 1;
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]!;
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (c === '\\') {
        this.pos += 1;
        const e = this.src[this.pos] ?? '';
        this.pos += 1;
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else out += e;
        continue;
      }
      out += c;
      this.pos += 1;
    }
    throw new ParseError('unterminated string');
  }

  readNumber(): Value {
    this.skipWs();
    let out = '';
    while (this.pos < this.src.length && /[0-9.eE+-]/.test(this.src[this.pos]!)) {
      out += this.src[this.pos];
      this.pos += 1;
    }
    if (out.includes('.') || out.includes('e') || out.includes('E')) {
      return { kind: 'float', value: parseFloat(out) };
    }
    return { kind: 'int', value: parseInt(out, 10) };
  }

  atEnd(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }
}

function parseValue(lex: Lexer): Value {
  const c = lex.peek();
  if (c === '$') {
    lex.next();
    return { kind: 'variable', name: lex.readName() };
  }
  if (c === '"') return { kind: 'string', value: lex.readString() };
  if (c === '[') {
    lex.next();
    const items: Value[] = [];
    while (lex.peek() !== ']') items.push(parseValue(lex));
    lex.expect(']');
    return { kind: 'list', items };
  }
  if (c === '{') {
    lex.next();
    const fields: Record<string, Value> = {};
    while (lex.peek() !== '}') {
      const name = lex.readName();
      lex.expect(':');
      fields[name] = parseValue(lex);
    }
    lex.expect('}');
    return { kind: 'object', fields };
  }
  if (c === '-' || /[0-9]/.test(c)) return lex.readNumber();
  const name = lex.readName();
  if (name === 'true') return { kind: 'boolean', value: true };
  if (name === 'false') return { kind: 'boolean', value: false };
  if (name === 'null') return { kind: 'null' };
  return { kind: 'enum', value: name };
}

function parseArguments(lex: Lexer): Record<string, Value> {
  const args: Record<string, Value> = {};
  if (lex.peek() !== '(') return args;
  lex.next();
  while (lex.peek() !== ')') {
    const name = lex.readName();
    lex.expect(':');
    args[name] = parseValue(lex);
  }
  lex.expect(')');
  return args;
}

function parseSelectionSet(lex: Lexer): Selection[] {
  lex.expect('{');
  const out: Selection[] = [];
  while (lex.peek() !== '}') {
    if (lex.peek() === '.') {
      // ... or ... on Type
      lex.next();
      lex.expect('.');
      lex.expect('.');
      let typeCondition: string | null = null;
      if (lex.peek() === 'o') {
        const word = lex.readName();
        if (word === 'on') typeCondition = lex.readName();
      }
      out.push({ kind: 'fragment', typeCondition, selections: parseSelectionSet(lex) });
      continue;
    }
    const first = lex.readName();
    let alias = first;
    let name = first;
    if (lex.peek() === ':') {
      lex.next();
      name = lex.readName();
    }
    const args = parseArguments(lex);
    const selections = lex.peek() === '{' ? parseSelectionSet(lex) : [];
    out.push({ kind: 'field', alias, name, args, selections });
  }
  lex.expect('}');
  return out;
}

function parseType(lex: Lexer): string {
  if (lex.peek() === '[') {
    lex.next();
    const inner = parseType(lex);
    lex.expect(']');
    let t = `[${inner}]`;
    if (lex.peek() === '!') {
      lex.next();
      t += '!';
    }
    return t;
  }
  const name = lex.readName();
  let t = name;
  if (lex.peek() === '!') {
    lex.next();
    t += '!';
  }
  return t;
}

export function parseDocument(src: string): Operation {
  const lex = new Lexer(src);
  let type: 'query' | 'mutation' = 'query';
  let name: string | null = null;
  const variables: Record<string, { type: string; defaultValue: Value | null }> = {};
  const first = lex.peek();
  if (first === 'q' || first === 'm') {
    const word = lex.readName();
    if (word === 'query') type = 'query';
    else if (word === 'mutation') type = 'mutation';
    else throw new ParseError(`unknown operation ${word}`);
    if (lex.peek() !== '{' && lex.peek() !== '(') {
      name = lex.readName();
    }
  }
  if (lex.peek() === '(') {
    lex.next();
    while (lex.peek() !== ')') {
      lex.expect('$');
      const varName = lex.readName();
      lex.expect(':');
      const varType = parseType(lex);
      let defaultValue: Value | null = null;
      if (lex.peek() === '=') {
        lex.next();
        defaultValue = parseValue(lex);
      }
      variables[varName] = { type: varType, defaultValue };
    }
    lex.expect(')');
  }
  const selections = parseSelectionSet(lex);
  return { type, name, variables, selections };
}

// ------------------------------------------------------------------ values

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable': {
      const val = variables[v.name];
      return val === undefined ? null : val;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v.fields)) out[k] = resolveValue(val, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'assignees', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergeableState', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];

// ------------------------------------------------------------------ nodes

type Node =
  | { __kind: 'Query' }
  | { __kind: 'Repository'; repo: Repo }
  | { __kind: 'Issue'; repo: Repo; issue: Issue }
  | { __kind: 'PullRequest'; repo: Repo; pull: Pull }
  | { __kind: 'User'; user: User }
  | { __kind: 'Ref'; name: string }
  | { __kind: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __kind: 'PullRequestConnection'; repo: Repo; pulls: Pull[] }
  | { __kind: 'PullRequestFileConnection'; repo: Repo; pull: Pull }
  | { __kind: 'Type'; name: string }
  | { __kind: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; hasPreviousPage: boolean; startCursor: string | null }
  | { __kind: 'CommentEdge'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }
  | { __kind: 'Comment'; repo: Repo; issue: Issue; comment: Issue['comments'][number] }
  | { __kind: 'PullRequestFile'; path: string; additions: number; deletions: number }
  | { __kind: 'TypeField'; name: string };

interface Ctx {
  forge: Forge;
  viewer: User;
}

class GqlError extends Error {
  path: (string | number)[];
  constructor(message: string, path: (string | number)[]) {
    super(message);
    this.path = path;
  }
}

function typeNameOf(node: Node): string {
  switch (node.__kind) {
    case 'Query':
      return 'Query';
    case 'Repository':
      return 'Repository';
    case 'Issue':
      return 'Issue';
    case 'PullRequest':
      return 'PullRequest';
    case 'User':
      return 'User';
    case 'Ref':
      return 'Ref';
    case 'IssueConnection':
      return 'IssueConnection';
    case 'PullRequestConnection':
      return 'PullRequestConnection';
    case 'PullRequestFileConnection':
      return 'PullRequestFileConnection';
    case 'Type':
      return '__Type';
    case 'PageInfo':
      return 'PageInfo';
    case 'CommentEdge':
      return 'IssueCommentEdge';
    case 'Comment':
      return 'IssueComment';
    case 'PullRequestFile':
      return 'PullRequestFile';
    case 'TypeField':
      return '__Field';
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`).toString('base64');
}

function cursorNumber(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? null : parseInt(m[1], 10);
  } catch {
    return null;
  }
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function findRepoByGlobalId(forge: Forge, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const num = parseInt(decoded.parts[0] ?? '', 10);
  if (Number.isNaN(num)) return null;
  for (const repo of forge.repos.values()) if (repo.id === num) return repo;
  return null;
}

function findIssueByGlobalId(forge: Forge, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repoId = parseInt(decoded.parts[0] ?? '', 10);
  const number = parseInt(decoded.parts[1] ?? '', 10);
  if (Number.isNaN(repoId) || Number.isNaN(number)) return null;
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.find((i) => i.number === number);
    if (issue !== undefined) return { repo, issue };
  }
  return null;
}

function findPullByGlobalId(forge: Forge, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repoId = parseInt(decoded.parts[0] ?? '', 10);
  const number = parseInt(decoded.parts[1] ?? '', 10);
  if (Number.isNaN(repoId) || Number.isNaN(number)) return null;
  for (const repo of forge.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.find((p) => p.number === number);
    if (pull !== undefined) return { repo, pull };
  }
  return null;
}

// ------------------------------------------------------------------ resolver

function resolveField(
  ctx: Ctx,
  node: Node,
  field: FieldNode,
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: (string | number)[],
): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, variables);
  const value = resolveScalar(ctx, node, field.name, args, errors, path);
  if (value === undefined) {
    // Unknown field on this type: a GraphQL error, the field reads null.
    errors.push(new GqlError(`Cannot query field "${field.name}" on type "${typeNameOf(node)}".`, [...path, field.alias]));
    return null;
  }
  if (field.selections.length === 0) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item !== null && typeof item === 'object' && '__kind' in item) {
        return resolveSelections(ctx, item as Node, field.selections, variables, errors, [...path, field.alias, i]);
      }
      return item;
    });
  }
  if (typeof value === 'object' && '__kind' in value) {
    return resolveSelections(ctx, value as Node, field.selections, variables, errors, [...path, field.alias]);
  }
  // A scalar with a sub-selection: an error in a real schema; here return it.
  return value;
}

function resolveSelections(
  ctx: Ctx,
  node: Node,
  selections: Selection[],
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeNameOf(node)) continue;
      Object.assign(out, resolveSelections(ctx, node, sel.selections, variables, errors, path));
      continue;
    }
    out[sel.alias] = resolveField(ctx, node, sel, variables, errors, path);
  }
  return out;
}

/** Resolve one field to a scalar, a Node, or an array of Nodes. `undefined` = unknown field. */
function resolveScalar(
  ctx: Ctx,
  node: Node,
  name: string,
  args: Record<string, unknown>,
  errors: GqlError[],
  path: (string | number)[],
): unknown {
  const { forge } = ctx;
  switch (node.__kind) {
    case 'Query': {
      if (name === 'viewer') return { __kind: 'User', user: ctx.viewer } as Node;
      if (name === 'repository') {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (repo === undefined) return null;
        if (repo.owner.login !== VIEWER.login && repo.owner.login !== 'faint-meadow-org') return null;
        return { __kind: 'Repository', repo } as Node;
      }
      if (name === 'node') {
        const id = String(args.id ?? '');
        const repo = findRepoByGlobalId(forge, id);
        if (repo !== null) return { __kind: 'Repository', repo } as Node;
        const issue = findIssueByGlobalId(forge, id);
        if (issue !== null) return { __kind: 'Issue', repo: issue.repo, issue: issue.issue } as Node;
        const pull = findPullByGlobalId(forge, id);
        if (pull !== null) return { __kind: 'PullRequest', repo: pull.repo, pull: pull.pull } as Node;
        return null;
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        if (['Issue', 'PullRequest', 'Repository', 'SearchType', 'User', 'Query', 'Mutation'].includes(typeName)) {
          return { __kind: 'Type', name: typeName } as Node;
        }
        return null;
      }
      if (name === '__schema') return null;
      return undefined;
    }
    case 'Repository': {
      const repo = node.repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner.login}/${repo.name}`;
        case 'owner':
          return { __kind: 'User', user: repo.owner } as Node;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.private;
        case 'url':
          return `https://example.invalid/${repo.owner.login}/${repo.name}`;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'defaultBranchRef': {
          const ref = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (ref === undefined) return null;
          return { __kind: 'Ref', name: repo.defaultBranch } as Node;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const num = Number(args.number);
          const issue = repo.issues.find((i) => i.number === num);
          if (issue === undefined) return null;
          return { __kind: 'Issue', repo, issue } as Node;
        }
        case 'issues': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const after = typeof args.after === 'string' ? args.after : null;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          const orderBy = args.orderBy !== null && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>) : null;
          let list = [...repo.issues];
          if (states !== null) {
            list = list.filter((i) => states.includes(issueState(i)));
          }
          if (orderBy !== null && orderBy.field === 'CREATED_AT') {
            list.sort((a, b) => {
              const d = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
              return orderBy.direction === 'DESC' ? -d : d;
            });
          } else {
            list.sort((a, b) => a.number - b.number);
          }
          const afterNum = cursorNumber(after);
          if (afterNum !== null) list = list.filter((i) => i.number > afterNum);
          const page = list.slice(0, first);
          const hasNextPage = list.length > first;
          const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
          return { __kind: 'IssueConnection', repo, issues: page, hasNextPage, endCursor } as Node;
        }
        case 'pullRequest': {
          const num = Number(args.number);
          const pull = repo.pulls.find((p) => p.number === num);
          if (pull === undefined) return null;
          return { __kind: 'PullRequest', repo, pull } as Node;
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? args.first : 100;
          const after = typeof args.after === 'string' ? args.after : null;
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          let list = [...repo.pulls];
          if (states !== null) list = list.filter((p) => states.includes(pullState(p)));
          list.sort((a, b) => b.number - a.number);
          const afterNum = cursorNumber(after);
          if (afterNum !== null) list = list.filter((p) => p.number < afterNum);
          const page = list.slice(0, first);
          return { __kind: 'PullRequestConnection', repo, pulls: page } as Node;
        }
        default:
          return undefined;
      }
    }
    case 'Issue': {
      const issue = node.issue;
      switch (name) {
        case 'id':
          return issueGlobalId(node.repo, issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        case 'url':
          return `https://example.invalid/${node.repo.owner.login}/${node.repo.name}/issues/${issue.number}`;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.closedAt;
        case 'author':
          return { __kind: 'User', user: issue.user } as Node;
        case 'repository':
          return { __kind: 'Repository', repo: node.repo } as Node;
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const pull = node.pull;
      switch (name) {
        case 'id':
          return pullGlobalId(node.repo, pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return pull.headSha;
        case 'baseRefOid':
          return pull.baseSha;
        case 'mergeable':
          return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'mergeableState':
          return pull.mergeable ? 'CLEAN' : 'DIRTY';
        case 'merged':
          return pull.merged;
        case 'url':
          return `https://example.invalid/${node.repo.owner.login}/${node.repo.name}/pull/${pull.number}`;
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'closedAt':
          return pull.closedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'author':
          return { __kind: 'User', user: pull.user } as Node;
        case 'repository':
          return { __kind: 'Repository', repo: node.repo } as Node;
        case 'files': {
          return { __kind: 'PullRequestFileConnection', repo: node.repo, pull } as Node;
        }
        default:
          return undefined;
      }
    }
    case 'User': {
      switch (name) {
        case 'id':
          return Buffer.from(`User:${node.user.id}`).toString('base64');
        case 'databaseId':
          return node.user.id;
        case 'login':
          return node.user.login;
        case 'name':
          return node.user.name;
        default:
          return undefined;
      }
    }
    case 'Ref': {
      if (name === 'name') return node.name;
      if (name === 'prefix') return 'refs/heads/';
      return undefined;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return node.issues.map((issue) => ({ __kind: 'Issue', repo: node.repo, issue }) as Node);
      if (name === 'totalCount') return node.issues.length;
      if (name === 'pageInfo') {
        return {
          __kind: 'PageInfo',
          hasNextPage: node.hasNextPage,
          endCursor: node.endCursor,
          hasPreviousPage: false,
          startCursor: node.issues.length > 0 ? cursorFor(node.issues[0]!.number) : null,
        } as Node;
      }
      return undefined;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return node.pulls.map((pull) => ({ __kind: 'PullRequest', repo: node.repo, pull }) as Node);
      if (name === 'totalCount') return node.pulls.length;
      if (name === 'pageInfo') {
        return {
          __kind: 'PageInfo',
          hasNextPage: false,
          endCursor: null,
          hasPreviousPage: false,
          startCursor: null,
        } as Node;
      }
      return undefined;
    }
    case 'PullRequestFileConnection': {
      if (name === 'nodes') {
        const first = typeof args.first === 'number' ? args.first : 100;
        return node.pull.files.slice(0, first).map((f) => ({ __kind: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions }) as Node);
      }
      if (name === 'totalCount') return node.pull.files.length;
      return undefined;
    }
    case 'Type': {
      if (name === 'name') return node.name;
      if (name === 'kind') return 'OBJECT';
      if (name === 'fields') {
        const list = node.name === 'Issue' ? ISSUE_FIELDS : node.name === 'PullRequest' ? PULL_REQUEST_FIELDS : REPOSITORY_FIELDS;
        return list.map((f) => ({ __kind: 'TypeField', name: f }) as Node);
      }
      if (name === 'enumValues') {
        if (node.name !== 'SearchType') return null;
        return SEARCH_TYPE_VALUES.map((v) => ({ __kind: 'TypeField', name: v }) as Node);
      }
      return undefined;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return node.hasNextPage;
      if (name === 'hasPreviousPage') return node.hasPreviousPage;
      if (name === 'endCursor') return node.endCursor;
      if (name === 'startCursor') return node.startCursor;
      return undefined;
    }
    case 'CommentEdge': {
      if (name === 'node') return { __kind: 'Comment', repo: node.repo, issue: node.issue, comment: node.comment } as Node;
      if (name === 'cursor') return cursorFor(node.comment.id);
      return undefined;
    }
    case 'Comment': {
      if (name === 'id') return commentGlobalId(node.repo, node.comment);
      if (name === 'body') return node.comment.body;
      if (name === 'author') return { __kind: 'User', user: node.comment.user } as Node;
      if (name === 'createdAt') return node.comment.createdAt;
      if (name === 'updatedAt') return node.comment.updatedAt;
      return undefined;
    }
    case 'PullRequestFile': {
      if (name === 'path') return node.path;
      if (name === 'additions') return node.additions;
      if (name === 'deletions') return node.deletions;
      return undefined;
    }
    case 'TypeField': {
      if (name === 'name') return node.name;
      if (name === 'description') return null;
      if (name === 'isDeprecated') return false;
      if (name === 'deprecationReason') return null;
      return undefined;
    }
    default:
      return undefined;
  }
}

// ------------------------------------------------------------------ entry

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

export function executeGraphQL(forge: Forge, viewer: User, query: string, variables: Record<string, unknown>): GraphQLResult {
  const ctx: Ctx = { forge, viewer };
  const errors: GqlError[] = [];
  let op: Operation;
  try {
    op = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  if (op.type === 'mutation') {
    // Wrap the mutation payload resolution through a small adapter.
    const data = executeMutationWithPayload(ctx, op, variables, errors);
    return { data, errors: errors.map((e) => ({ message: e.message, path: e.path })) };
  }
  const data = resolveSelections(ctx, { __kind: 'Query' }, op.selections, variables, errors, []);
  return { data, errors: errors.map((e) => ({ message: e.message, path: e.path })) };
}

function executeMutationWithPayload(
  ctx: Ctx,
  op: Operation,
  variables: Record<string, unknown>,
  errors: GqlError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sel.args)) args[k] = resolveValue(v, variables);
    const input = (args.input !== null && typeof args.input === 'object' ? args.input : {}) as Record<string, unknown>;
    if (sel.name === 'createIssue') {
      const repo = findRepoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
      if (repo === null) {
        errors.push(new GqlError('Could not resolve to a Repository with the global id.', [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const issue = ctx.forge.createIssue(repo, ctx.viewer, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
      const node: Node = { __kind: 'Issue', repo, issue };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'issue') {
          payload[sub.alias] = resolveSelections(ctx, node, sub.selections, variables, errors, [sel.alias, sub.alias]);
        } else {
          payload[sub.alias] = null;
        }
      }
      out[sel.alias] = payload;
      continue;
    }
    if (sel.name === 'closeIssue') {
      const found = findIssueByGlobalId(ctx.forge, String(input.issueId ?? ''));
      if (found === null) {
        errors.push(new GqlError('Could not resolve to an Issue with the global id.', [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = new Date().toISOString();
      found.issue.updatedAt = new Date().toISOString();
      const node: Node = { __kind: 'Issue', repo: found.repo, issue: found.issue };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'issue') {
          payload[sub.alias] = resolveSelections(ctx, node, sub.selections, variables, errors, [sel.alias, sub.alias]);
        } else {
          payload[sub.alias] = null;
        }
      }
      out[sel.alias] = payload;
      continue;
    }
    if (sel.name === 'createPullRequest') {
      const repo = findRepoByGlobalId(ctx.forge, String(input.repositoryId ?? ''));
      if (repo === null) {
        errors.push(new GqlError('Could not resolve to a Repository with the global id.', [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const result = ctx.forge.createPull(repo, ctx.viewer, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        headRef: String(input.headRefName ?? ''),
        baseRef: String(input.baseRefName ?? repo.defaultBranch),
      });
      if ('error' in result) {
        errors.push(new GqlError(result.error, [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const node: Node = { __kind: 'PullRequest', repo, pull: result };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'pullRequest') {
          payload[sub.alias] = resolveSelections(ctx, node, sub.selections, variables, errors, [sel.alias, sub.alias]);
        } else {
          payload[sub.alias] = null;
        }
      }
      out[sel.alias] = payload;
      continue;
    }
    if (sel.name === 'mergePullRequest') {
      const found = findPullByGlobalId(ctx.forge, String(input.pullRequestId ?? ''));
      if (found === null) {
        errors.push(new GqlError('Could not resolve to a PullRequest with the global id.', [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const result = ctx.forge.mergePull(found.repo, found.pull, String(input.mergeMethod ?? 'SQUASH'));
      if ('error' in result) {
        errors.push(new GqlError(result.error, [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const node: Node = { __kind: 'PullRequest', repo: found.repo, pull: found.pull };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'pullRequest') {
          payload[sub.alias] = resolveSelections(ctx, node, sub.selections, variables, errors, [sel.alias, sub.alias]);
        } else {
          payload[sub.alias] = null;
        }
      }
      out[sel.alias] = payload;
      continue;
    }
    if (sel.name === 'addComment') {
      const found = findIssueByGlobalId(ctx.forge, String(input.subjectId ?? ''));
      if (found === null) {
        errors.push(new GqlError('Could not resolve to an Issue with the global id.', [sel.alias]));
        out[sel.alias] = null;
        continue;
      }
      const comment = {
        id: found.repo.nextCommentId++,
        body: String(input.body ?? ''),
        user: ctx.viewer,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      found.issue.comments.push(comment);
      found.issue.updatedAt = new Date().toISOString();
      const edge: Node = { __kind: 'CommentEdge', repo: found.repo, issue: found.issue, comment };
      const payload: Record<string, unknown> = {};
      for (const sub of sel.selections) {
        if (sub.kind !== 'field') continue;
        if (sub.name === 'commentEdge') {
          payload[sub.alias] = resolveSelections(ctx, edge, sub.selections, variables, errors, [sel.alias, sub.alias]);
        } else {
          payload[sub.alias] = null;
        }
      }
      out[sel.alias] = payload;
      continue;
    }
    errors.push(new GqlError(`Cannot query field "${sel.name}" on type "Mutation".`, [sel.alias]));
    out[sel.alias] = null;
  }
  return out;
}
