const AUTO_REFRESH_MS = 60 * 1000;
const SEEN_KEY = 'github-dashboard:seen';
const STACK_COLORS_KEY = 'github-dashboard:stack-colors';
const COLLAPSED_KEY = 'github-dashboard:collapsed-groups';
const FILTERS_KEY = 'github-dashboard:filters';
const COMPACT_KEY = 'github-dashboard:compact';

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

const REFRESH_ICON =
  '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71"/><path d="M13.25 2.5v3.25H10"/></svg>';

const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg>';

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const filterEl = document.getElementById('filter');
const avatarEl = document.getElementById('avatar');
const summaryEl = document.getElementById('summary');
const faviconEl = document.getElementById('favicon');
const compactBtn = document.getElementById('compact');

let data = null;
let loading = false;
// True when the first load failed, so the page stops showing loading placeholders.
let loadFailed = false;

const REVIEW_LABELS = {
  APPROVED: ['Approved', 'good'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
};

// Passing checks are the normal state, so only these get a badge.
const CHECK_LABELS = {
  FAILURE: ['Checks failing', 'bad'],
  ERROR: ['Checks errored', 'bad'],
  PENDING: ['Checks running', 'pending'],
  EXPECTED: ['Checks expected', 'pending'],
};

const FAILING_CHECKS = new Set(['FAILURE', 'ERROR']);

const DAY_MS = 24 * 60 * 60 * 1000;

// Age groups by when a PR was last updated, newest first. A PR goes in the first group it fits.
const AGE_GROUPS = [
  ['Last 24 hours', DAY_MS],
  ['Last 7 days', 7 * DAY_MS],
  ['Last 30 days', 30 * DAY_MS],
  ['Older', Infinity],
];

// Quick filters. `applies` limits a filter to one column; it's ignored in the other.
const FILTERS = {
  unread: { label: 'Unread', test: (pr) => isUnread(pr) },
  review: { label: 'Needs my review', applies: 'reviewing', test: (pr) => pr.reviewRequestedFromMe },
  failing: { label: 'Failing', test: (pr) => FAILING_CHECKS.has(pr.checks) },
  drafts: { label: 'Hide drafts', test: (pr) => !pr.isDraft },
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
// "section:group label" -> true for age groups the user has collapsed.
let collapsed = readJson(COLLAPSED_KEY) ?? {};
// Filter key -> true for quick filters that are switched on.
let activeFilters = readJson(FILTERS_KEY) ?? {};
let compact = readJson(COMPACT_KEY) ?? false;

function toggleGroup(id) {
  if (collapsed[id]) delete collapsed[id];
  else collapsed[id] = true;
  writeJson(COLLAPSED_KEY, collapsed);
  render();
}

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

function needsFix(pr) {
  return pr.reviewDecision === 'CHANGES_REQUESTED' || FAILING_CHECKS.has(pr.checks);
}

function readyToMerge(pr) {
  return !pr.isDraft && pr.reviewDecision === 'APPROVED' && (!pr.checks || pr.checks === 'SUCCESS');
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

function duration(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const units = [
    ['y', 31536000],
    ['mo', 2592000],
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ];
  for (const [label, size] of units) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label}`;
  }
  return null;
}

function timeAgo(iso) {
  const span = duration(iso);
  return span ? `${span} ago` : 'just now';
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function badge(text, tone, props = {}) {
  return el('span', { className: `badge ${tone}`, textContent: text, ...props });
}

function spinner() {
  return el('span', { className: 'spinner', ariaHidden: 'true' });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Five squares split by the share of added vs. deleted lines, like GitHub's diffstat.
function diffBar(additions, deletions) {
  const total = additions + deletions;
  const add = total ? Math.round((additions / total) * 5) : 0;
  const del = total ? 5 - add : 0;
  return el(
    'span',
    { className: 'diffbar', ariaHidden: 'true' },
    Array.from({ length: 5 }, (_, i) => el('i', { className: i < add ? 'add' : i < add + del ? 'del' : '' })),
  );
}

// A short description of what others did since the PR was last marked as read,
// such as "2 new comments · new commits".
function whatsNew(pr) {
  const seenAt = seen?.[pr.id];
  const counts = {};
  for (const { kind, at } of pr.activity ?? []) {
    if (!seenAt || at > seenAt) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const parts = [];
  if (counts.opened) parts.push('new PR');
  if (counts['review-requested']) parts.push('review requested');
  if (counts.ready) parts.push('ready for review');
  if (counts.review) parts.push(counts.review === 1 ? 'new review' : `${counts.review} new reviews`);
  if (counts.comment) parts.push(counts.comment === 1 ? 'new comment' : `${counts.comment} new comments`);
  if (counts.commit) parts.push(counts.commit === 1 ? 'new commit' : `${counts.commit} new commits`);
  if (counts['force-push']) parts.push('force-pushed');
  return parts.join(' · ');
}

// A "Stack 2/3" chip; hovering or focusing it lists every PR in the stack.
function renderStack(pr) {
  const { stack } = pr;
  const entries = stack.entries.map((entry) =>
    el(
      'a',
      {
        className: `stack-pr ${entry.state.toLowerCase()}${entry.number === pr.number ? ' current' : ''}`,
        href: entry.url,
        target: '_blank',
        rel: 'noopener',
        title: entry.state === 'OPEN' ? '' : entry.state.toLowerCase(),
      },
      [el('span', { className: 'stack-num', textContent: `#${entry.number}` }), el('span', { textContent: entry.title })],
    ),
  );
  const chip = el('button', {
    type: 'button',
    className: 'badge stack-badge',
    ariaLabel: `Stack, ${stack.position} of ${stack.size}`,
    innerHTML: STACK_ICON,
  });
  chip.append(`Stack ${stack.position}/${stack.size}`);
  return el('span', { className: 'stack' }, [chip, el('span', { className: 'stack-pop' }, entries)]);
}

function renderBadges(pr, section) {
  const badges = [];
  if (pr.isDraft) badges.push(badge('Draft', 'muted'));

  if (section === 'mine' && readyToMerge(pr)) {
    badges.push(badge('Ready to merge', 'good'));
    return badges;
  }

  if (section === 'mine' && needsFix(pr)) {
    const reasons = [];
    if (pr.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested');
    if (FAILING_CHECKS.has(pr.checks)) reasons.push('checks failing');
    badges.push(badge('Needs your fix', 'bad', { title: `Because: ${reasons.join(', ')}` }));
  } else if (REVIEW_LABELS[pr.reviewDecision]) {
    badges.push(badge(...REVIEW_LABELS[pr.reviewDecision]));
  }

  if (section === 'reviewing' && pr.reviewRequestedFromMe) {
    const waiting = pr.reviewRequestedAt && duration(pr.reviewRequestedAt);
    const old = pr.reviewRequestedAt && Date.now() - new Date(pr.reviewRequestedAt).getTime() >= DAY_MS;
    badges.push(
      badge(waiting ? `Your review · waiting ${waiting}` : 'Your review requested', old ? 'pending' : 'neutral', {
        title: pr.reviewRequestedAt ? `Requested ${new Date(pr.reviewRequestedAt).toLocaleString()}` : '',
      }),
    );
  }

  if (CHECK_LABELS[pr.checks]) {
    const [text, tone] = CHECK_LABELS[pr.checks];
    badges.push(
      el('a', {
        className: `badge ${tone}`,
        href: `${pr.url}/checks`,
        target: '_blank',
        rel: 'noopener',
        title: 'Open checks',
        textContent: text,
      }),
    );
  }
  return badges;
}

function renderPr(pr, section) {
  const badges = [...(pr.stack ? [renderStack(pr)] : []), ...renderBadges(pr, section)];

  const meta = el('div', { className: 'meta' }, [
    el('img', { className: 'author-avatar', src: pr.author?.avatarUrl ?? '', alt: '' }),
    el('span', { textContent: pr.author?.login ?? 'ghost' }),
    el('span', { textContent: `· updated ${timeAgo(pr.updatedAt)}`, title: new Date(pr.updatedAt).toLocaleString() }),
    el('span', { className: 'diff' }, [
      el('span', { className: 'add', textContent: `+${pr.additions}` }),
      el('span', { className: 'del', textContent: `−${pr.deletions}` }),
      diffBar(pr.additions, pr.deletions),
    ]),
    pr.comments ? el('span', { textContent: `· ${pr.comments} comments` }) : '',
  ]);

  const unread = isUnread(pr);
  let tick = '';
  if (unread) {
    tick = el('button', {
      type: 'button',
      className: 'pr-action mark-read',
      title: 'Mark as read',
      ariaLabel: 'Mark as read',
      innerHTML: `<span class="unread-dot"></span>${CHECK_ICON}`,
    });
    tick.addEventListener('click', () => markRead([pr]));
  }
  const news = unread ? whatsNew(pr) : '';

  const item = el('li', { className: 'pr' }, [
    el('div', { className: 'pr-top' }, [
      el('span', { className: 'repo', textContent: `${pr.repo} #${pr.number}` }),
      unread
        ? el('span', { className: 'pr-actions' }, [
            news ? el('span', { className: 'whats-new', textContent: news, title: news }) : '',
            tick,
          ])
        : '',
    ]),
    el('a', { className: 'title', href: pr.url, target: '_blank', rel: 'noopener', textContent: pr.title }),
    badges.length ? el('div', { className: 'badges' }, badges) : '',
    meta,
  ]);
  if (pr.stack) {
    item.classList.add('in-stack');
    item.style.setProperty('--stack', STACK_PALETTE[stackColors[pr.stack.key]]);
  }
  if (unread) item.classList.add('unread');
  return item;
}

function stat(label, value, detail, tone = '') {
  return el('div', { className: `stat ${tone}` }, [
    el('div', { className: 'stat-label', textContent: label }),
    el('div', { className: 'stat-value', textContent: value }),
    el('div', { className: 'stat-detail', textContent: detail }),
  ]);
}

function skeletonStat() {
  return el('div', { className: 'stat skeleton', ariaHidden: 'true' }, [
    el('div', { className: 'bone label' }),
    el('div', { className: 'bone value' }),
    el('div', { className: 'bone detail' }),
  ]);
}

function renderSummary() {
  if (!data) {
    summaryEl.replaceChildren(...(loadFailed ? [] : [skeletonStat(), skeletonStat(), skeletonStat()]));
    return;
  }
  const waiting = data.reviewing.filter((pr) => pr.reviewRequestedFromMe);
  const lines = waiting.reduce((sum, pr) => sum + pr.additions + pr.deletions, 0);
  const ready = data.mine.filter(readyToMerge).length;
  const fix = data.mine.filter(needsFix).length;
  const unread = allPrs().filter(isUnread).length;

  summaryEl.replaceChildren(
    stat(
      'PRs to review',
      waiting.length,
      `${plural(lines, 'line')} waiting on your review`,
      waiting.length ? 'pending' : 'good',
    ),
    stat(
      'Your open PRs',
      data.mine.length,
      `${ready} ready to merge · ${fix} ${fix === 1 ? 'needs' : 'need'} your fix`,
      fix ? 'bad' : 'good',
    ),
    stat('New activity', unread, `${plural(unread, 'PR')} updated since you last looked`, unread ? 'accent' : ''),
  );
}

// The unread count goes in the tab title and as a dot on the favicon, so it's
// visible while the tab is in the background.
function renderTabBadge() {
  const unread = allPrs().filter(isUnread).length;
  const name = data ? `Your PRs · ${data.viewer.login}` : 'Your PRs';
  document.title = unread ? `(${unread}) ${name}` : name;
  const dot = unread
    ? '<circle cx="25" cy="7" r="6" fill="#2f81f7" stroke="#fff" stroke-width="2"/>'
    : '';
  const href = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f2328"/><g fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="9" r="3"/><circle cx="10" cy="23" r="3"/><circle cx="22" cy="23" r="3"/><path d="M10 12v8M22 20v-6a3 3 0 0 0-3-3h-4M17 8l-3 3 3 3"/></g>${dot}</svg>`,
  )}`;
  if (faviconEl.href !== href) faviconEl.href = href;
}

// Split PRs into age groups, keeping their order. A stack stays together, in the
// group of its most recently updated PR.
function groupByAge(prs) {
  const newest = {};
  for (const pr of prs) {
    if (pr.stack && !(newest[pr.stack.key] >= pr.updatedAt)) newest[pr.stack.key] = pr.updatedAt;
  }
  const groups = AGE_GROUPS.map(([label]) => ({ label, prs: [] }));
  for (const pr of prs) {
    const age = Date.now() - new Date(pr.stack ? newest[pr.stack.key] : pr.updatedAt).getTime();
    groups[AGE_GROUPS.findIndex(([, max]) => age < max)].prs.push(pr);
  }
  return groups.filter((group) => group.prs.length);
}

// Your PRs that need a fix come first, then ones ready to merge, then the rest,
// each keeping its order. A stack moves as one, ranked by its most urgent PR.
function sortByUrgency(prs) {
  const rank = (pr) => (needsFix(pr) ? 0 : readyToMerge(pr) ? 1 : 2);
  const chunks = [];
  for (const pr of prs) {
    const last = chunks.at(-1);
    if (pr.stack && last?.[0].stack?.key === pr.stack.key) last.push(pr);
    else chunks.push([pr]);
  }
  return chunks
    .map((chunk) => ({ chunk, rank: Math.min(...chunk.map(rank)) }))
    .sort((a, b) => a.rank - b.rank)
    .flatMap(({ chunk }) => chunk);
}

function renderGroup({ label, prs }, section) {
  const id = `${section}:${label}`;
  const isCollapsed = Boolean(collapsed[id]);
  const unread = prs.filter(isUnread).length;
  const toggle = el('button', { type: 'button', className: 'age-toggle', ariaExpanded: String(!isCollapsed) }, [
    el('span', { className: 'chevron', ariaHidden: 'true' }),
    el('span', { textContent: label }),
    el('span', { className: 'age-count', textContent: prs.length }),
    isCollapsed && unread ? el('span', { className: 'age-unread', textContent: `${unread} new` }) : '',
  ]);
  toggle.addEventListener('click', () => toggleGroup(id));
  const header = el('li', { className: `age-header${isCollapsed ? ' collapsed' : ''}` }, [toggle]);
  if (isCollapsed) return [header];
  const ordered = section === 'mine' ? sortByUrgency(prs) : prs;
  const items = ordered.map((pr, i) => {
    const item = renderPr(pr, section);
    if (pr.stack && ordered[i - 1]?.stack?.key !== pr.stack.key) item.classList.add('stack-start');
    if (pr.stack && ordered[i + 1]?.stack?.key !== pr.stack.key) item.classList.add('stack-end');
    return item;
  });
  return [header, ...items];
}

function matches(pr, query) {
  if (!query) return true;
  const haystack = `${pr.title} ${pr.repo} ${pr.author?.login ?? ''} #${pr.number}`.toLowerCase();
  return haystack.includes(query);
}

function filtersFor(section) {
  return Object.entries(FILTERS)
    .filter(([key, filter]) => activeFilters[key] && (!filter.applies || filter.applies === section))
    .map(([, filter]) => filter.test);
}

function isFiltering() {
  return Boolean(filterEl.value.trim()) || Object.values(activeFilters).some(Boolean);
}

function visiblePrs(key) {
  const query = filterEl.value.trim().toLowerCase();
  const tests = filtersFor(key);
  return data[key].filter((pr) => matches(pr, query) && tests.every((test) => test(pr)));
}

function clearFilters() {
  filterEl.value = '';
  activeFilters = {};
  writeJson(FILTERS_KEY, activeFilters);
  render();
}

function renderChips() {
  const chips = document.getElementById('chips');
  chips.replaceChildren(
    ...Object.entries(FILTERS).map(([key, filter]) => {
      const chip = el('button', {
        type: 'button',
        className: 'chip',
        textContent: filter.label,
        ariaPressed: String(Boolean(activeFilters[key])),
        title: filter.applies === 'reviewing' ? 'Applies to the Reviewing column' : '',
      });
      chip.addEventListener('click', () => {
        if (activeFilters[key]) delete activeFilters[key];
        else activeFilters[key] = true;
        writeJson(FILTERS_KEY, activeFilters);
        render();
      });
      return chip;
    }),
  );
}

function emptyState(key) {
  if (data[key].length === 0) {
    return key === 'reviewing'
      ? el('li', { className: 'placeholder empty' }, [
          el('span', { className: 'empty-emoji', textContent: '🎉' }),
          el('span', { textContent: 'No reviews waiting. You’re all caught up!' }),
        ])
      : el('li', { className: 'placeholder empty', textContent: 'No open PRs' });
  }
  const clear = el('button', { type: 'button', className: 'link-button', textContent: 'Clear filters' });
  clear.addEventListener('click', clearFilters);
  return el('li', { className: 'placeholder empty' }, [el('span', { textContent: 'No PRs match your filters.' }), clear]);
}

function render() {
  renderSummary();
  renderChips();
  renderTabBadge();
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
      list.replaceChildren(
        loadFailed
          ? el('li', { className: 'placeholder', textContent: 'Couldn’t load pull requests' })
          : el('li', { className: 'placeholder' }, [spinner(), 'Loading pull requests…']),
      );
      continue;
    }
    const prs = visiblePrs(key);
    const unread = prs.filter(isUnread).length;
    count.textContent = isFiltering() ? `${prs.length}/${data[key].length}` : prs.length;
    unreadCount.textContent = unread ? `${unread} new` : '';
    markAll.disabled = unread === 0;
    list.replaceChildren(...(prs.length ? groupByAge(prs).flatMap((group) => renderGroup(group, key)) : [emptyState(key)]));
  }
}

function applyCompact() {
  document.body.classList.toggle('compact', compact);
  compactBtn.ariaPressed = String(compact);
}

async function load() {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');
  statusEl.classList.remove('error');
  if (loadFailed) {
    loadFailed = false;
    render();
  }
  try {
    const res = await fetch('/api/prs');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    data = body;
    avatarEl.src = data.viewer.avatarUrl;
    statusEl.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    assignStackColors();
    if (seen === null) markRead(allPrs());
    render();
  } catch (error) {
    statusEl.textContent = `Failed to load: ${error.message}`;
    statusEl.classList.add('error');
    if (!data) {
      loadFailed = true;
      render();
    }
  } finally {
    loading = false;
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
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
refreshBtn.innerHTML = REFRESH_ICON;
compactBtn.addEventListener('click', () => {
  compact = !compact;
  writeJson(COMPACT_KEY, compact);
  applyCompact();
});
setInterval(() => {
  if (!document.hidden) load();
}, AUTO_REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isStale()) load();
});

applyCompact();
render();
load();
