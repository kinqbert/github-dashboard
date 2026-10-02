const AUTO_REFRESH_MS = 60 * 1000;
const SEEN_KEY = 'github-dashboard:seen';
const STACK_COLORS_KEY = 'github-dashboard:stack-colors';

const STACK_PALETTE = [
  '#a371f7',
  '#db61a2',
  '#f0883e',
  '#26a69a',
  '#4c9aff',
  '#c9a227',
  '#7d8cff',
  '#8fbf3c',
];

const STACK_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M8 1.75 14.25 5 8 8.25 1.75 5Z"/><path d="M1.75 8 8 11.25 14.25 8"/><path d="M1.75 11 8 14.25 14.25 11"/></svg>';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const filterEl = document.getElementById('filter');
const avatarEl = document.getElementById('avatar');
const summaryEl = document.getElementById('summary');

let data = null;
let loading = false;

const REVIEW_LABELS = {
  APPROVED: ['Approved', 'good'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  REVIEW_REQUIRED: ['Review required', 'neutral'],
};

const CHECK_LABELS = {
  SUCCESS: ['Checks passing', 'good'],
  FAILURE: ['Checks failing', 'bad'],
  ERROR: ['Checks errored', 'bad'],
  PENDING: ['Checks running', 'pending'],
  EXPECTED: ['Checks expected', 'pending'],
};

function readJson(key) {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// PR id -> lastActivityAt at the moment the PR was marked as read.
// Null until the first successful load, which marks everything as read.
let seen = readJson(SEEN_KEY);
// Stack key -> palette index. Kept across refreshes so a stack keeps its color.
let stackColors = readJson(STACK_COLORS_KEY) ?? {};

function isUnread(pr) {
  if (!pr.lastActivityAt) return false;
  const seenAt = seen?.[pr.id];
  return !seenAt || pr.lastActivityAt > seenAt;
}

function markRead(prs) {
  seen ??= {};
  for (const pr of prs) seen[pr.id] = pr.lastActivityAt ?? new Date().toISOString();
  writeJson(SEEN_KEY, seen);
  render();
}

function allPrs() {
  return data ? [...data.mine, ...data.reviewing] : [];
}

// Give every visible stack a color, preferring colors no other visible stack uses.
function assignStackColors() {
  const keys = new Set(allPrs().flatMap((pr) => (pr.stack ? [pr.stack.key] : [])));
  const next = {};
  const usage = STACK_PALETTE.map(() => 0);
  for (const key of keys) {
    if (key in stackColors) {
      next[key] = stackColors[key];
      usage[next[key]]++;
    }
  }
  for (const key of keys) {
    if (key in next) continue;
    const index = usage.indexOf(Math.min(...usage));
    next[key] = index;
    usage[index]++;
  }
  stackColors = next;
  writeJson(STACK_COLORS_KEY, stackColors);
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return 'just now';
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function badge(text, tone) {
  return el('span', { className: `badge ${tone}`, textContent: text });
}

function spinner() {
  return el('span', { className: 'spinner', ariaHidden: 'true' });
}

function renderStack(pr) {
  const { stack } = pr;
  const chain = [];
  for (const entry of stack.entries) {
    if (chain.length) chain.push(el('span', { className: 'sep', textContent: '›' }));
    const isCurrent = entry.number === pr.number;
    chain.push(
      el('a', {
        className: `stack-pr ${entry.state.toLowerCase()}${isCurrent ? ' current' : ''}`,
        href: entry.url,
        target: '_blank',
        rel: 'noopener',
        title: `${entry.title} (${entry.state.toLowerCase()})`,
        textContent: `#${entry.number}`,
      }),
    );
  }
  const chip = el('span', { className: 'badge stack-badge', innerHTML: STACK_ICON });
  chip.append(`Stack ${stack.position}/${stack.size}`);
  return el('div', { className: 'stack' }, [chip, el('span', { className: 'chain' }, chain)]);
}

function renderPr(pr, section) {
  const badges = [];
  if (pr.isDraft) badges.push(badge('Draft', 'muted'));
  if (section === 'reviewing') {
    badges.push(
      pr.reviewRequestedFromMe ? badge('Your review requested', 'pending') : badge('Reviewed', 'muted'),
    );
  }
  if (pr.reviewDecision && REVIEW_LABELS[pr.reviewDecision]) {
    badges.push(badge(...REVIEW_LABELS[pr.reviewDecision]));
  }
  if (pr.checks && CHECK_LABELS[pr.checks]) {
    badges.push(badge(...CHECK_LABELS[pr.checks]));
  }

  const meta = el('div', { className: 'meta' }, [
    el('img', { className: 'author-avatar', src: pr.author?.avatarUrl ?? '', alt: '' }),
    el('span', { textContent: pr.author?.login ?? 'ghost' }),
    el('span', { textContent: `· updated ${timeAgo(pr.updatedAt)}` }),
    el('span', { className: 'diff' }, [
      el('span', { className: 'add', textContent: `+${pr.additions}` }),
      el('span', { className: 'del', textContent: ` −${pr.deletions}` }),
    ]),
    pr.comments ? el('span', { textContent: `· ${pr.comments} comments` }) : '',
  ]);

  const unread = isUnread(pr);
  const item = el('li', { className: 'pr' }, [
    unread ? el('span', { className: 'unread-dot', title: 'New activity since you last looked' }) : '',
    el('div', { className: 'repo', textContent: `${pr.repo} #${pr.number}` }),
    el('a', { className: 'title', href: pr.url, target: '_blank', rel: 'noopener', textContent: pr.title }),
    pr.stack ? renderStack(pr) : '',
    badges.length ? el('div', { className: 'badges' }, badges) : '',
    meta,
  ]);
  if (pr.stack) {
    item.classList.add('in-stack');
    item.style.setProperty('--stack', STACK_PALETTE[stackColors[pr.stack.key]]);
  }
  if (unread) {
    item.classList.add('unread');
    item.addEventListener('click', () => markRead([pr]));
    item.addEventListener('auxclick', () => markRead([pr]));
  }
  return item;
}

function stat(label, value, detail) {
  return el('div', { className: 'stat' }, [
    el('div', { className: 'stat-label', textContent: label }),
    el('div', { className: 'stat-value', textContent: value }),
    el('div', { className: 'stat-detail', textContent: detail }),
  ]);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function renderSummary() {
  if (!data) {
    summaryEl.replaceChildren();
    return;
  }
  const waiting = data.reviewing.filter((pr) => pr.reviewRequestedFromMe);
  const lines = waiting.reduce((sum, pr) => sum + pr.additions + pr.deletions, 0);
  const approved = data.mine.filter((pr) => pr.reviewDecision === 'APPROVED').length;
  const changes = data.mine.filter((pr) => pr.reviewDecision === 'CHANGES_REQUESTED').length;
  const failing = data.mine.filter((pr) => pr.checks === 'FAILURE' || pr.checks === 'ERROR').length;
  const unread = allPrs().filter(isUnread).length;

  summaryEl.replaceChildren(
    stat('Lines to review', lines.toLocaleString(), `across ${plural(waiting.length, 'PR')} waiting on your review`),
    stat(
      'Your open PRs',
      data.mine.length,
      `${approved} approved · ${changes} changes requested · ${failing} failing checks`,
    ),
    stat('New activity', unread, `${plural(unread, 'PR')} updated since you last looked`),
  );
}

function matches(pr, query) {
  if (!query) return true;
  const haystack = `${pr.title} ${pr.repo} ${pr.author?.login ?? ''} #${pr.number}`.toLowerCase();
  return haystack.includes(query);
}

function visiblePrs(key) {
  const query = filterEl.value.trim().toLowerCase();
  return data[key].filter((pr) => matches(pr, query));
}

function render() {
  renderSummary();
  for (const section of document.querySelectorAll('section[data-section]')) {
    const key = section.dataset.section;
    const list = section.querySelector('.list');
    const count = section.querySelector('.count');
    const unreadCount = section.querySelector('.unread-count');
    const markAll = section.querySelector('.mark-all');
    if (!data) {
      count.textContent = '';
      unreadCount.textContent = '';
      markAll.disabled = true;
      list.replaceChildren(el('li', { className: 'placeholder' }, [spinner(), 'Loading pull requests…']));
      continue;
    }
    const prs = visiblePrs(key);
    const unread = prs.filter(isUnread).length;
    count.textContent = prs.length;
    unreadCount.textContent = unread ? `${unread} new` : '';
    markAll.disabled = unread === 0;
    list.replaceChildren(
      ...(prs.length
        ? prs.map((pr, i) => {
            const item = renderPr(pr, key);
            if (pr.stack && prs[i - 1]?.stack?.key !== pr.stack.key) item.classList.add('stack-start');
            return item;
          })
        : [el('li', { className: 'placeholder', textContent: 'Nothing here' })]),
    );
  }
}

async function load() {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  refreshBtn.replaceChildren(spinner(), 'Refreshing');
  statusEl.classList.remove('error');
  try {
    const res = await fetch('/api/prs');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    data = body;
    avatarEl.src = data.viewer.avatarUrl;
    document.title = `PRs · ${data.viewer.login}`;
    statusEl.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    assignStackColors();
    if (seen === null) markRead(allPrs());
    render();
  } catch (error) {
    statusEl.textContent = `Failed to load: ${error.message}`;
    statusEl.classList.add('error');
  } finally {
    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.replaceChildren('Refresh');
  }
}

function isStale() {
  return !data || Date.now() - new Date(data.fetchedAt).getTime() >= AUTO_REFRESH_MS;
}

for (const section of document.querySelectorAll('section[data-section]')) {
  section.querySelector('.mark-all').addEventListener('click', () => {
    markRead(visiblePrs(section.dataset.section).filter(isUnread));
  });
}
refreshBtn.addEventListener('click', load);
filterEl.addEventListener('input', render);
setInterval(() => {
  if (!document.hidden) load();
}, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isStale()) load();
});

render();
load();
