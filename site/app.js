(() => {
  const C = window.COURSE;
  const order = C.parts.flatMap(part => part.lessons);
  const lessons = C.lessons;
  const state = {
    current: null,
    doc: null,
    markdown: new Map(),
    toc: [],
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

  const progressKey = 'dsh-course-progress-v1';
  const themeKey = 'dsh-course-theme';
  const lastKey = 'dsh-course-last';

  function safeGet(key) {
    try { return localStorage.getItem(key) } catch { return null }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value) } catch { /* file:// 或隐私模式可能禁用 */ }
  }

  function readProgress() {
    try {
      const value = JSON.parse(safeGet(progressKey) ?? '[]');
      return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string' && lessons[item]) : []);
    } catch {
      return new Set();
    }
  }
  function writeProgress(set) {
    safeSet(progressKey, JSON.stringify([...set]));
  }

  let completed = readProgress();

  function initTheme() {
    const saved = safeGet(themeKey);
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    setTheme(saved ?? (prefersDark ? 'dark' : 'light'));
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    safeSet(themeKey, theme);
  }

  function difficulty(level) {
    return `<span class="difficulty" aria-label="难度 ${level}/5">${[1, 2, 3, 4, 5].map(n => `<i class="${n <= level ? 'on' : ''}"></i>`).join('')}</span>`;
  }

  function sourceHref(source) {
    const brace = source.indexOf('{');
    let clean;
    let forcedKind;
    if (brace >= 0) {
      // `core/session/src/{index,surface}.ts` 不是 GitHub 能识别的单文件路径，
      // 退到它所在的目录；不要把大括号里的逗号当成多来源分隔符。
      clean = source.slice(0, source.lastIndexOf('/', brace)).trim();
      forcedKind = 'tree';
    } else {
      clean = source.split(',')[0].trim();
      clean = clean.replace(/\*.*$/, '').replace(/\/$/, '');
      forcedKind = /\.[A-Za-z0-9]+$/.test(clean) ? 'blob' : 'tree';
    }
    const topLevel = /^(vendor|apps|docs|snapshots|benchmarks|native|website|packages)\//.test(clean);
    return `${C.repo}/${forcedKind}/${C.branch}/${topLevel ? '' : 'packages/'}${clean}`;
  }

  /* ------------------------------------------------------------------ */
  /* Markdown                                                           */
  /* ------------------------------------------------------------------ */

  function slugify(text) {
    return text.toLowerCase()
      .replace(/<[^>]+>/g, '')
      .replace(/[`*_~]/g, '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'section';
  }

  function rewriteHref(href, slug) {
    if (!href || /^(https?:|mailto:|#|data:)/.test(href)) return href;
    if (href.includes('deepseek-harness/')) {
      const [path, anchor] = href.split('#');
      const rest = path.slice(path.indexOf('deepseek-harness/') + 'deepseek-harness/'.length);
      if (rest.includes('{')) {
        const directory = rest.slice(0, rest.lastIndexOf('/'));
        return `${C.repo}/tree/${C.branch}/${directory}${anchor ? `#${anchor}` : ''}`;
      }
      const kind = /\.[A-Za-z0-9]+$/.test(rest) ? 'blob' : 'tree';
      return `${C.repo}/${kind}/${C.branch}/${rest}${anchor ? `#${anchor}` : ''}`;
    }
    if (href.startsWith('src/') || href.startsWith('tests/')) {
      return `/course/lessons/${slug}/${href}`;
    }
    if (href.startsWith('../course/')) return href.slice(2);
    if (href.startsWith('../../')) return href.replace(/^(\.\.\/)+/, '/');
    return href;
  }

  function inline(text, slug) {
    const codes = [];
    let value = escapeHtml(text);
    value = value.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(`<code>${code}</code>`);
      return `\u0000CODE${codes.length - 1}\u0000`;
    });
    value = value.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      return `<img src="${escapeHtml(rewriteHref(src, slug))}" alt="${escapeHtml(alt)}" loading="lazy">`;
    });
    value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      if (href.startsWith('#') && !href.startsWith('#/')) {
        return `<a href="#" data-anchor="${escapeHtml(href.slice(1))}">${label}</a>`;
      }
      const target = rewriteHref(href.replaceAll('&amp;', '&'), slug);
      const external = /^https?:/.test(target);
      return `<a href="${escapeHtml(target)}"${external ? ' target="_blank" rel="noreferrer"' : ''}>${label}</a>`;
    });
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    value = value.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    value = value.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codes[Number(index)]);
    return value;
  }

  function isBlockStart(lines, i) {
    const line = lines[i];
    return /^\s*$/.test(line)
      || /^```/.test(line)
      || /^#{1,6}\s+/.test(line)
      || /^\s*>/.test(line)
      || /^\s*([-*+]|\d+\.)\s+/.test(line)
      || /^\s*([-*_])\1{2,}\s*$/.test(line)
      || /^<!--/.test(line)
      || isTableStart(lines, i);
  }

  function isTableStart(lines, i) {
    return i + 1 < lines.length
      && /\|/.test(lines[i])
      && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] ?? '')
      && /-/.test(lines[i + 1] ?? '');
  }

  function splitRow(line) {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map(cell => cell.trim());
  }

  function renderTable(lines, start, slug) {
    const header = splitRow(lines[start]);
    const align = splitRow(lines[start + 1]).map(cell => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
    });
    let i = start + 2;
    const rows = [];
    while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
      rows.push(splitRow(lines[i]));
      i += 1;
    }
    const style = (index) => align[index] ? ` style="text-align:${align[index]}"` : '';
    const head = `<thead><tr>${header.map((cell, index) => `<th${style(index)}>${inline(cell, slug)}</th>`).join('')}</tr></thead>`;
    const body = rows.length === 0 ? '' : `<tbody>${rows.map(row => `<tr>${header.map((_, index) => `<td${style(index)}>${inline(row[index] ?? '', slug)}</td>`).join('')}</tr>`).join('')}</tbody>`;
    return [`<div class="table-wrap"><table>${head}${body}</table></div>`, i];
  }

  function renderList(lines, start, slug, baseIndent) {
    const first = /^(\s*)([-*+]|\d+\.)\s+/.exec(lines[start]);
    const ordered = first ? /\d+\./.test(first[2]) : false;
    const tag = ordered ? 'ol' : 'ul';
    let html = `<${tag}>`;
    let i = start;
    while (i < lines.length) {
      const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
      if (!match) break;
      const indent = match[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        const [nested, next] = renderList(lines, i, slug, indent);
        html += nested;
        i = next;
        continue;
      }
      let content = match[3];
      let nestedHtml = '';
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (/^\s*$/.test(next)) break;
        const nextItem = /^(\s*)([-*+]|\d+\.)\s+/.exec(next);
        if (nextItem && nextItem[1].length > baseIndent) {
          const [nested, after] = renderList(lines, i, slug, nextItem[1].length);
          nestedHtml += nested;
          i = after;
          continue;
        }
        if (nextItem) break;
        if (/^\s{2,}/.test(next)) {
          content += ` ${next.trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      html += `<li>${inline(content, slug)}${nestedHtml}</li>`;
    }
    html += `</${tag}>`;
    return [html, i];
  }

  function renderMarkdown(markdown, slug) {
    const lines = markdown.replace(/\r\n/g, '\n').replace(/^#\s+.*\n+/, '').split('\n');
    const html = [];
    const usedIds = new Map();
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { i += 1; continue; }
      if (/^<!--/.test(line)) {
        while (i < lines.length && !lines[i].includes('-->')) i += 1;
        i += 1;
        continue;
      }
      if (/^```/.test(line)) {
        const lang = line.slice(3).trim() || 'text';
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
        i += 1;
        const id = `code-${usedIds.size}-${Math.random().toString(36).slice(2, 7)}`;
        html.push(`<div class="code-card"><div class="code-head"><span>${escapeHtml(lang)}</span><button class="copy-button" data-copy="${id}">复制</button></div><pre id="${id}"><code class="language-${escapeHtml(lang)}">${escapeHtml(code.join('\n'))}</code></pre></div>`);
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) {
        const match = /^(#{1,6})\s+(.*)$/.exec(line);
        const level = match[1].length;
        const text = match[2];
        if (level === 1) { i += 1; continue; }
        const base = slugify(text);
        const count = usedIds.get(base) ?? 0;
        usedIds.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count + 1}`;
        if (level <= 3) {
          html.push(`<h${level} id="${id}">${inline(text, slug)}<a class="heading-anchor" href="#" data-anchor="${id}" aria-label="链接到此节">#</a></h${level}>`);
        } else {
          html.push(`<h${level} id="${id}">${inline(text, slug)}</h${level}>`);
        }
        i += 1;
        continue;
      }
      if (isTableStart(lines, i)) {
        const [table, next] = renderTable(lines, i, slug);
        html.push(table);
        i = next;
        continue;
      }
      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ''));
          i += 1;
        }
        html.push(`<blockquote>${quote.map(item => `<p>${inline(item, slug)}</p>`).join('')}</blockquote>`);
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        html.push('<hr>');
        i += 1;
        continue;
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const indent = /^(\s*)/.exec(line)[1].length;
        const [list, next] = renderList(lines, i, slug, indent);
        html.push(list);
        i = next;
        continue;
      }
      const paragraph = [line];
      i += 1;
      while (i < lines.length && !isBlockStart(lines, i)) {
        paragraph.push(lines[i]);
        i += 1;
      }
      html.push(`<p>${inline(paragraph.join(' '), slug)}</p>`);
    }
    return html.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Layout                                                             */
  /* ------------------------------------------------------------------ */

  function renderSidebar() {
    const nav = $('#lesson-nav');
    const docsNav = `<div class="nav-part nav-docs">
      <div class="nav-part-title"><span>文档</span><span>${C.docs.length} 篇</span></div>
      ${C.docs.map(doc => `<a class="nav-doc" href="#/docs/${doc.id}" data-doc="${doc.id}">
        <span class="nav-num">§</span>
        <span class="nav-name">${escapeHtml(doc.short)}</span>
      </a>`).join('')}
    </div>`;
    const partsNav = C.parts.map(part => {
      const rows = part.lessons.map(slug => {
        const lesson = lessons[slug];
        return `<a class="nav-lesson${completed.has(slug) ? ' done' : ''}" href="#/${slug}" data-slug="${slug}" data-search="${escapeHtml(`${lesson.title} ${lesson.short} ${lesson.tags.join(' ')}`)}">
          <span class="nav-num">${String(lesson.n).padStart(2, '0')}</span>
          <span class="nav-name">${escapeHtml(lesson.title)}</span>
          <span class="nav-dot"></span>
        </a>`;
      }).join('');
      return `<div class="nav-part" data-part="${part.id}">
        <div class="nav-part-title"><span>${escapeHtml(part.title)}</span><span>${part.lessons.length} 课</span></div>
        ${rows}
      </div>`;
    }).join('') + '<div class="search-empty" id="search-empty" hidden>没有匹配的课程</div>';
    nav.innerHTML = docsNav + partsNav;
    updateProgress();
  }

  function setActiveNav() {
    $$('.nav-lesson').forEach(item => {
      item.classList.toggle('active', item.dataset.slug === state.current);
      if (item.dataset.slug === state.current) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
    $$('.nav-doc').forEach(item => {
      item.classList.toggle('active', item.dataset.doc === state.doc);
      if (item.dataset.doc === state.doc) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    });
  }

  function updateProgress() {
    const total = order.length;
    const count = completed.size;
    $('#progress-label').textContent = `${count} / ${total}`;
    $('#progress-bar').style.width = `${(count / total) * 100}%`;
    $$('.nav-lesson').forEach(item => item.classList.toggle('done', completed.has(item.dataset.slug)));
  }

  function renderHome() {
    state.current = null;
    state.doc = null;
    document.body.classList.add('is-home');
    $('#source-link').hidden = true;
    $('#toc-list').innerHTML = '';
    $('#toc').classList.add('is-hidden');
    $('#breadcrumb').innerHTML = '<span>课程首页</span>';
    document.title = `${C.title} · 18 课重写 Agent Harness`;

    const modules = C.parts.map((part, index) => {
      const rows = part.lessons.map(slug => {
        const lesson = lessons[slug];
        return `<a class="module-lesson${completed.has(slug) ? ' done' : ''}" href="#/${slug}">
          <span class="num">${String(lesson.n).padStart(2, '0')}</span>
          <span>${escapeHtml(lesson.title)}</span>
          <span class="arrow">→</span>
        </a>`;
      }).join('');
      return `<article class="module-card">
        <div class="module-card-top">
          <div>
            <div class="module-index">PART ${String(index + 1).padStart(2, '0')}</div>
            <h3>${escapeHtml(part.title.replace(/^[IVX]+ · /, ''))}</h3>
            <p>${escapeHtml(part.subtitle)}</p>
          </div>
          <span class="module-count">${part.lessons.length} 课</span>
        </div>
        <div class="module-lessons">${rows}</div>
      </article>`;
    }).join('');

    const next = order.find(slug => !completed.has(slug)) ?? order[0];

    $('#content').innerHTML = `<div class="home">
      <section class="hero">
        <span class="eyebrow">18 lessons · source-guided</span>
        <h1>从零重写一个<br><em>生产级 Agent Harness</em></h1>
        <p>${escapeHtml(C.description)} 每课一个可运行快照，对照真实源码解释「为什么生产实现要这么做」。</p>
        <div class="hero-actions">
          <a class="primary-button" href="#/${next}">${completed.size === 0 ? '从 s01 开始' : '继续学习'} <span>→</span></a>
          <a class="secondary-button" href="#/docs/architecture">先读架构笔记 →</a>
        </div>
        <div class="hero-stats">
          ${C.stats.map(stat => `<div class="hero-stat"><strong>${escapeHtml(stat.value)}</strong><span>${escapeHtml(stat.label)}</span></div>`).join('')}
        </div>
      </section>

      <section class="section">
        <div class="section-head"><div><h2>先读文档</h2><p>架构背景与课程设计，先建立全局图再进入代码</p></div></div>
        <div class="doc-grid">
          ${C.docs.map(doc => `<a class="doc-card" href="#/docs/${doc.id}">
            <span class="doc-badge">${escapeHtml(doc.badge)}</span>
            <h3>${escapeHtml(doc.title)}</h3>
            <p>${escapeHtml(doc.desc)}</p>
            <span class="doc-open">打开 →</span>
          </a>`).join('')}
        </div>
      </section>

      <section class="section">
        <div class="section-head"><div><h2>课程地图</h2><p>四段式难度曲线：内核 → 上下文 → 工程化 → 产品化</p></div></div>
        <div class="module-grid">${modules}</div>
      </section>

      <section class="section">
        <div class="section-head"><div><h2>为什么这样学</h2><p>不是 API 教程，也不是 prompt 技巧合集</p></div></div>
        <div class="feature-grid">
          <div class="feature"><div class="feature-icon">⌁</div><h3>真实源码对照</h3><p>每个概念都指向 DSH 的真实文件与函数，每课附源码位置和带答案的思考题。</p></div>
          <div class="feature"><div class="feature-icon">▣</div><h3>每课都能跑</h3><p>Node 24 原生 TypeScript，零运行时依赖；demo、测试、env.example 都在课内。</p></div>
          <div class="feature"><div class="feature-icon">↯</div><h3>真实模型</h3><p>默认 deepseek-flash，不做假模型；缺少 key 时 live 测试自动跳过。</p></div>
        </div>
      </section>

      <section class="section">
        <div class="section-head"><div><h2>推荐节奏</h2><p>每课 2–5 小时，每 3 课做一次回顾</p></div></div>
        <div class="feature-grid">
          <div class="feature"><div class="feature-icon">1</div><h3>先跑再读</h3><p>先跑 demo，观察事件序列，再读讲义和真实源码。</p></div>
          <div class="feature"><div class="feature-icon">2</div><h3>改代码</h3><p>做练习，跑离线测试；有 key 时跑 live 测试。</p></div>
          <div class="feature"><div class="feature-icon">3</div><h3>重写一遍</h3><p>每三课从空目录重写该阶段核心，把理解变成肌肉记忆。</p></div>
        </div>
      </section>
    </div>`;
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  async function loadLesson(slug) {
    if (!lessons[slug]) { location.hash = '#/'; return; }
    const lesson = lessons[slug];
    state.current = slug;
    state.doc = null;
    safeSet(lastKey, slug);

    if (!state.markdown.has(slug)) {
      const response = await fetch(`../course/lessons/${slug}/README.md`);
      if (!response.ok) throw new Error(`无法加载课程内容：${slug}`);
      state.markdown.set(slug, await response.text());
    }

    const part = C.parts.find(item => item.id === lesson.part);
    document.body.classList.remove('is-home');
    $('#source-link').hidden = false;
    $('#source-link').href = sourceHref(lesson.source);
    $('#toc').classList.remove('is-hidden');
    $('#breadcrumb').innerHTML = `<span>${escapeHtml(part.title)}</span><span>/</span><strong>${String(lesson.n).padStart(2, '0')} · ${escapeHtml(lesson.title)}</strong>`;
    document.title = `s${String(lesson.n).padStart(2, '0')} · ${lesson.title} · ${C.title}`;

    const isDone = completed.has(slug);
    const index = order.indexOf(slug);
    const prev = index > 0 ? lessons[order[index - 1]] : null;
    const next = index < order.length - 1 ? lessons[order[index + 1]] : null;

    $('#content').innerHTML = `<article class="lesson">
      <header class="lesson-hero">
        <div class="lesson-kicker"><span>LESSON ${String(lesson.n).padStart(2, '0')}</span><span class="dot"></span><span>${escapeHtml(part.title)}</span></div>
        <h1>${escapeHtml(lesson.title)}</h1>
        <p class="lesson-subtitle">${escapeHtml(lesson.desc)}</p>
        <div class="lesson-meta">
          <span class="chip accent">${escapeHtml(lesson.hours)}</span>
          <span class="chip">${difficulty(lesson.difficulty)}</span>
          <span class="chip">${escapeHtml(lesson.tests)}</span>
          ${lesson.tags.map(tag => `<span class="chip">${escapeHtml(tag)}</span>`).join('')}
          <button class="complete-button${isDone ? ' done' : ''}" id="complete-button">${isDone ? '✓ 已完成' : '标记完成'}</button>
        </div>
      </header>
      <div class="markdown" id="lesson-markdown">${renderMarkdown(state.markdown.get(slug), slug)}</div>
      <footer class="lesson-foot">
        ${prev ? `<a class="pager" href="#/${order[index - 1]}"><span>上一课</span><strong>← s${String(prev.n).padStart(2, '0')} ${escapeHtml(prev.title)}</strong></a>` : '<span></span>'}
        ${next ? `<a class="pager next" href="#/${order[index + 1]}"><span>下一课</span><strong>s${String(next.n).padStart(2, '0')} ${escapeHtml(next.title)} →</strong></a>` : '<a class="pager next" href="#/"><span>结课</span><strong>回到课程地图 →</strong></a>'}
      </footer>
    </article>`;

    buildToc();
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'instant' });
    // 不主动 focus，避免浏览器给内容区画 focus ring。
  }

  async function loadDoc(id) {
    const doc = C.docs.find(item => item.id === id);
    if (doc === undefined) { location.hash = '#/'; return; }
    state.current = null;
    state.doc = id;

    const response = await fetch(doc.file);
    if (!response.ok) throw new Error(`无法加载文档：${doc.title}`);
    const markdown = await response.text();

    const index = C.docs.findIndex(item => item.id === id);
    const prev = index > 0 ? C.docs[index - 1] : null;
    const next = index < C.docs.length - 1 ? C.docs[index + 1] : null;

    document.body.classList.remove('is-home');
    $('#source-link').hidden = true;
    $('#toc').classList.remove('is-hidden');
    $('#breadcrumb').innerHTML = `<span>文档</span><span>/</span><strong>${escapeHtml(doc.short)}</strong>`;
    document.title = `${doc.title} · ${C.title}`;

    $('#content').innerHTML = `<article class="lesson doc-page">
      <header class="lesson-hero">
        <div class="lesson-kicker"><span>DOCS</span><span class="dot"></span><span>${escapeHtml(doc.badge)}</span></div>
        <h1>${escapeHtml(doc.title)}</h1>
        <p class="lesson-subtitle">${escapeHtml(doc.desc)}</p>
        <div class="lesson-meta">
          <span class="chip accent">${escapeHtml(doc.badge)}</span>
          <a class="chip" href="${escapeHtml(doc.file)}?raw=1" target="_blank" rel="noreferrer">原始 Markdown ↗</a>
          <a class="complete-button" href="#/">课程地图</a>
        </div>
      </header>
      <div class="markdown" id="lesson-markdown">${renderMarkdown(markdown, `docs-${id}`)}</div>
      <footer class="lesson-foot">
        ${prev ? `<a class="pager" href="#/docs/${prev.id}"><span>上一篇</span><strong>← ${escapeHtml(prev.short)}</strong></a>` : '<a class="pager" href="#/"><span>返回</span><strong>← 课程地图</strong></a>'}
        ${next ? `<a class="pager next" href="#/docs/${next.id}"><span>下一篇</span><strong>${escapeHtml(next.short)} →</strong></a>` : '<a class="pager next" href="#/"><span>结束</span><strong>回到课程地图 →</strong></a>'}
      </footer>
    </article>`;

    buildToc();
    updateProgress();
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function buildToc() {
    const headings = $$('#lesson-markdown h2, #lesson-markdown h3');
    const list = $('#toc-list');
    list.innerHTML = headings.map(heading => `<li class="lvl-${heading.tagName === 'H2' ? '2' : '3'}"><a href="#" data-target="${heading.id}">${escapeHtml(heading.textContent.replace('#', '').trim())}</a></li>`).join('');
    state.toc = headings;
    updateTocActive();
  }

  function updateTocActive() {
    if ((state.current === null && state.doc === null) || state.toc.length === 0) return;
    const y = window.scrollY + 120;
    let active = state.toc[0];
    for (const heading of state.toc) {
      const top = heading.getBoundingClientRect().top + window.scrollY;
      if (top <= y) active = heading;
    }
    $$('#toc-list a').forEach(link => link.classList.toggle('active', link.dataset.target === active?.id));
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */

  async function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    try {
      if (!hash) renderHome();
      else if (hash.startsWith('docs/')) await loadDoc(hash.slice(5));
      else await loadLesson(hash);
    } catch (error) {
      $('#content').innerHTML = `<div class="home"><div class="hero"><h1>加载失败</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></div></div>`;
    }
    updateProgress();
    setActiveNav();
    closeSidebar();
  }

  function closeSidebar() {
    $('#sidebar').classList.remove('open');
    $('#sidebar-scrim').classList.remove('show');
  }

  function toggleComplete() {
    if (state.current === null) return;
    if (completed.has(state.current)) completed.delete(state.current);
    else completed.add(state.current);
    writeProgress(completed);
    const button = $('#complete-button');
    if (button) {
      const done = completed.has(state.current);
      button.classList.toggle('done', done);
      button.textContent = done ? '✓ 已完成' : '标记完成';
    }
    updateProgress();
  }

  function copyCode(button) {
    const id = button.dataset.copy;
    const code = document.getElementById(id)?.textContent ?? '';
    navigator.clipboard?.writeText(code).then(() => {
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = '复制'; }, 1200);
    }).catch(() => {
      button.textContent = '复制失败';
      setTimeout(() => { button.textContent = '复制'; }, 1200);
    });
  }

  function filterNav() {
    const query = $('#lesson-search').value.trim().toLowerCase();
    let visible = 0;
    $$('.nav-part').forEach(part => {
      let partVisible = 0;
      $$('.nav-lesson', part).forEach(item => {
        const match = query.length === 0 || item.dataset.search.toLowerCase().includes(query);
        item.classList.toggle('hidden', !match);
        if (match) { visible += 1; partVisible += 1; }
      });
      part.style.display = partVisible === 0 ? 'none' : '';
    });
    $('#search-empty').hidden = visible > 0;
  }

  function readingProgress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, window.scrollY / max));
    $('#reading-progress').style.width = `${ratio * 100}%`;
    updateTocActive();
  }

  function init() {
    initTheme();
    renderSidebar();
    const last = safeGet(lastKey);
    if (!location.hash) {
      if (last && lessons[last]) location.hash = `#/${last}`;
      else renderHome();
    }
    route();

    window.addEventListener('hashchange', route);
    window.addEventListener('scroll', readingProgress, { passive: true });
    $('#theme-toggle').addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });
    $('#menu-button').addEventListener('click', () => {
      $('#sidebar').classList.toggle('open');
      $('#sidebar-scrim').classList.toggle('show');
    });
    $('#sidebar-scrim').addEventListener('click', closeSidebar);
    $('#lesson-search').addEventListener('input', filterNav);
    $('#content').addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const copy = target.closest('[data-copy]');
      if (copy) { copyCode(copy); return; }
      const jump = target.closest('[data-anchor], [data-target]');
      if (jump) {
        event.preventDefault();
        const id = jump.dataset.anchor ?? jump.dataset.target;
        const heading = id ? document.getElementById(id) : null;
        heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      if (target.closest('#complete-button')) { toggleComplete(); return; }
      const anchor = target.closest('a');
      if (anchor && anchor.getAttribute('href')?.startsWith('#')) {
        // 页内标题链接：交给浏览器平滑滚动。
      }
    });
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const jump = target.closest('[data-anchor], [data-target]');
      if (!jump) return;
      event.preventDefault();
      const id = jump.dataset.anchor ?? jump.dataset.target;
      const heading = id ? document.getElementById(id) : null;
      heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'Escape') closeSidebar();
      if (event.key === '[' || event.key === ']') {
        const index = order.indexOf(state.current);
        if (index < 0) return;
        const next = event.key === ']' ? order[index + 1] : order[index - 1];
        if (next) location.hash = `#/${next}`;
      }
    });
  }

  init();
})();
