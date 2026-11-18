// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { clearMailMatches, highlightMailMatches } from './mailMessageSearch';

describe('highlightMailMatches', () => {
  it('finds literal, case insensitive matches across inline nodes and restores HTML', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>Hello <b>WORLD</b>! Hello world!</p><a href="https://example.com">[test]</a>';
    document.body.append(root);
    const original = root.innerHTML;
    expect(highlightMailMatches(root, 'hello world').map(group => group.map(mark => mark.textContent).join(''))).toEqual(['Hello WORLD', 'Hello world']);
    expect(highlightMailMatches(root, '[test]')).toHaveLength(1);
    clearMailMatches(root);
    expect(root.innerHTML).toBe(original);
    root.remove();
  });
  it('ignores folded content and scripts and clears an empty query', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p>aaa AAA</p><div style="display:none">aaa</div><script>aaa</script><span hidden>aaa</span>';
    document.body.append(root);
    expect(highlightMailMatches(root, 'aaa')).toHaveLength(2);
    expect(highlightMailMatches(root, 'absent')).toHaveLength(0);
    expect(highlightMailMatches(root, 'aa')).toHaveLength(2);
    expect(highlightMailMatches(root, '')).toEqual([]);
    expect(root.querySelector('mark')).toBeNull();
    root.remove();
  });
});
