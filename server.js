import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 4321);
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

const SECTIONS = {
  mine: ['is:pr is:open archived:false author:@me'],
  reviewing: [
    'is:pr is:open archived:false user-review-requested:@me',
    'is:pr is:open archived:false reviewed-by:@me -author:@me',
  ],
  mentioned: ['is:pr is:open archived:false mentions:@me -author:@me'],
};

const SEARCH_QUERY = `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          id
          number
          title
          url
          isDraft
          createdAt
          updatedAt
          additions
          deletions
          reviewDecision
          author { login avatarUrl }
          repository { nameWithOwner }
          comments { totalCount }
          reviewRequests(first: 20) {
            nodes { requestedReviewer { ... on User { login } } }
          }
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
        }
      }
    }
  }
`;

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(
      'No GitHub token. Set GITHUB_TOKEN or log in with `gh auth login`.',
      { cause: error },
    );
  }
}

const token = resolveToken();

async function graphql(query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-dashboard',
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    const message = body.errors?.map((e) => e.message).join('; ') ?? res.statusText;
    throw new Error(`GitHub API ${res.status}: ${message}`);
  }
  return body.data;
}

async function fetchViewer() {
  const data = await graphql('query { viewer { login avatarUrl } }');
  return data.viewer;
}

function toPr(node, viewerLogin) {
  const requested = node.reviewRequests.nodes.some(
    (r) => r.requestedReviewer?.login === viewerLogin,
  );
  return {
    id: node.id,
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository.nameWithOwner,
    author: node.author,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    comments: node.comments.totalCount,
    reviewDecision: node.reviewDecision,
    checks: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    reviewRequestedFromMe: requested,
  };
}

async function fetchSection(queries, viewerLogin) {
  const results = await Promise.all(queries.map((q) => graphql(SEARCH_QUERY, { q })));
  const byId = new Map();
  for (const result of results) {
    for (const node of result.search.nodes) {
      if (!byId.has(node.id)) byId.set(node.id, toPr(node, viewerLogin));
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function fetchDashboard() {
  const viewer = await fetchViewer();
  const entries = await Promise.all(
    Object.entries(SECTIONS).map(async ([key, queries]) => [
      key,
      await fetchSection(queries, viewer.login),
    ]),
  );
  return { viewer, fetchedAt: new Date().toISOString(), ...Object.fromEntries(entries) };
}

const STATIC_FILES = new Set(['index.html', 'app.js', 'styles.css']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

async function serveStatic(pathname, res) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!STATIC_FILES.has(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const contents = await readFile(join(PUBLIC_DIR, file));
  res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(file)] }).end(contents);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === '/api/prs') {
      const data = await fetchDashboard();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      return;
    }
    await serveStatic(pathname, res);
  } catch (error) {
    console.error(error);
    res
      .writeHead(500, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: error.message }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`GitHub dashboard running at http://localhost:${PORT}`);
});
