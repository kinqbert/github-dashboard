import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4321);
const GITHUB_REPO = process.env.GITHUB_REPO?.trim() ?? "";
if (GITHUB_REPO && !/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(GITHUB_REPO)) {
  throw new Error(
    "GITHUB_REPO must use the owner/repo format (for example, octocat/Hello-World).",
  );
}
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");

const SECTIONS = {
  mine: ["is:pr is:open archived:false author:@me"],
  reviewing: [
    "is:pr is:open archived:false user-review-requested:@me",
    "is:pr is:open archived:false reviewed-by:@me -author:@me",
  ],
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
          reviewThreads(first: 100) { totalCount nodes { isResolved } }
          reviewRequests(first: 20) {
            nodes { requestedReviewer { ... on User { login } } }
          }
          requestEvents: timelineItems(last: 10, itemTypes: [REVIEW_REQUESTED_EVENT]) {
            nodes {
              ... on ReviewRequestedEvent {
                createdAt
                requestedReviewer { ... on User { login } }
              }
            }
          }
          commits(last: 1) {
            nodes { commit { statusCheckRollup { state } } }
          }
          stackEntry { position }
          stack {
            number
            size
            entries(first: 30) {
              nodes { position pullRequest { number title url state } }
            }
          }
          timelineItems(
            last: 20
            itemTypes: [
              ISSUE_COMMENT
              PULL_REQUEST_REVIEW
              PULL_REQUEST_COMMIT
              HEAD_REF_FORCE_PUSHED_EVENT
              READY_FOR_REVIEW_EVENT
              REVIEW_REQUESTED_EVENT
            ]
          ) {
            nodes {
              __typename
              ... on IssueComment { createdAt author { login } }
              ... on PullRequestReview { createdAt author { login } }
              ... on PullRequestCommit {
                commit { committedDate author { user { login } } }
              }
              ... on HeadRefForcePushedEvent { createdAt actor { login } }
              ... on ReadyForReviewEvent { createdAt actor { login } }
              ... on ReviewRequestedEvent {
                createdAt
                requestedReviewer { ... on User { login } }
              }
            }
          }
        }
      }
    }
  }
`;

function resolveToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new Error(
      "No GitHub token. Set GITHUB_TOKEN or log in with `gh auth login`.",
      { cause: error },
    );
  }
}

const token = resolveToken();

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "github-dashboard",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) {
    const message =
      body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
    throw new Error(`GitHub API ${res.status}: ${message}`);
  }
  return body.data;
}

async function fetchViewer() {
  const data = await graphql("query { viewer { login avatarUrl } }");
  return data.viewer;
}

const ACTIVITY_KINDS = {
  IssueComment: "comment",
  PullRequestReview: "review",
  PullRequestCommit: "commit",
  HeadRefForcePushedEvent: "force-push",
  ReadyForReviewEvent: "ready",
  ReviewRequestedEvent: "review-requested",
};

// Returns [who, when] for a timeline item, or null if it isn't news to the viewer.
function timelineActivity(item, viewerLogin) {
  switch (item.__typename) {
    case "PullRequestCommit":
      return [item.commit.author?.user?.login, item.commit.committedDate];
    case "ReviewRequestedEvent":
      return item.requestedReviewer?.login === viewerLogin
        ? [null, item.createdAt]
        : null;
    case "IssueComment":
    case "PullRequestReview":
      return [item.author?.login, item.createdAt];
    default:
      return [item.actor?.login, item.createdAt];
  }
}

// Activity by someone other than the viewer, oldest first: comments, reviews,
// pushes, and review requests sent to the viewer. Someone else's PR also counts
// its creation, so a new PR shows up as unread.
function activityFromOthers(node, viewerLogin) {
  const activity =
    node.author?.login === viewerLogin
      ? []
      : [{ kind: "opened", at: node.createdAt }];
  for (const item of node.timelineItems.nodes) {
    const found = timelineActivity(item, viewerLogin);
    if (!found) continue;
    const [who, at] = found;
    if (who !== viewerLogin) {
      activity.push({ kind: ACTIVITY_KINDS[item.__typename], at });
    }
  }
  return activity.sort((a, b) => a.at.localeCompare(b.at));
}

// When the viewer's review was most recently requested, if it was.
function reviewRequestedAt(node, viewerLogin) {
  const times = node.requestEvents.nodes
    .filter((e) => e.requestedReviewer?.login === viewerLogin)
    .map((e) => e.createdAt)
    .sort();
  return times.at(-1) ?? null;
}

function toPr(node, viewerLogin) {
  const requested = node.reviewRequests.nodes.some(
    (r) => r.requestedReviewer?.login === viewerLogin,
  );
  const activity = activityFromOthers(node, viewerLogin);
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
    threads: {
      total: node.reviewThreads.totalCount,
      resolved: node.reviewThreads.nodes.filter((t) => t.isResolved).length,
    },
    reviewDecision: node.reviewDecision,
    checks: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null,
    reviewRequestedFromMe: requested,
    reviewRequestedAt: requested ? reviewRequestedAt(node, viewerLogin) : null,
    activity,
    lastActivityAt: activity.at(-1)?.at ?? null,
    stack: node.stack && {
      key: `${node.repository.nameWithOwner}#${node.stack.number}`,
      number: node.stack.number,
      size: node.stack.size,
      position: node.stackEntry.position,
      entries: node.stack.entries.nodes
        .map((e) => ({ position: e.position, ...e.pullRequest }))
        .sort((a, b) => a.position - b.position),
    },
  };
}

// Most recently updated first, but PRs from the same stack stay together,
// bottom of the stack first, at the slot of the stack's most recent PR.
function sortPrs(prs) {
  const byRecency = [...prs].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const sorted = [];
  const emittedStacks = new Set();
  for (const pr of byRecency) {
    if (!pr.stack) {
      sorted.push(pr);
      continue;
    }
    if (emittedStacks.has(pr.stack.key)) continue;
    emittedStacks.add(pr.stack.key);
    sorted.push(
      ...byRecency
        .filter((p) => p.stack?.key === pr.stack.key)
        .sort((a, b) => a.stack.position - b.stack.position),
    );
  }
  return sorted;
}

async function fetchSection(queries, viewerLogin) {
  const results = await Promise.all(
    queries.map((q) =>
      graphql(SEARCH_QUERY, {
        q: GITHUB_REPO ? `${q} repo:${GITHUB_REPO}` : q,
      }),
    ),
  );
  const byId = new Map();
  for (const result of results) {
    for (const node of result.search.nodes) {
      if (!byId.has(node.id)) byId.set(node.id, toPr(node, viewerLogin));
    }
  }
  return sortPrs([...byId.values()]);
}

let viewerPromise;

async function fetchDashboard() {
  viewerPromise ??= fetchViewer().catch((error) => {
    viewerPromise = undefined;
    throw error;
  });
  const viewer = await viewerPromise;
  const entries = await Promise.all(
    Object.entries(SECTIONS).map(async ([key, queries]) => [
      key,
      await fetchSection(queries, viewer.login),
    ]),
  );
  return {
    viewer,
    fetchedAt: new Date().toISOString(),
    ...Object.fromEntries(entries),
  };
}

const STATIC_FILES = new Set(["index.html", "app.js", "styles.css"]);

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

async function serveStatic(pathname, res) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!STATIC_FILES.has(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const contents = await readFile(join(PUBLIC_DIR, file));
  res
    .writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] })
    .end(contents);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (pathname === "/api/prs") {
      const data = await fetchDashboard();
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
      return;
    }
    await serveStatic(pathname, res);
  } catch (error) {
    console.error(error);
    res
      .writeHead(500, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: error.message }));
  }
}).listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`GitHub dashboard running at ${url}`);
  if (!process.argv.includes("--no-open")) openBrowser(url);
});

// Opens the URL in the default browser. Failing to open it isn't an error: the
// address is printed above.
function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
