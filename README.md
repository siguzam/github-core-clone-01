# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/siguzam/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/siguzam/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01)
"Build a GitHub-compatible git forge". One process, Node 22, standard
library only — no dependencies, no install step, no git binary.

## What it serves

- **Git smart HTTP** (`/<owner>/<repo>.git/...`): `info/refs`,
  `git-upload-pack` (protocol v2: `ls-refs`, `fetch`, shallow/deepen) and
  `git-receive-pack` (protocol v0, `report-status`, `side-band-64k`). The
  whole git object model is implemented in-process (`gitobj.ts`): SHA-1
  loose objects, trees/commits/tags, packfile read/write with OFS_DELTA
  and REF_DELTA resolution, reachability and merge-base.
- **REST v3** (`/api/v3/...`): repositories, branches, commits, contents
  (create/update/delete with stale-sha 409), labels, issues (+ comments)
  and pull requests (+ files, squash merge with conflict detection).
  Pagination via `Link` headers; `X-GitHub-Request-Id` on every reply;
  JSON error bodies with a string `message`.
- **GraphQL v4** (`POST /api/graphql`): the documents `gh` and
  `github-mcp-server` send — viewer, repository fields, `__type`
  introspection, issue/pull-request reads, `createIssue`/`closeIssue`,
  `createPullRequest`/`mergePullRequest`, `addComment`, `node(id:)`,
  cursor pagination and batched operations.
- **MCP** (`POST /mcp`): Streamable HTTP, both the modern `server/discover`
  (2026-07-28) and the legacy `initialize` handshake; eight tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `get_issue`,
  `list_pull_requests`) whose effects are visible over REST.

State is in-memory (the trial mounts the repo read-only; nothing is
written to disk). Authentication is a single bearer token,
`MAKEFUN_SHOP_TOKEN`; `/healthz` takes none. The token owner is the
viewer account `adaiversen` (id 1000); the org `faint-meadow-org` and the
stranger `olgabauer` exist so foreign-owner reads are 404, never 403.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle from the kit, unchanged: it binds
an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, polls
`$MAKEFUN_ENV_URL/done` and exits 0 when the trial is over.

## Local grade

```sh
# start the server on a port (dev harness, not part of the entry)
node --experimental-strip-types /tmp/dev-server.ts 18080
# run the sealed conformance suite + benchmarks
node --experimental-strip-types <kit>/sdk/run.ts \
  --url http://127.0.0.1:18080 --token <MAKEFUN_SHOP_TOKEN> --perf
```

Local result (2026-11-15, Node 22.23.5): **120/120 conformance checks,
15/15 MCP, perf 162/200 — total 962/1000**, above the house reference
forge (~900).

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | entry ↔ env lifecycle (from the kit, unchanged) |
| `app.ts` | the HTTP server: routing, auth, request ids |
| `gitobj.ts` | git objects, packs, deltas, reachability |
| `githttp.ts` | smart HTTP: info/refs, upload-pack v2, receive-pack v0 |
| `store.ts` | the forge state: users, repos, issues, pulls, merges |
| `rest.ts` | REST v3 |
| `graphql.ts` | GraphQL v4 (parser + resolver) |
| `mcp.ts` | MCP tools over Streamable HTTP |
