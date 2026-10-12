import "dotenv/config";
import { execFileSync, spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "127.0.0.1";
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
          headRefName
          createdAt
          updatedAt
          additions
          deletions
          reviewDecision
          mergeQueueEntry { position state }
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

// With GITHUB_CLIENT_ID set, each visitor signs in with GitHub and the
// dashboard uses their token. Without it, everything runs as the local user.
const OAUTH = process.env.GITHUB_CLIENT_ID
  ? {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: requireEnv("GITHUB_CLIENT_SECRET"),
      baseUrl: requireEnv("BASE_URL").replace(/\/$/, ""),
      sessionKey: createHash("sha256")
        .update(requireEnv("SESSION_SECRET"))
        .digest(),
    }
  : null;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set when GITHUB_CLIENT_ID is.`);
  return value;
}

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

const localToken = OAUTH ? null : resolveToken();

async function graphql(token, query, variables) {
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
    const error = new Error(`GitHub API ${res.status}: ${message}`);
    error.status = res.status;
    throw error;
  }
  return body.data;
}

async function fetchViewer(token) {
  const data = await graphql(token, "query { viewer { login avatarUrl } }");
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
    branch: node.headRefName,
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
    mergeQueue: node.mergeQueueEntry,
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
// top of the stack first, at the slot of the stack's most recent PR.
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
        .sort((a, b) => b.stack.position - a.stack.position),
    );
  }
  return sorted;
}

async function fetchSection(token, queries, viewerLogin) {
  const results = await Promise.all(
    queries.map((q) =>
      graphql(token, SEARCH_QUERY, {
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

async function fetchDashboard({ token, viewer }) {
  const entries = await Promise.all(
    Object.entries(SECTIONS).map(async ([key, queries]) => [
      key,
      await fetchSection(token, queries, viewer.login),
    ]),
  );
  return {
    viewer,
    canSignOut: Boolean(OAUTH),
    fetchedAt: new Date().toISOString(),
    ...Object.fromEntries(entries),
  };
}

const BUGBOT_COMMENT = "bugbot run";

// Comments on the PR as the token's user, which asks Bugbot to review it.
async function requestBugbot(token, prId) {
  await graphql(
    token,
    `mutation ($id: ID!, $body: String!) {
      addComment(input: { subjectId: $id, body: $body }) { clientMutationId }
    }`,
    { id: prId, body: BUGBOT_COMMENT },
  );
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
}

// Sessions live in an encrypted cookie, so the server keeps no state and
// visitors stay signed in across restarts.
const SESSION_COOKIE = "session";
const STATE_COOKIE = "oauth_state";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", OAUTH.sessionKey, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
}

function unseal(sealed) {
  try {
    const raw = Buffer.from(sealed, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      OAUTH.sessionKey,
      raw.subarray(0, 12),
    );
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
    );
  } catch {
    return null;
  }
}

function readCookies(req) {
  const cookies = {};
  for (const part of req.headers.cookie?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function cookie(name, value, maxAge) {
  const secure = OAUTH.baseUrl.startsWith("https:") ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

let localViewerPromise;

// The signed-in user's token and profile, or null if nobody is signed in.
async function getSession(req) {
  if (!OAUTH) {
    localViewerPromise ??= fetchViewer(localToken).catch((error) => {
      localViewerPromise = undefined;
      throw error;
    });
    return { token: localToken, viewer: await localViewerPromise };
  }
  const sealed = readCookies(req)[SESSION_COOKIE];
  return sealed ? unseal(sealed) : null;
}

function startSignIn(res) {
  const state = randomBytes(16).toString("hex");
  const url = new URL("https://github.com/login/oauth/authorize");
  url.search = new URLSearchParams({
    client_id: OAUTH.clientId,
    redirect_uri: `${OAUTH.baseUrl}/auth/callback`,
    scope: "repo",
    state,
  });
  res
    .writeHead(302, {
      Location: url.href,
      "Set-Cookie": cookie(STATE_COOKIE, state, 600),
    })
    .end();
}

async function finishSignIn(req, res, params) {
  const state = readCookies(req)[STATE_COOKIE];
  if (!state || params.get("state") !== state || !params.get("code")) {
    res.writeHead(400).end("Sign-in failed. Go back and try again.");
    return;
  }
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: OAUTH.clientId,
      client_secret: OAUTH.clientSecret,
      code: params.get("code"),
      redirect_uri: `${OAUTH.baseUrl}/auth/callback`,
    }),
  });
  const { access_token: token, error_description } = await tokenRes.json();
  if (!token) throw new Error(`GitHub sign-in failed: ${error_description}`);
  const viewer = await fetchViewer(token);
  res
    .writeHead(302, {
      Location: "/",
      "Set-Cookie": [
        cookie(SESSION_COOKIE, seal({ token, viewer }), SESSION_MAX_AGE),
        cookie(STATE_COOKIE, "", 0),
      ],
    })
    .end();
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
  const { pathname, searchParams } = new URL(
    req.url,
    `http://${req.headers.host}`,
  );
  try {
    if (OAUTH && pathname === "/login") {
      startSignIn(res);
      return;
    }
    if (OAUTH && pathname === "/auth/callback") {
      await finishSignIn(req, res, searchParams);
      return;
    }
    if (OAUTH && pathname === "/logout" && req.method === "POST") {
      res
        .writeHead(303, {
          Location: "/login",
          "Set-Cookie": cookie(SESSION_COOKIE, "", 0),
        })
        .end();
      return;
    }
    if (!pathname.startsWith("/api/")) {
      await serveStatic(pathname, res);
      return;
    }
    const session = await getSession(req);
    if (!session) {
      res
        .writeHead(401, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Not signed in" }));
      return;
    }
    if (pathname === "/api/prs") {
      const data = await fetchDashboard(session);
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(data));
      return;
    }
    // Requiring JSON forces a CORS preflight, so other sites can't post comments.
    if (
      pathname === "/api/bugbot" &&
      req.method === "POST" &&
      req.headers["content-type"] === "application/json"
    ) {
      const { id } = await readJsonBody(req);
      if (typeof id !== "string" || !id) {
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Missing PR id" }));
        return;
      }
      await requestBugbot(session.token, id);
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (error) {
    console.error(error);
    // A revoked or expired token: send the visitor back through sign-in.
    const status = OAUTH && error.status === 401 ? 401 : 500;
    res
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify({ error: error.message }));
  }
}).listen(PORT, HOST, () => {
  const url = OAUTH?.baseUrl ?? `http://localhost:${PORT}`;
  console.log(`GitHub dashboard running at ${url}`);
  if (!OAUTH && !process.argv.includes("--no-open")) openBrowser(url);
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
