const HIDE_PATTERNS = [
  'sponsored',
  'suggested for you',
  'suggested pages',
  'paid partnership',
  'because you viewed',
  'because you watched',
  'popular near you',
  'for entertainment purposes',
  'ai generated',
  'made with ai',
  'meta ai'
];

const POST_SELECTORS = [
  '[role="article"]',
  'div[data-pagelet*="FeedUnit"]',
  'div[data-pagelet*="GroupsFeed_"]',
  'div[data-pagelet*="VideoChatHomeUnit"]',
  'div[data-pagelet*="Marketplace"]'
];

const HIDDEN_ATTR = 'data-kill-fb-crap-hidden';
let scheduled = false;

function normalizeText(text) {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function shouldHide(node) {
  const text = normalizeText(node.innerText || node.textContent);
  return HIDE_PATTERNS.some((pattern) => text.includes(pattern));
}

function hidePost(node) {
  if (node.getAttribute(HIDDEN_ATTR) === '1') {
    return;
  }
  node.setAttribute(HIDDEN_ATTR, '1');
  node.style.display = 'none';
}

function cleanHref(value) {
  if (!value || value.startsWith('javascript:') || value.startsWith('#')) {
    return value;
  }
  let parsed;
  try {
    parsed = new URL(value, window.location.href);
  } catch {
    return value;
  }
  if (!parsed.searchParams.has('fbclid')) {
    return value;
  }
  parsed.searchParams.delete('fbclid');
  return parsed.toString();
}

function cleanCurrentUrl() {
  const cleaned = cleanHref(window.location.href);
  if (cleaned && cleaned !== window.location.href) {
    history.replaceState(history.state, '', cleaned);
  }
}

function cleanLinks(root = document) {
  const links = [];
  if (root instanceof Element && root.matches('a[href]')) {
    links.push(root);
  }
  if (root.querySelectorAll) {
    links.push(...root.querySelectorAll('a[href]'));
  }
  for (const link of links) {
    const href = link.getAttribute('href');
    const cleaned = cleanHref(href);
    if (cleaned && cleaned !== href) {
      link.setAttribute('href', cleaned);
    }
  }
}

function hideJunk(root = document) {
  const nodes = [];
  if (root instanceof Element && root.matches(POST_SELECTORS.join(','))) {
    nodes.push(root);
  }
  if (root.querySelectorAll) {
    nodes.push(...root.querySelectorAll(POST_SELECTORS.join(',')));
  }
  for (const node of nodes) {
    if (shouldHide(node)) {
      hidePost(node);
    }
  }
}

function run(root = document) {
  cleanCurrentUrl();
  cleanLinks(root);
  hideJunk(root);
}

function scheduleRun() {
  if (scheduled) {
    return;
  }
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    run();
  });
}

run();

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes' && mutation.target instanceof Element) {
      if (mutation.target.matches('a[href]')) {
        scheduleRun();
        return;
      }
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node instanceof Element) {
        scheduleRun();
        return;
      }
    }
  }
});

observer.observe(document.documentElement, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['href']
});
