// Content script: extracts job postings from the page when the background asks ({type:'scan'}).
(() => {
  if (window.__autoVagas) return;
  window.__autoVagas = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => sleep(a + Math.random() * (b - a));
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
  const text = (el) => (el?.innerText || el?.textContent || '').replace(/ /g, ' ').trim();
  const emailsIn = (t) => [...new Set((t.match(EMAIL_RE) || []).map((e) => e.toLowerCase()))];
  const q = (root, sels) => {
    for (const s of sels) {
      const e = root.querySelector(s);
      if (e && text(e)) return e;
    }
    return null;
  };
  // Sends each job as soon as it is read: nothing is lost if the scan is interrupted,
  // and the messages keep the service worker awake.
  const report = (job) => chrome.runtime.sendMessage({ type: 'jobsFound', jobs: [job] }).catch(() => {});

  const loggedOut = () => /\/(login|authwall|checkpoint|uas\/)/.test(location.pathname);

  // A page hidden behind another window doesn't load the lists: ask the background to bring the search window
  // to the front and wait a bit. Returns whether the page became visible.
  async function visible() {
    if (!document.hidden) return true;
    await chrome.runtime.sendMessage({ type: 'scanHidden' }).catch(() => {});
    for (let i = 0; i < 12 && document.hidden; i++) await sleep(500);
    return !document.hidden;
  }

  // LinkedIn jobs come from the public search, read by the background (lib/linkedin.js); here we only handle
  // posts, which require the user's account.
  async function scanLinkedinPosts(max) {
    if (loggedOut()) return { error: 'login' };
    const shown = await visible();
    await sleep(2500);
    for (let i = 0; i < 6; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await jitter(1200, 2000);
    }
    let posts = [...document.querySelectorAll('div.feed-shared-update-v2, [data-urn^="urn:li:activity"], [data-view-name="feed-full-update"], [role="article"]')];
    posts = posts.filter((p) => !posts.some((o) => o !== p && o.contains(p)));
    if (!posts.length) return { ...scanGeneric('linkedin_post', max), posts: 0, hidden: !shown };
    let count = 0;
    for (const post of posts) {
      if (count >= max) break;
      // truncated text: click the post's "ver mais" (see more) before reading
      const more = [...post.querySelectorAll('button')].find((b) => /^(…|\.\.\.)?\s*(ver mais|exibir mais|see more|show more)$/i.test(text(b)));
      if (more) {
        more.click();
        await sleep(250);
      }
      const body = text(q(post, ['.update-components-text', '.feed-shared-update-v2__description', '.feed-shared-text'])) || text(post);
      const emails = emailsIn(body);
      if (!emails.length) continue;
      const urn = post.getAttribute('data-urn') || post.querySelector('[data-urn]')?.getAttribute('data-urn');
      report({
        source: 'linkedin_post',
        title: body.split('\n').find((l) => l.trim().length > 8)?.trim().slice(0, 110) || 'Post no LinkedIn',
        company: text(q(post, ['.update-components-actor__title', '.update-components-actor__name'])).split('\n')[0] || '',
        location: '',
        url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : location.href,
        description: body.slice(0, 8000),
        emails,
      });
      count++;
    }
    return { count, posts: posts.length, hidden: !shown };
  }

  async function scanGoogle(max) {
    const shown = await visible();
    await sleep(2000);
    let i = 0;
    let count = 0;
    let idle = 0;
    while (count < max && idle < 3) {
      const cards = [...document.querySelectorAll('[data-share-url]')];
      if (i >= cards.length) {
        window.scrollTo(0, document.body.scrollHeight);
        idle++;
        await sleep(2000);
        continue;
      }
      idle = 0;
      const card = cards[i++];
      const lines = text(card).split('\n').map((l) => l.trim()).filter(Boolean);
      // a company without a logo shows its initial in place of the image: that's not the title
      if (lines[0]?.length === 1) lines.shift();
      const title = lines[0];
      if (!title) continue;
      card.scrollIntoView({ block: 'center' });
      (card.querySelector('a, [role="link"], [role="button"]') || card).click();
      await jitter(1800, 2800);

      // details pane: a visible element outside the list whose text is the title
      const same = (s) => s.replace(/\s+/g, ' ').trim() === title.replace(/\s+/g, ' ');
      const head = [...document.querySelectorAll('h1, h2, h3, [role="heading"], div')].find(
        (e) => !e.children.length && e.offsetParent && same(e.textContent) && !e.closest('[data-share-url]')
      );
      let pane = head;
      for (let up = 0; pane && up < 10 && text(pane).length < 600; up++) pane = pane.parentElement;
      if (pane) {
        const more = [...pane.querySelectorAll('[role="button"], button')].find((b) =>
          /descrição completa|full description|mostrar mais|show more/i.test(text(b))
        );
        if (more) {
          more.click();
          await sleep(600);
        }
      }
      const desc = pane ? text(pane) : text(card);
      report({
        source: 'google_jobs',
        title,
        company: lines[1] || '',
        location: (lines[2] || '').split('•')[0].trim(),
        url: pane?.querySelector('a[href*="/goto?"]')?.href || card.dataset.shareUrl || location.href,
        description: desc.slice(0, 8000),
        emails: emailsIn(desc),
      });
      count++;
      await jitter(800, 1600);
    }
    return { count, hidden: !shown };
  }

  // Fallback: any email on the page, with the surrounding text as the description.
  function scanGeneric(source, max) {
    const t = text(document.body);
    const seen = new Set();
    let m;
    EMAIL_RE.lastIndex = 0;
    while ((m = EMAIL_RE.exec(t)) && seen.size < max) {
      const email = m[0].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      const ctx = t.slice(Math.max(0, m.index - 1500), m.index + 400);
      report({ source, title: document.title.slice(0, 110), company: '', location: '', url: location.href, description: ctx, emails: [email] });
    }
    return { count: seen.size };
  }

  const scanners = { linkedin_post: scanLinkedinPosts, google_jobs: scanGoogle };

  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg?.type !== 'scan' || !scanners[msg.source]) return;
    scanners[msg.source](msg.max).then(
      (r) => send({ ok: !r.error, ...r }),
      (e) => send({ ok: false, error: String(e?.message || e) })
    );
    return true;
  });
})();
