/** 极简 HTML 渲染器：没有 React，只做转义和语义标签。 */

import type { ActionCard } from './types.ts'

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function cardHtml(card: ActionCard): string {
  const payload = JSON.stringify(card.payload, null, 2)
  return [
    `<article class="card card--${card.kind}" data-kind="${card.kind}" data-id="${escapeHtml(card.id)}" data-status="${card.status}">`,
    `  <header><span class="badge">${escapeHtml(card.kind)}</span><span class="status">${escapeHtml(card.status)}</span></header>`,
    `  <h3>${escapeHtml(card.title)}</h3>`,
    `  <p class="summary">${escapeHtml(card.summary)}</p>`,
    `  <details><summary>payload</summary><pre>${escapeHtml(payload)}</pre></details>`,
    `</article>`,
  ].join('\n')
}

export function cardsToHtml(cards: readonly ActionCard[]): string {
  return cards.map(cardHtml).join('\n')
}

export function pageHtml(cards: readonly ActionCard[], seq: number): string {
  return `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>s24 · action cards</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  .card { border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 12px; padding: 0.9rem 1rem; margin: 0.8rem 0; }
  .card--tool-call { border-left: 4px solid #3b82f6; }
  .card--tool-result { border-left: 4px solid #10b981; }
  .card--approval { border-left: 4px solid #f59e0b; }
  .card--error { border-left: 4px solid #ef4444; }
  header { display: flex; justify-content: space-between; font-size: 0.8rem; opacity: 0.75; }
  h3 { margin: 0.35rem 0; font-size: 1rem; }
  .summary { margin: 0.3rem 0; white-space: pre-wrap; }
  pre { overflow: auto; padding: 0.6rem; background: color-mix(in srgb, currentColor 8%, transparent); border-radius: 8px; font-size: 0.8rem; }
  .meta { opacity: 0.65; font-size: 0.8rem; }
  .card[data-status="denied"], .card[data-status="failed"] { background: color-mix(in srgb, #ef4444 8%, transparent); }
</style>
<h1>Action cards</h1>
<p class="meta">snapshot seq=${seq} · ${cards.length} cards</p>
${cardsToHtml(cards)}
</html>`
}
