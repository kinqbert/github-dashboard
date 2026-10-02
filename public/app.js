const AUTO_REFRESH_MS = 5 * 60 * 1000;

const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const filterEl = document.getElementById('filter');
const avatarEl = document.getElementById('avatar');

let data = null;

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

  return el('li', { className: 'pr' }, [
    el('div', { className: 'repo', textContent: `${pr.repo} #${pr.number}` }),
    el('a', { className: 'title', href: pr.url, target: '_blank', rel: 'noopener', textContent: pr.title }),
    badges.length ? el('div', { className: 'badges' }, badges) : '',
    meta,
  ]);
}

function matches(pr, query) {
  if (!query) return true;
  const haystack = `${pr.title} ${pr.repo} ${pr.author?.login ?? ''} #${pr.number}`.toLowerCase();
  return haystack.includes(query);
}

function render() {
  if (!data) return;
  const query = filterEl.value.trim().toLowerCase();
  for (const section of document.querySelectorAll('section[data-section]')) {
    const key = section.dataset.section;
    const prs = data[key].filter((pr) => matches(pr, query));
    section.querySelector('.count').textContent = prs.length;
    const list = section.querySelector('.list');
    list.replaceChildren(
      ...(prs.length
        ? prs.map((pr) => renderPr(pr, key))
        : [el('li', { className: 'empty', textContent: 'Nothing here' })]),
    );
  }
}

async function load() {
  refreshBtn.disabled = true;
  statusEl.textContent = 'Loading…';
  statusEl.classList.remove('error');
  try {
    const res = await fetch('/api/prs');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    data = body;
    avatarEl.src = data.viewer.avatarUrl;
    document.title = `PRs · ${data.viewer.login}`;
    statusEl.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    render();
  } catch (error) {
    statusEl.textContent = `Failed to load: ${error.message}`;
    statusEl.classList.add('error');
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener('click', load);
filterEl.addEventListener('input', render);
setInterval(load, AUTO_REFRESH_MS);
load();
