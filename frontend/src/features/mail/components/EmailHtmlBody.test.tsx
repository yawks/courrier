// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useMailContentRules } from '../../../shared/store/MailContentRulesStore';
import { processEmailQuotes } from '../utils/emailQuoteParser';
import { openExternalUrl } from '../../../shared/services/fileService';
import { forwardedGmailOutlookHtml, forwardedGmailOutlookText } from './__fixtures__/forwardedGmailOutlookMessage';

vi.mock('../../../shared/store/MailContentRulesStore', () => ({ useMailContentRules: vi.fn(() => ({ rules: [], save: vi.fn() })) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string | { defaultValue?: string }) =>
    typeof fallback === 'string' ? fallback : fallback?.defaultValue ?? _key }),
}));
vi.mock('../../../shared/store/ThemeStore', () => ({ useTheme: () => ({ resolved: 'light' }) }));
vi.mock('../../../shared/store/FontSizeStore', () => ({ useFontSize: () => ({ fontSize: 'medium' }) }));
vi.mock('../../../shared/services/fileService', () => ({ openExternalUrl: vi.fn() }));
vi.mock('../../../shared/platform', () => ({ platform: { isNativeAndroid: false } }));

import { EmailHtmlBody } from './EmailHtmlBody';

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(useMailContentRules).mockReturnValue({ rules: [], save: vi.fn() });
  document.body.replaceChildren();
});

describe('EmailHtmlBody links', () => {
  it.each([false, true])('opens links after fallback restores the DOM (load handler ran: %s)', async loaded => {
    vi.useFakeTimers();
    const host = document.createElement('div');
    document.body.append(host);
    const component = createRoot(host);
    const html = '<p><a href="https://example.com/unsubscribe"><span>Unsubscribe</span></a></p>';
    await act(async () => component.render(<EmailHtmlBody html={html} />));
    const frame = host.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<div class="ew">${html}</div>`;
    if (loaded) await act(async () => frame.dispatchEvent(new Event('load')));
    frame.style.visibility = 'hidden';
    await act(async () => vi.advanceTimersByTime(500));
    expect(frame.style.visibility).toBe('visible');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    doc.querySelector('a span')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/unsubscribe');
    await act(async () => component.unmount());
  });

  it('keeps small unsubscribe links native and opens nested clicks and Enter externally without navigating the iframe', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const component = createRoot(host);
    const html = '<p><a href="https://example.com/unsubscribe?token=test" style="font-size:8px"><span>Se désinscrire</span></a></p>';
    await act(async () => component.render(<EmailHtmlBody html={html} />));
    const frame = host.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = `<div class="ew">${html}</div>`;
    await act(async () => frame.dispatchEvent(new Event('load')));
    const anchor = doc.querySelector('a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com/unsubscribe?token=test');
    expect(anchor.tabIndex).toBe(0);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.querySelector('span')!.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledWith(anchor.href);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    anchor.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledTimes(2);
    await act(async () => component.unmount());
  });
});

describe('EmailHtmlBody regression: forwarded Gmail/Outlook message', () => {
  it('reports slow processing with timing metadata only', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock += 100);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<EmailHtmlBody html="<p>Private message</p>" />));
    const entries = info.mock.calls.filter(([label]) => label === '[MailPerf]');
    expect(entries.length).toBeGreaterThan(0);
    for (const [, metadata] of entries) {
      expect(Object.keys(metadata).sort()).toEqual(['durationMs', 'instance', 'stage']);
      expect(metadata.durationMs).toBeGreaterThanOrEqual(50);
    }
    expect(JSON.stringify(entries)).not.toContain('Private message');
    await act(async () => root.unmount());
  });

  it('reuses sanitized HTML on callback rerenders and sanitizes changed content again', async () => {
    vi.mocked(useMailContentRules).mockReturnValue({ rules: [], save: vi.fn() });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const html = '<p onclick="unsafe()">Bonjour<script>unsafe()</script></p>';
    await act(async () => root.render(<EmailHtmlBody html={html} onReady={() => {}} />));
    expect(parse).toHaveBeenCalledTimes(1);
    const frame = host.querySelector('iframe')!;
    const source = frame.srcdoc;
    expect(source).not.toContain('unsafe()');
    await act(async () => root.render(<EmailHtmlBody html={html} onReady={() => {}} />));
    expect(parse).toHaveBeenCalledTimes(1);
    expect(host.querySelector('iframe')).toBe(frame);
    expect(frame.srcdoc).toBe(source);
    await act(async () => root.render(<EmailHtmlBody html={`${html}<p onmouseover="unsafe()">Suite</p>`} />));
    expect(parse).toHaveBeenCalledTimes(2);
    expect(host.querySelector('iframe')!.srcdoc).toContain('Suite');
    expect(host.querySelector('iframe')!.srcdoc).not.toContain('unsafe()');
    await act(async () => root.unmount());
  });

  it('processes the real-world nesting without removing its visible content', () => {
    const root = document.createElement('div');
    root.innerHTML = forwardedGmailOutlookHtml;

    expect(() => processEmailQuotes(root, {
      label: 'Previous message',
      quoteMarker: '---------- Forwarded message ---------',
    })).not.toThrow();
    expect(root.textContent).toContain('Cordialement');
    expect(root.textContent).toContain('Pour le coup je ne suis pas intéressé');
  });

  it('fits wide signature tables without shrinking the message and recalculates after images load', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const component = createRoot(host);
    await act(async () => component.render(<EmailHtmlBody html="<table width='1400'><tr><td>Wide email</td></tr></table>" />));
    const frame = host.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.body.innerHTML = '<div class="ew"><p style="font-size:12pt">Message text</p><div id="Signature"><table><tr><td><table><tr><td>Wide signature</td></tr></table></td></tr></table></div></div>';
    const content = doc.querySelector<HTMLElement>('.ew')!;
    const table = content.querySelector('table')!;
    const setProperty = vi.spyOn(table.style, 'setProperty');
    const removeProperty = vi.spyOn(table.style, 'removeProperty');
    let contentHeight = 400;
    vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => ({ height: contentHeight, top: 0 } as DOMRect));
    Object.defineProperty(doc.documentElement, 'scrollHeight', { get: () => Number.parseFloat(frame.style.height) || 0 });
    let availableWidth = 480;
    Object.defineProperty(doc.documentElement, 'clientWidth', { get: () => availableWidth });
    Object.defineProperty(table, 'scrollWidth', { get: () => 1400 });

    await act(async () => frame.dispatchEvent(new Event('load')));
    expect(setProperty).toHaveBeenLastCalledWith('zoom', String(480 / 1400), 'important');
    expect(frame.style.visibility).toBe('visible');
    expect(content.style.getPropertyValue('zoom')).toBe('');
    expect(content.querySelector('p')!.style.fontSize).toBe('12pt');
    expect(table.querySelector('table')!.style.getPropertyValue('zoom')).toBe('');

    for (const width of [320, 1024, 1600]) {
      availableWidth = width;
      doc.dispatchEvent(new Event('load'));
      if (width < 1400) {
        expect(setProperty).toHaveBeenLastCalledWith('zoom', String(width / 1400), 'important');
      } else {
        expect(removeProperty).toHaveBeenCalledWith('zoom');
      }
    }
    for (let measurement = 0; measurement < 10; measurement++) {
      doc.dispatchEvent(new Event('load'));
      expect(frame.style.height).toBe('404px');
    }
    contentHeight = 200;
    doc.dispatchEvent(new Event('load'));
    expect(frame.style.height).toBe('204px');
    await act(async () => component.unmount());
  });

  it('does not reset an imperatively measured iframe on a React rerender', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = () => (
      <EmailHtmlBody html={forwardedGmailOutlookHtml} bodyText={forwardedGmailOutlookText} />
    );

    await act(async () => root.render(render()));
    const iframe = host.querySelector('iframe');
    expect(iframe).not.toBeNull();
    iframe!.style.height = '2029px';
    iframe!.style.visibility = 'visible';

    await act(async () => root.render(render()));

    expect(iframe!.style.height).toBe('2029px');
    expect(iframe!.style.visibility).toBe('visible');
    await act(async () => root.unmount());
  });
});

describe('EmailHtmlBody content filtering', () => {
  it.each([false, true])('preserves Outlook paragraph and list spacing with filtering enabled: %s', async filtering => {
    if (filtering) vi.mocked(useMailContentRules).mockReturnValue({ rules: [{ id: '1', text: 'External banner.', enabled: true }], save: vi.fn() });
    const host = document.createElement('div'); document.body.append(host);
    const component = createRoot(host);
    const css = 'p.MsoNormal, li.MsoNormal { margin: 0; }';
    const html = `<html><head><style>${css}</style><script>alert('unsafe')</script></head><body><div>External banner.</div><p class="MsoNormal">Bonjour</p><p class="MsoNormal">&nbsp;</p><ul><li class="MsoNormal">Détail<br>Suite</li></ul></body></html>`;
    await act(async () => component.render(<EmailHtmlBody html={html} />));
    const doc = new DOMParser().parseFromString(host.querySelector('iframe')!.srcdoc, 'text/html');
    expect(Array.from(doc.querySelectorAll('style'), style => style.textContent)).toContain(css);
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelectorAll('p.MsoNormal')).toHaveLength(2);
    expect(doc.querySelector('li.MsoNormal')!.innerHTML).toBe('Détail<br>Suite');
    expect(doc.body.textContent?.includes('External banner.')).toBe(!filtering);
    await act(async () => component.unmount());
  });

  it('reveals and hides the original without modifying the supplied email', async () => {
    vi.mocked(useMailContentRules).mockReturnValue({ rules: [{ id: '1', text: 'ATTENTION: email externe.', enabled: true }], save: vi.fn() });
    const host = document.createElement('div'); document.body.append(host);
    const component = createRoot(host);
    const html = '<div>ATTENTION: email externe.</div><p>Bonjour</p>';
    await act(async () => component.render(<EmailHtmlBody html={html} />));
    expect(host.querySelector('iframe')!.srcdoc).not.toContain('ATTENTION: email externe.');
    expect(host.querySelector('iframe')!.srcdoc).toContain('Bonjour');
    expect(host.querySelector('button')).toBeNull();
    await act(async () => component.render(<EmailHtmlBody html={html} showHiddenContent />));
    expect(host.querySelector('iframe')!.srcdoc).toContain('ATTENTION: email externe.');
    await act(async () => component.render(<EmailHtmlBody html={html} showHiddenContent={false} />));
    expect(host.querySelector('iframe')!.srcdoc).not.toContain('ATTENTION: email externe.');
    expect(html).toContain('ATTENTION: email externe.');
    await act(async () => component.unmount());
  });
  it('filters plain text messages while escaping their HTML characters', async () => {
    vi.mocked(useMailContentRules).mockReturnValue({ rules: [{ id: '1', text: 'External email.', enabled: true }], save: vi.fn() });
    const host = document.createElement('div'); document.body.append(host);
    const component = createRoot(host);
    await act(async () => component.render(<EmailHtmlBody html="" bodyText="External email. Hello <script>" />));
    expect(host.querySelector('iframe')!.srcdoc).toContain('Hello &lt;script&gt;');
    expect(host.querySelector('iframe')!.srcdoc).not.toContain('External email.');
    await act(async () => component.unmount());
  });
});
