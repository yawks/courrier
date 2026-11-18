/** Mark visible text without replacing sender HTML or disturbing its links. */
export function highlightMailMatches(root: HTMLElement, query: string): HTMLElement[][] {
  clearMailMatches(root);
  if (!query) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);
  const nodes: { node: Text; start: number; end: number }[] = [];
  let text = '';
  let previousBlock: Element | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, noscript, [hidden], .qt-toggle')) continue;
    let visible = true;
    for (let el: HTMLElement | null = parent; el && el !== root; el = el.parentElement) {
      const style = doc.defaultView?.getComputedStyle(el);
      if (style?.display === 'none' || style?.visibility === 'hidden') { visible = false; break; }
    }
    if (!visible) continue;
    const block = parent.closest('p, div, li, td, th, pre, blockquote, h1, h2, h3, h4');
    if (nodes.length && block !== previousBlock) text += '\n';
    previousBlock = block;
    nodes.push({ node, start: text.length, end: text.length + node.length });
    text += node.data;
  }
  // Escaping keeps punctuation literal; the i flag preserves original offsets.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const matches = [...text.matchAll(pattern)];
  const groups: HTMLElement[][] = matches.map(() => []);
  // Work backwards so offsets in each original text node remain valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const start = matches[i].index!;
    const end = start + matches[i][0].length;
    for (const entry of nodes) {
      if (entry.start >= end || entry.end <= start) continue;
      const range = doc.createRange();
      range.setStart(entry.node, Math.max(0, start - entry.start));
      range.setEnd(entry.node, Math.min(entry.node.length, end - entry.start));
      const mark = doc.createElement('mark');
      mark.dataset.mailSearch = '';
      range.surroundContents(mark);
      groups[i].push(mark);
    }
  }
  return groups;
}

export function clearMailMatches(root: HTMLElement) {
  root.querySelectorAll('[data-mail-search]').forEach(mark => mark.replaceWith(...mark.childNodes));
  root.normalize();
}
