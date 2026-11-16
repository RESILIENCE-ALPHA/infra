/* Page shell: hash routing, theme toggle, Markdown documents with a table of contents. */
(function () {
  'use strict';

  // Each document: one Markdown file in this folder (kubernetes/docs-site/site/).
  const DOCS = {
    'how-it-works': 'how-it-works.md',
    install: 'install.md',
    teams: 'teams.md',
    'new-feature': 'new-feature.md',
    operations: 'operations.md'
  };

  const root = document.documentElement;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);

  // ---------------------------------------------------------------- theme
  try { const t = localStorage.getItem('theme'); if (t) root.dataset.theme = t; } catch (e) { /* storage unavailable */ }
  document.querySelector('.theme-toggle').addEventListener('click', () => {
    root.dataset.theme = isDark() ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ }
    if (window.Schema && schemaReady) window.Schema.rerender();
    renderMermaid();
  });

  // ---------------------------------------------------------------- routing
  let schemaReady = false;
  let current = null;

  function route() {
    const [view, anchor] = (location.hash.slice(1) || 'schema').split('/');
    const isDoc = Object.prototype.hasOwnProperty.call(DOCS, view);
    const v = view === 'schema' || isDoc ? view : 'schema';
    document.getElementById('view-schema').hidden = v !== 'schema';
    document.getElementById('view-doc').hidden = !isDoc;
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
    if (v === 'schema' && !schemaReady) { window.Schema.init(); schemaReady = true; }
    if (isDoc) {
      loadDoc(v).then(() => {
        const target = anchor && document.getElementById(anchor);
        if (target) target.scrollIntoView(); else if (current !== v + '#') window.scrollTo(0, 0);
        current = v + (anchor ? '#' + anchor : '#');
      });
    }
  }
  window.addEventListener('hashchange', route);

  const toc = document.querySelector('.toc');
  document.querySelector('.toc-title').addEventListener('click', () => toc.classList.toggle('open'));
  toc.querySelector('ol').addEventListener('click', (e) => { if (e.target.closest('a')) toc.classList.remove('open'); });

  // ---------------------------------------------------------------- documents
  const cache = {};
  let shown = null;
  const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

  function loadDoc(name) {
    if (shown === name) return Promise.resolve();
    const article = document.querySelector('.doc');
    const text = cache[name] ? Promise.resolve(cache[name]) : fetch(DOCS[name], { cache: 'no-cache' })
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then((md) => (cache[name] = md));
    return text.then((md) => {
      shown = name;
      article.innerHTML = window.marked.parse(md, { gfm: true });
      const list = toc.querySelector('ol'); list.textContent = '';
      article.querySelectorAll('h2, h3').forEach((h) => {
        h.id = slug(h.textContent);
        const li = document.createElement('li'); if (h.tagName === 'H3') li.className = 'sub';
        const a = document.createElement('a'); a.href = '#' + name + '/' + h.id; a.textContent = h.textContent;
        li.appendChild(a); list.appendChild(li);
      });
      article.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
      // Copy buttons on code blocks: commands are meant to be pasted in a terminal
      article.querySelectorAll('pre > code:not(.language-mermaid)').forEach((code) => {
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'copy'; btn.textContent = 'Copy';
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(code.textContent).then(() => { btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1500); })
            .catch(() => { btn.textContent = 'Select + ⌘C'; });
        });
        code.parentElement.appendChild(btn);
      });
      watchToc(name);
      renderMermaid();
    }).catch((e) => { article.innerHTML = '<p class="muted">Could not load ' + DOCS[name] + ' (' + e.message + ').</p>'; shown = null; });
  }

  let observer = null;
  function watchToc(name) {
    if (observer) observer.disconnect();
    const links = new Map();
    toc.querySelectorAll('a').forEach((a) => links.set(a.getAttribute('href').split('/')[1], a));
    observer = new IntersectionObserver((entries) => {
      const top = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!top) return;
      links.forEach((a) => a.classList.remove('active'));
      const a = links.get(top.target.id); if (a) a.classList.add('active');
    }, { rootMargin: '-80px 0px -70% 0px' });
    document.querySelectorAll('.doc h2, .doc h3').forEach((h) => observer.observe(h));
    void name;
  }

  // Mermaid diagrams: loaded from jsDelivr when reachable; otherwise the source stays as code.
  let mermaidMod = null;
  function renderMermaid() {
    const blocks = Array.from(document.querySelectorAll('.doc pre > code.language-mermaid, .doc .mermaid-box'));
    if (!blocks.length) return;
    const load = mermaidMod ? Promise.resolve(mermaidMod)
      : import('https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs').then((m) => (mermaidMod = m.default));
    load.then(async (mermaid) => {
      mermaid.initialize({ startOnLoad: false, theme: isDark() ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'system-ui, sans-serif' });
      let i = 0;
      for (const b of blocks) {
        const src = b.dataset.src || b.textContent;
        const box = b.classList.contains('mermaid-box') ? b : document.createElement('div');
        box.className = 'mermaid-box'; box.dataset.src = src;
        try {
          const { svg } = await mermaid.render('mmd-' + Date.now() + '-' + (i++), src);
          box.innerHTML = svg;
          if (box !== b) b.parentElement.replaceWith(box);
        } catch (e) { /* keep the code block */ }
      }
    }).catch(() => { /* offline: source shown as code */ });
  }

  route();
})();
