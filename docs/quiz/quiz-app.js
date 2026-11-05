(() => {
  const $ = selector => document.querySelector(selector)
  const esc = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
  const RAW = window.QUIZ_QUESTIONS
  const EXTRA = window.QUIZ_MORE ?? []
  const CODING = window.QUIZ_CODING ?? []
  const DOMAINS = new Map(window.QUIZ_DOMAINS)
  const PART_META = new Map([...window.QUIZ_PARTS.map(([id, title, range]) => [id, { title, range }]), ['cross', { title: '综合', range: '跨课程' }]])
  const PART_BY_DOMAIN = { core:'core', context:'context', composition:'composition', execution:'execution', product:'product', quality:'quality', cross:'cross' }
  const QUESTIONS = [
    ...RAW.map(([id, lesson, domain, q, options, answer, explain, type = 'single']) => ({ id, lesson, domain, q, options, answer, explain, type, part: PART_BY_DOMAIN[domain] ?? 'cross' })),
    ...EXTRA.map(([id, lesson, part, q, options, answer, explain, type = 'single']) => ({ id, lesson, domain: part, part, q, options, answer, explain, type })),
  ]
  const CODING_TASKS = CODING.map(item => ({ ...item, type: 'coding', domain: item.part }))
  const state = { pool: [], index: 0, answers: [], revealed: [], filter: 'all', wrong: [], key: false }
  const app = document.getElementById('app')
  const bestEl = document.getElementById('best')
  bestEl.textContent = `最高分：${localStorage.getItem('dsh-quiz-best') || '—'}`
  const EMBED = new URLSearchParams(location.search).has('embed')

  if (EMBED) {
    document.documentElement.classList.add('embed'); document.body.classList.add('embed')
    const header = document.getElementById('quiz-header'); if (header) header.style.display = 'none'
    const foot = document.querySelector('.foot'); if (foot) foot.style.display = 'none'
    const notify = () => { try { parent.postMessage({ type: 'dsh-quiz-height', height: document.documentElement.scrollHeight }, '*') } catch {} }
    new ResizeObserver(notify).observe(document.body); setTimeout(notify, 80)
  }

  const partName = id => PART_META.get(id)?.title ?? id
  const questionsFor = id => id === 'all'
    ? [...QUESTIONS, ...CODING_TASKS]
    : [...QUESTIONS.filter(q => q.part === id), ...CODING_TASKS.filter(q => q.part === id)]
  const conceptOf = pool => pool.filter(q => q.type !== 'coding')
  const codingOf = pool => pool.filter(q => q.type === 'coding')
  const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort((x,y)=>x-y).every((v,i)=>v === [...b].sort((x,y)=>x-y)[i])
  const isCorrect = (q, answer) => q.type === 'multi' ? sameSet(answer, q.answer) : answer === q.answer
  const completedCoding = id => localStorage.getItem(`dsh-coding-completed:${id}`) === '1'
  const percent = (ok, total) => total === 0 ? 0 : Math.round(ok / total * 100)

  function landing() {
    const cards = [...PART_META.entries()].map(([id, meta]) => {
      const pool = questionsFor(id)
      return `<button class="domain-card" data-part="${id}"><span><b>${esc(meta.title)}</b><small>${esc(meta.range)} · ${conceptOf(pool).length} 概念 + ${codingOf(pool).length} coding</small></span><span>开始 →</span></button>`
    }).join('')
    app.innerHTML = `<div id="quiz-header">
      <div class="eyebrow">DSH · INTERVIEW SELF-TEST · LOCAL</div>
      <h1>DSH 面试自测</h1>
      <p class="lead">按 Part 练习：概念题覆盖 DSH 源码架构，最后几题进入对应课程的 AI Coding 任务。支持单选、多选、判断。</p>
      <p><a class="back" href="../../site/#/">← 返回课程</a></p>
    </div>
    <div class="meta"><span class="chip">${QUESTIONS.length} 概念题</span><span class="chip">${CODING_TASKS.length} coding</span><span class="chip">6 个 Part</span><span class="chip">本地判分</span></div>
    <div class="actions"><button class="primary" id="start-all">开始全部 ${QUESTIONS.length + CODING_TASKS.length} 题</button></div>
    <div class="domain-grid" style="margin-top:24px">${cards}</div>
    <p class="lead" style="font-size:13px">提示：键盘 1–4 选择，Enter 下一题。概念题计分；coding 单独标记通过。</p>`
    document.getElementById('start-all').onclick = () => start('all')
    app.querySelectorAll('[data-part]').forEach(button => button.onclick = () => start(button.dataset.part))
  }

  function start(filter = 'all') {
    state.filter = filter
    state.pool = questionsFor(filter)
    state.index = 0
    state.answers = new Array(state.pool.length).fill(null)
    state.revealed = new Array(state.pool.length).fill(false)
    state.wrong = []
    renderQuestion()
  }

  function renderQuestion() {
    const q = state.pool[state.index]
    if (q.type === 'coding') return renderCoding(q)
    const revealed = state.revealed[state.index]
    const chosen = state.answers[state.index]
    const pct = Math.round((state.index / state.pool.length) * 100)
    const isMulti = q.type === 'multi'
    const selected = Array.isArray(chosen) ? chosen : chosen === null ? [] : [chosen]
    const options = q.options.map((option, i) => {
      let cls = 'option'
      const correct = isMulti ? Array.isArray(q.answer) && q.answer.includes(i) : q.answer === i
      if (revealed) {
        if (correct) cls += ' correct'
        else if (selected.includes(i)) cls += ' wrong'
      } else if (selected.includes(i)) cls += ' selected'
      return `<button class="${cls}" data-opt="${i}" ${revealed ? 'disabled' : ''}><span class="num">${String.fromCharCode(65+i)}</span><span>${esc(option)}</span></button>`
    }).join('')
    const typeLabel = isMulti ? '多选题' : q.type === 'tf' ? '判断题' : '单选题'
    app.innerHTML = `<div class="quiz-head"><span>${state.index + 1} / ${state.pool.length}</span><span>${esc(partName(q.part))} · ${esc(q.lesson)}</span><span>已答 ${state.revealed.filter(Boolean).length}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="question">
        <div class="qtag"><span>${esc(q.id)}</span><span>${esc(typeLabel)}</span><span>${esc(partName(q.part))}</span></div>
        <h2>${esc(q.q)}</h2>
        ${options}
        <div class="explain ${revealed ? 'show' : ''}" id="explain"><b>答案：</b>${revealed ? formatAnswer(q) + '<br><br>' + esc(q.explain) + refFor(q) : ''}</div>
        <div class="actions">
          ${!revealed && isMulti ? `<button class="secondary" id="submit-answer" ${selected.length === 0 ? 'disabled' : ''}>提交多选</button>` : ''}
          ${revealed ? `<button class="primary" id="next">${state.index === state.pool.length - 1 ? '提交试卷 →' : '下一题 →'}</button>` : ''}
        </div>
      </div>`
    app.querySelectorAll('[data-opt]').forEach(button => button.onclick = () => choose(Number(button.dataset.opt)))
    if (!revealed && isMulti) document.getElementById('submit-answer').onclick = submitMulti
    if (revealed) document.getElementById('next').onclick = next
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  function renderCoding(q) {
    const done = completedCoding(q.taskId)
    const pct = Math.round((state.index / state.pool.length) * 100)
    app.innerHTML = `<div class="quiz-head"><span>${state.index + 1} / ${state.pool.length}</span><span>${esc(partName(q.part))} · coding</span><span>coding 单独计分</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="question coding-question">
        <div class="qtag"><span>${esc(q.id)}</span><span>CODING</span><span>${esc(q.lesson)}</span></div>
        <h2>${esc(q.title)}</h2>
        <p class="lead" style="font-size:13px">${esc(q.prompt)}</p>
        <div class="coding-state ${done ? 'ok' : ''}">${done ? '✓ 已通过该 coding 任务的测试' : '在 AI Coding Lab 里完成并跑通测试后，这里会标记完成。'}</div>
        <div class="actions"><button class="primary" id="open-coding">打开 Coding Lab →</button><button class="secondary" id="next">${state.index === state.pool.length - 1 ? '提交试卷 →' : '跳过，下一题 →'}</button></div>
        <p class="ref">完成状态保存在本机；不会把代码发到远端。</p>
      </div>`
    document.getElementById('open-coding').onclick = () => openCoding(q.taskId)
    document.getElementById('next').onclick = next
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  function openCoding(taskId) {
    if (window.parent !== window) parent.postMessage({ type: 'dsh-open-coding', taskId }, '*')
    else location.href = `../coding/index.html?task=${encodeURIComponent(taskId)}`
  }

  function formatAnswer(q) {
    if (q.type === 'multi') return q.answer.map(i => `${String.fromCharCode(65+i)} · ${esc(q.options[i])}`).join('<br>')
    return `${String.fromCharCode(65+q.answer)} · ${esc(q.options[q.answer])}`
  }

  function choose(index) {
    const q = state.pool[state.index]
    if (state.revealed[state.index]) return
    if (q.type === 'multi') {
      const current = Array.isArray(state.answers[state.index]) ? [...state.answers[state.index]] : []
      const at = current.indexOf(index)
      if (at >= 0) current.splice(at, 1); else current.push(index)
      state.answers[state.index] = current
      renderQuestion()
      return
    }
    state.answers[state.index] = index
    state.revealed[state.index] = true
    if (!isCorrect(q, index)) state.wrong.push({ q, chosen: index })
    renderQuestion()
  }

  function submitMulti() {
    const answer = state.answers[state.index]
    if (!Array.isArray(answer) || answer.length === 0) return
    state.revealed[state.index] = true
    if (!isCorrect(state.pool[state.index], answer)) state.wrong.push({ q: state.pool[state.index], chosen: [...answer] })
    renderQuestion()
  }

  function next() {
    if (state.index >= state.pool.length - 1) return renderScore()
    state.index += 1
    renderQuestion()
  }

  function renderScore() {
    const concept = conceptOf(state.pool)
    const coding = codingOf(state.pool)
    const correct = concept.filter(q => {
      const poolIndex = state.pool.indexOf(q)
      return isCorrect(q, state.answers[poolIndex])
    }).length
    const score = percent(correct, concept.length)
    const done = coding.filter(q => completedCoding(q.taskId)).length
    const best = Number(localStorage.getItem('dsh-quiz-best') || 0)
    if (score > best) { localStorage.setItem('dsh-quiz-best', String(score)); bestEl.textContent = `最高分：${score}` }
    const domainMap = new Map()
    for (const q of concept) {
      const index = state.pool.indexOf(q)
      if (!domainMap.has(q.part)) domainMap.set(q.part, { total: 0, ok: 0 })
      const row = domainMap.get(q.part); row.total += 1
      if (isCorrect(q, state.answers[index])) row.ok += 1
    }
    const rows = [...domainMap.entries()].map(([id, row]) => `<div class="brow"><span>${esc(partName(id))}</span><b>${row.ok} / ${row.total}</b></div>`).join('')
    const wrongHtml = state.wrong.map(({ q, chosen }) => `<div class="wrong"><h3>${esc(q.q)}</h3><p class="no">你的答案：${Array.isArray(chosen) ? chosen.map(i => String.fromCharCode(65+i)).join(', ') : String.fromCharCode(65+chosen)}</p><p class="yes">正确答案：${formatAnswer(q)}</p><p>${esc(q.explain)}</p>${refFor(q)}</div>`).join('')
    app.innerHTML = `<div class="result">
      <div class="eyebrow">RESULT · LOCAL SCORE</div>
      <div class="score">${score}<small> / 100</small></div>
      <h2>${score >= 80 ? '通过，面试可以继续深挖' : score >= 60 ? '基础有了，错题需要回看' : '先回课程，再回来做一遍'}</h2>
      <p>概念题答对 ${correct} / ${concept.length} · coding 通过 ${done} / ${coding.length}</p>
      <div class="breakdown">${rows}</div>
      <div class="actions" style="justify-content:center"><button class="primary" id="retry-all">重新开始</button>${state.wrong.length ? '<button class="secondary" id="retry-wrong">只做错题 ' + state.wrong.length + '</button>' : ''}</div>
      ${state.wrong.length ? `<div class="wrong-list"><div class="eyebrow" style="margin:24px 0 6px">REVIEW · 错题</div>${wrongHtml}</div>` : '<p style="margin-top:20px">概念题全部正确。</p>'}
    </div>`
    document.getElementById('retry-all').onclick = landing
    const rw = document.getElementById('retry-wrong')
    if (rw) rw.onclick = () => { state.pool = state.wrong.map(x => x.q); state.answers = new Array(state.pool.length).fill(null); state.revealed = new Array(state.pool.length).fill(false); state.wrong = []; state.index = 0; renderQuestion() }
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  const LESSON_REFS = {
    s01:['s01-agent-loop','3. 核心概念','3-核心概念'],s02:['s02-tool-round-trip','3. 核心概念','3-核心概念'],s03:['s03-session-log','3. 核心概念','3-核心概念'],s04:['s04-streaming','3. 核心概念','3-核心概念'],s05:['s05-tool-contract','3. 核心概念','3-核心概念'],s06:['s06-tool-runtime','3. 核心概念','3-核心概念'],s07:['s07-system-prompt','3. 核心概念','3-核心概念'],s08:['s08-inbox-steering','3. 核心概念','3-核心概念'],s09:['s09-llm-seam','3. 核心概念','3-核心概念'],s10:['s10-persistence','3. 核心概念','3-核心概念'],s11:['s11-compaction','3. 核心概念','3-核心概念'],s12:['s12-plugin-kernel','3. 核心概念','3-核心概念'],s13:['s13-composition-boot','3. 核心概念','3-核心概念'],s14:['s14-capability-seams','3. 核心概念','3-核心概念'],s15:['s15-subagents-presets','3. 核心概念','3-核心概念'],s16:['s16-ptc','3. 核心概念','3-核心概念'],s17:['s17-mcp-skills-commands','3. 核心概念','3-核心概念'],s18:['s18-skills-commands','3. 本课实现','3-本课实现'],s19:['s19-browser-use','3. 核心概念','3-核心概念'],s20:['s20-computer-use-i','3. 核心概念','3-核心概念'],s21:['s21-computer-use-ii','3. 核心概念','3-核心概念'],s22:['s22-web','3. 核心概念','3-核心概念'],s23:['s23-sdk-headless','3. 核心概念','3-核心概念'],s24:['s24-client-ui','3. 纯 fold 与增量一致性','3-纯-fold-与增量一致性'],s25:['s25-observability-eval','3. 核心概念','3-核心概念'],s26:['s26-eval','3. snapshot 与路径级 diff','3-snapshot-与路径级-diff'],s27:['s27-security','3. Redaction：按 key 和按值','3-redaction按-key-和按值'],s28:['s28-capstone','3. 任务与工具','3-任务与工具'],
  }
  function refFor(q) {
    const row = LESSON_REFS[q.lesson]
    if (!row) return '<div class="ref">知识点：综合 · 跨课知识</div>'
    const [slug, section, anchor] = row
    return `<div class="ref">知识点：<a href="https://github.com/scorpio13love/learn-deepseek-harness/blob/main/course/lessons/${slug}/README.md#${anchor}" target="_blank" rel="noreferrer">${esc(q.lesson)} · ${esc(section)} ↗</a></div>`
  }

  document.addEventListener('keydown', event => {
    if (!app.querySelector('.question')) return
    if (/^[1-4]$/.test(event.key)) {
      const option = app.querySelector(`[data-opt="${Number(event.key)-1}"]`)
      if (option && !option.disabled) option.click()
    }
    if (event.key === 'Enter') {
      const nextButton = document.getElementById('next')
      if (nextButton) nextButton.click()
    }
  })

  const part = new URLSearchParams(location.search).get('part')
  landing()
  if (part && PART_META.has(part)) start(part)
})()
