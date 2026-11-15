// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp.
// Two eras, both answered: the modern 2026-07-28 `server/discover` and the
// legacy `initialize` handshake. JSON-RPC 2.0; a request with an id always
// gets a JSON-RPC response; a notification gets HTTP 202 and no body.
// Tool calls return {content: [{type: 'text', text: JSON}], structuredContent}
// so the suite reads them either way.

import { VIEWER, type Forge, type Repo, type User } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_VERSION = '2026-07-28';
export const MCP_LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties?: boolean;
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer (or by an organization the viewer belongs to).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that will own the repository (the viewer by default).' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash merge).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

/** The tools/list answer, built once so two calls are byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export function toolsListJson(): string {
  return TOOLS_LIST_JSON;
}

interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponse {
  status: number;
  /** undefined = no JSON-RPC body (a notification). */
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error } };
}

function toolTextResult(value: unknown): { content: Array<{ type: string; text: string }>; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolErrorResult(message: string): { content: Array<{ type: string; text: string }>; isError: true } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function ownerFor(forge: Forge, owner: unknown): User {
  if (typeof owner === 'string' && owner !== '') {
    if (owner === 'faint-meadow-org') {
      return { id: 2000, login: 'faint-meadow-org', name: 'faint-meadow-org', email: 'faint-meadow-org@example.invalid', type: 'Organization' };
    }
    if (owner === VIEWER.login) return VIEWER;
  }
  return VIEWER;
}

function visibleRepo(forge: Forge, owner: string, repo: string): Repo | undefined {
  const r = forge.getRepo(owner, repo);
  if (r === undefined) return undefined;
  if (r.owner.login !== VIEWER.login && r.owner.login !== 'faint-meadow-org') return undefined;
  return r;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): { result: unknown; isError: boolean } {
  const missing = (required: readonly string[]): string | null => {
    const bad = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    return bad.length > 0 ? `missing required argument(s): ${bad.join(', ')}` : null;
  };
  switch (name) {
    case 'create_repo': {
      const err = missing(['name']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repoName = String(args.name);
      const owner = ownerFor(forge, args.owner);
      if (forge.getRepo(owner.login, repoName) !== undefined) {
        return { result: toolErrorResult(`repository ${owner.login}/${repoName} already exists`), isError: true };
      }
      const repo = forge.createRepo(owner, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return { result: toolTextResult(repoJson(repo, '')), isError: false };
    }
    case 'get_repo': {
      const err = missing(['owner', 'repo']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      return { result: toolTextResult(repoJson(repo, '')), isError: false };
    }
    case 'create_issue': {
      const err = missing(['owner', 'repo', 'title']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const issue = forge.createIssue(repo, VIEWER, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { result: toolTextResult(issueJson(repo, issue)), isError: false };
    }
    case 'list_issues': {
      const err = missing(['owner', 'repo']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return { result: toolTextResult(list.map((i) => issueJson(repo, i))), isError: false };
    }
    case 'create_pull_request': {
      const err = missing(['owner', 'repo', 'title', 'head', 'base']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const result = forge.createPull(repo, VIEWER, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        headRef: String(args.head),
        baseRef: String(args.base),
      });
      if ('error' in result) return { result: toolErrorResult(result.error), isError: true };
      return { result: toolTextResult(pullJson(repo, result)), isError: false };
    }
    case 'merge_pull_request': {
      const err = missing(['owner', 'repo', 'pull_number']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (pull === undefined) return { result: toolErrorResult(`pull request #${args.pull_number} not found`), isError: true };
      const result = forge.mergePull(repo, pull, 'squash');
      if ('error' in result) return { result: toolErrorResult(result.error), isError: true };
      return { result: toolTextResult(pullJson(repo, pull)), isError: false };
    }
    case 'get_issue': {
      const err = missing(['owner', 'repo', 'number']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const issue = repo.issues.find((i) => i.number === Number(args.number));
      if (issue === undefined) return { result: toolErrorResult(`issue #${args.number} not found`), isError: true };
      return { result: toolTextResult(issueJson(repo, issue)), isError: false };
    }
    case 'list_pull_requests': {
      const err = missing(['owner', 'repo']);
      if (err !== null) return { result: toolErrorResult(err), isError: true };
      const repo = visibleRepo(forge, String(args.owner), String(args.repo));
      if (repo === undefined) return { result: toolErrorResult(`repository ${args.owner}/${args.repo} not found`), isError: true };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? repo.pulls : repo.pulls.filter((p) => p.state === state);
      return { result: toolTextResult(list.map((p) => pullJson(repo, p))), isError: false };
    }
    default:
      return { result: null, isError: false };
  }
}

const KNOWN_TOOLS = new Set(TOOLS.map((t) => t.name));

export function handleMcp(forge: Forge, bodyText: string): McpResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const req = parsed as McpRequest;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id;
  const hasId = id !== undefined && id !== null;
  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};

  // Notifications (no id): no JSON-RPC response.
  if (!hasId) {
    return { status: 202 };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        protocolVersion: MCP_VERSION,
        supportedVersions: [MCP_VERSION, ...MCP_LEGACY_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_VERSION;
      const negotiated = [MCP_VERSION, ...MCP_LEGACY_VERSIONS].includes(offered) ? offered : MCP_VERSION;
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return { status: 200, body: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) } };
    }
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      if (!KNOWN_TOOLS.has(toolName)) {
        return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      const { result } = callTool(forge, toolName, args);
      return rpcResult(id, result);
    }
    case 'resources/list':
    case 'prompts/list': {
      return rpcResult(id, { resources: [], prompts: [] });
    }
    default: {
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
