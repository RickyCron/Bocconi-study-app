import { escapeHtml } from './utils.js';

export function inlineMd(text) {
  // Extract markdown links before escaping so URLs aren't mangled
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const parts = [];
  let lastIndex = 0, match;
  while ((match = linkRe.exec(text)) !== null) {
    parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    parts.push({ type: 'link', label: match[1], url: match[2] });
    lastIndex = match.index + match[0].length;
  }
  parts.push({ type: 'text', content: text.slice(lastIndex) });

  return parts.map(p => {
    if (p.type === 'link') {
      return `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" class="md-link">${escapeHtml(p.label)}</a>`;
    }
    return escapeHtml(p.content)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+?)`/g, '<code class="md-code">$1</code>');
  }).join('');
}

export function renderMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let listBuf = [];

  function flushList() {
    if (!listBuf.length) return;
    out.push(`<ul class="md-list">${listBuf.map(l => `<li>${l}</li>`).join('')}</ul>`);
    listBuf = [];
  }

  for (const raw of lines) {
    const h2 = raw.match(/^## (.+)$/);
    const h3 = raw.match(/^### (.+)$/);
    const li = raw.match(/^[-*•] (.+)$/) || raw.match(/^\d+\. (.+)$/);
    const hr = raw.match(/^-{3,}$/);

    if (h2)        { flushList(); out.push(`<span class="md-h2">${inlineMd(h2[1])}</span>`); }
    else if (h3)   { flushList(); out.push(`<span class="md-h3">${inlineMd(h3[1])}</span>`); }
    else if (li)   { listBuf.push(inlineMd(li[1])); }
    else if (hr)   { flushList(); out.push('<hr class="md-hr">'); }
    else if (!raw.trim()) { flushList(); }
    else           { flushList(); out.push(`<span class="md-p">${inlineMd(raw)}</span>`); }
  }
  flushList();
  return out.join('');
}
