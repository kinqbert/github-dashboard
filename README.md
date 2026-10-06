# github-dashboard

A single local page that lists your open GitHub pull requests in two columns:

- **My PRs** — PRs you opened.
- **Reviewing** — PRs where your review was requested directly, plus PRs you've already reviewed.

Above them, a summary shows how many lines are waiting on your review, how your own PRs are doing,
and how many PRs have new activity.

Each PR shows its draft status, review decision, CI checks, size, and last update. PRs that are
part of a [GitHub stack](https://github.com/github/gh-stack) show their position in the stack and
link to the other PRs in it. PRs from the same stack are kept together and share a color, which
stays the same across refreshes.

A blue dot marks PRs with activity from someone else (comments, reviews, pushes, or a review
request to you) since you last clicked the card. Click a card, or use "Mark all as read", to clear
it. Read state lives in your browser's `localStorage`; on your first visit everything starts as
read.

The page refreshes every minute while the tab is visible.

## Run it

Requires Node 18+. There are no dependencies to install.

```bash
npm start        # http://localhost:4321
npm run dev      # same, restarts on server.js changes
```

## Auth

The server uses `GITHUB_TOKEN` if it's set, otherwise the token from the GitHub CLI
(`gh auth token`). The token needs the `repo` scope to see private repositories.

```bash
GITHUB_TOKEN=ghp_... npm start
PORT=5000 npm start
```

The server only listens on `127.0.0.1`, so the token is never exposed outside your machine.

## Changing what's shown

Set `GITHUB_REPO` to a repository's full `owner/repo` name to show only its PRs in both
columns and the summary:

```bash
GITHUB_REPO=octocat/Hello-World npm start
```

Leave it unset or empty to show PRs from all repositories. Restart the server after
changing the variable.

The GitHub search queries for each column live in `SECTIONS` at the top of `server.js`. For
example, to include review requests sent to teams you belong to, change
`user-review-requested:@me` to `review-requested:@me`.
