import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChannelBanner, channelBrandName } from '../src/channel.js';
import { markChannelHtml, readUiChannel } from '../channel-value.js';

/**
 * Contract test for the dev channel marker (ADR-0049).
 *
 * Scope — what this file does and does not prove:
 * - It proves (1) the channel is decided by the exact build-time value `dev` and nothing else,
 *   (2) the marker element is rendered in the dev channel and is absent in the stable one, and
 *   (3) the stylesheet declares the banner and the dev accent overrides, and keeps `.app`'s fixed
 *   grid rows (the FOUNDATION-072 shell) with a zero-height first row.
 * - It does **not** prove how the result looks, dark-theme contrast, narrow-screen wrapping or how
 *   recognizable the marker is next to the stable interface. Those are human visual confirmation
 *   (ADR-0008: no computer-use, no browser automation).
 */

const stylesheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function declarationsFor(selector: string): readonly (readonly [string, string])[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[{}]|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(stylesheet);
  if (rule === null) return [];
  return (rule[1] ?? '').split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()] as const;
    });
}

function markupOf(channel: 'stable' | 'dev'): string {
  return renderToStaticMarkup(createElement(ChannelBanner, { channel }));
}

describe('the channel is a build-time fact, decided by one exact value', () => {
  it('selects the dev channel only for the exact value `dev`', () => {
    expect(readUiChannel('dev')).toBe('dev');
  });

  it('treats an unset, empty, differently-cased or unknown value as stable', () => {
    for (const value of [undefined, '', 'DEV', 'Dev', 'dev ', 'dev\n', 'production', 'stable']) {
      expect(readUiChannel(value)).toBe('stable');
    }
  });

  it('names the brand after the channel without changing the stable name', () => {
    expect(channelBrandName('stable')).toBe('Codeestra');
    expect(channelBrandName('dev')).toBe('Codeestra DEV');
  });

  it('marks the served HTML only for the dev channel', () => {
    const dev = markChannelHtml(indexHtml, 'dev');
    expect(dev).toContain('<html lang="zh-CN" data-channel="dev">');
    expect(dev).toContain('<title>Codeestra DEV</title>');
    // Only those two spots change: the rest of the document is the tracked file verbatim.
    expect(dev.replace(' data-channel="dev"', '').replace('Codeestra DEV', 'Codeestra'))
      .toBe(indexHtml);
  });

  it('leaves the served HTML untouched for the stable channel', () => {
    expect(markChannelHtml(indexHtml, 'stable')).toBe(indexHtml);
  });
});

describe('the marker is rendered only in the dev channel', () => {
  it('renders a full-width notice with its own role in the dev build', () => {
    const markup = markupOf('dev');
    expect(markup).toContain('dev-banner');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('开发版 DEV');
    expect(markup).toContain('非稳定代码');
  });

  it('renders nothing at all in the stable build', () => {
    expect(markupOf('stable')).toBe('');
  });
});

describe('the stylesheet carries the marker and keeps the fixed shell', () => {
  it('declares the banner as the first grid row of the shell', () => {
    const banner = declarationsFor('.dev-banner');
    expect(banner.find(([name]) => name === 'grid-column')?.[1]).toBe('1 / -1');
    expect(banner.find(([name]) => name === 'grid-row')?.[1]).toBe('1');
    expect(banner.find(([name]) => name === 'background')?.[1]).not.toBeUndefined();
  });

  it('keeps .app a fixed viewport whose scroll row is the workspace, with row 1 free for the banner', () => {
    const rows = declarationsFor('.app').filter(([name]) => name === 'grid-template-rows').at(-1)?.[1];
    expect(rows).toContain('minmax(0');
    // Row 1 is the banner row: zero height when no banner element is rendered.
    expect(rows?.startsWith('auto')).toBe(true);
    expect(declarationsFor('.app').filter(([name]) => name === 'overflow').at(-1)?.[1]).toBe('hidden');
    // The header is pinned to row 2 and the scroll container to row 3, so the banner cannot end up
    // inside the scrolling column.
    expect(declarationsFor('.app-header').find(([name]) => name === 'grid-row')?.[1]).toBe('2');
    expect(declarationsFor('.workspace-shell').find(([name]) => name === 'grid-row')?.[1]).toBe('3');
  });

  it('applies the channel attribute to the document root before the bundle runs', () => {
    // The Vite build writes the attribute into dist/index.html (ADR-0049). The accent override
    // below is selected by that attribute, so it must be reachable without JavaScript.
    expect(markChannelHtml(indexHtml, 'dev')).toContain('data-channel="dev"');
  });

  it('overrides the accent pair for the dev channel in both themes', () => {
    const light = declarationsFor(':root[data-channel="dev"]');
    const dark = declarationsFor(':root[data-theme="dark"][data-channel="dev"]');
    expect(light.find(([name]) => name === '--accent')?.[1]).not.toBeUndefined();
    expect(light.find(([name]) => name === '--accent-soft')?.[1]).not.toBeUndefined();
    expect(dark.find(([name]) => name === '--accent')?.[1]).not.toBeUndefined();
    expect(dark.find(([name]) => name === '--accent-soft')?.[1]).not.toBeUndefined();
    // Only the accent pair is re-coloured: the semantic tones keep their meaning.
    expect(light.find(([name]) => name === '--danger')).toBeUndefined();
    expect(light.find(([name]) => name === '--warn')).toBeUndefined();
    expect(light.find(([name]) => name === '--ok')).toBeUndefined();
  });
});
