# github-dashboard

A single local page that lists your open GitHub pull requests in two columns:

- **My PRs** — PRs you opened.
- **Reviewing** — PRs where your review was requested directly, plus PRs you've already reviewed.

Above them, a summary shows how many PRs (and lines) are waiting on your review, how your own PRs are doing,
and how many PRs have new activity.

Each PR shows its draft status, review decision, CI checks, size, and last update. PRs that are
part of a [GitHub stack](https://github.com/github/gh-stack) show their position in the stack and
link to the other PRs in it. PRs from the same stack are kept together and share a color, which
stays the same across refreshes.

A blue dot and a bold title mark PRs with activity from someone else (comments, reviews, pushes,
or a review request to you) since you last marked them as read, with a line saying what's new
("2 new comments · new commit"). Hover a card to turn the dot into a "Mark as read" tick and click
it, or use "Mark all as read". The tab title and favicon
show the unread count.

Your own PRs show "Ready to merge" (approved, checks passing) or "Needs your fix" (changes
requested or checks failing), and those come first in each group. PRs waiting on your review show
how long they've been waiting. Check badges link to the PR's checks page.

Quick filters (Unread, Needs my review, Failing, Hide drafts) and a compact one-line-per-PR view
sit above the columns; both are remembered. Read state lives in your browser's `localStorage`; on your first visit everything starts as
read.

Each column is split by last update: last 24 hours, 7 days, 30 days, and older. Click a group's
header to collapse it; collapsed groups stay collapsed across reloads.

The page refreshes every 30 seconds while the tab is visible.

## Run it

Requires Node 18+.

```bash
npm install
npm start        # http://localhost:4321, opens in your browser
npm run dev      # same, restarts on server.js changes (doesn't open the browser)
```

## Auth

The server uses `GITHUB_TOKEN` if it's set, otherwise the token from the GitHub CLI
(`gh auth token`). The token needs the `repo` scope to see private repositories.

```bash
GITHUB_TOKEN=ghp_... npm start
PORT=5000 npm start
```

The server only listens on `127.0.0.1` (change it with `HOST`), so the token is never exposed outside your machine.

## Changing what's shown

Set `GITHUB_REPO` to a repository's full `owner/repo` name to show only its PRs in both
columns and the summary:

```bash
GITHUB_REPO=octocat/Hello-World npm start
```

Leave it unset or empty to show PRs from all repositories. Restart the server after
changing the variable.

You can also put the setting in a `.env` file in the project directory:

```dotenv
GITHUB_REPO=octocat/Hello-World
```

The server loads `.env` automatically on startup. Variables already set in your shell
take precedence over values in `.env`. The `.env` file is ignored by Git.

The GitHub search queries for each column live in `SECTIONS` at the top of `server.js`. For
example, to include review requests sent to teams you belong to, change
`user-review-requested:@me` to `review-requested:@me`.

## Hosting it for others

Set `GITHUB_CLIENT_ID` and the server switches to multi-user mode: each visitor signs in with
GitHub and sees their own PRs, using their own token. Without it, the server runs as you, as above.

1. Create an OAuth App at **GitHub → Settings → Developer settings → OAuth Apps**. Set the
   callback URL to `https://<your domain>/auth/callback`.
2. Put the settings in `.env` on the server:

   ```dotenv
   GITHUB_CLIENT_ID=...
   GITHUB_CLIENT_SECRET=...
   BASE_URL=https://dash.example.com
   SESSION_SECRET=...   # any long random string, e.g. `openssl rand -hex 32`
   ```

Sessions are stored in an encrypted cookie, so there's no database and visitors stay signed in
across restarts for 30 days. Changing `SESSION_SECRET` signs everyone out.

The app asks for the `repo` scope so it can show private repositories. Organizations that
restrict third-party access have to approve the OAuth App before their private PRs show up.

### Deploying to a server (Debian/Ubuntu)

Pushing to `master` deploys automatically through
[.github/workflows/deploy.yml](.github/workflows/deploy.yml): it uploads the code over SSH, writes
`.env` from the repository's secrets, installs dependencies, and restarts the service.

One-time server setup, as root:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs caddy rsync
mkdir -p /opt/github-dashboard
```

The workflow also installs [deploy/Caddyfile](deploy/Caddyfile), so set your domain there.

Point the domain's DNS at the server and open ports 22, 80 and 443.

Create a key for the workflow and allow it to log in:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C github-actions
ssh-copy-id -i deploy_key.pub root@<server>
ssh-keyscan <server>     # output goes into SSH_KNOWN_HOSTS
```

Add these under the repository's **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `SSH_HOST` | the server's IP or hostname |
| `SSH_PRIVATE_KEY` | contents of `deploy_key` |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan` |
| `GH_CLIENT_ID`, `GH_CLIENT_SECRET` | from the OAuth App |
| `SESSION_SECRET` | `openssl rand -hex 32`, generated once |
| `BASE_URL` | e.g. `https://dash.example.com` |

Then push to `master`, or run the workflow from the **Actions** tab.
