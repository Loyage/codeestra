import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App.js';

/**
 * Contract test for the fixed shell (FOUNDATION-072): the header and the "工作空间" sidebar hold
 * their place, and only the workspace column scrolls.
 *
 * Scope — what this file does and does not prove:
 * - It proves two things only: (1) the rendered element tree puts `header.app-header` and
 *   `aside.sidebar` outside `div.workspace-shell`, and (2) the stylesheet declares a fixed
 *   viewport on `.app` with `.workspace-shell` as the scroll container at every breakpoint.
 * - It does **not** prove how the result looks, how a real browser resolves the cascade and
 *   stacking, narrow-screen wrapping, keyboard focus order, touch/keyboard scrolling, or that a
 *   long task list visually leaves the header in place. No browser, layout engine or DOM
 *   implementation is involved here; those checks are human visual confirmation (ADR-0008).
 */

// ---------------------------------------------------------------------------------------------
// Stylesheet contract
// ---------------------------------------------------------------------------------------------

interface CssRule {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly declarations: readonly (readonly [string, string])[];
}

const stylesheet = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function declarationsOf(body: string): readonly (readonly [string, string])[] {
  return body.split(';').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      return [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()] as const;
    });
}

/** Walks the stylesheet into flat rules, keeping the enclosing `@media` condition of each one. */
function parseCss(source: string): readonly CssRule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const walk = (block: string, media: string | null): void => {
    let depth = 0;
    let cursor = 0;
    let head = '';
    let bodyStart = -1;
    for (let index = 0; index < block.length; index += 1) {
      const character = block[index];
      if (character === '{') {
        if (depth === 0) {
          head = block.slice(cursor, index).trim();
          bodyStart = index + 1;
        }
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0 && bodyStart >= 0) {
          const body = block.slice(bodyStart, index);
          if (head.startsWith('@')) {
            // Nested groups are walked with the condition we can evaluate; `@keyframes` bodies are
            // walked too and simply never match a selector this test looks up.
            const condition = head.startsWith('@media')
              ? head.slice('@media'.length).trim()
              : (media ?? head);
            walk(body, condition);
          } else {
            rules.push({
              media,
              selectors: head.split(',').map((selector) => selector.trim()),
              declarations: declarationsOf(body),
            });
          }
          cursor = index + 1;
          bodyStart = -1;
        }
      }
    }
  };
  walk(withoutComments, null);
  return rules;
}

const rules = parseCss(stylesheet);

function mediaMatches(media: string | null, viewport: number): boolean {
  if (media === null) return true;
  const width = /^\(max-width:\s*(\d+)px\)$/.exec(media);
  // Anything else (`prefers-reduced-motion`, `print`, …) is not a width condition and is ignored:
  // this test reasons about the layout viewport only.
  if (width === null) return false;
  return viewport <= Number(width[1]);
}

/** Every declared value of one property, in cascade order, for a selector at a viewport width. */
function declared(selector: string, property: string, viewport: number): readonly string[] {
  return rules
    .filter((rule) => mediaMatches(rule.media, viewport) && rule.selectors.includes(selector))
    .flatMap((rule) => rule.declarations)
    .filter(([name]) => name === property)
    .map(([, value]) => value);
}

function lastDeclared(selector: string, property: string, viewport: number): string | undefined {
  return declared(selector, property, viewport).at(-1);
}

/** Above 1100px, the 1100px breakpoint, the 850px breakpoint and the 620px breakpoint. */
const viewports = [1440, 1000, 800, 600] as const;

describe('shell stylesheet keeps the viewport fixed and scrolls only the workspace column', () => {
  it('gives .app a fixed viewport height instead of a min-height that grows with the content', () => {
    for (const viewport of viewports) {
      const heights = declared('.app', 'height', viewport);
      // The last declaration wins; the plain `vh` one before it is the pre-`dvh` fallback.
      expect(heights.at(-1)).toBe('100dvh');
      expect(heights).toContain('100vh');
      // `min-height: 100vh` is exactly the regression this task removes: it let the whole page grow.
      expect(declared('.app', 'min-height', viewport)).toEqual([]);
      expect(lastDeclared('.app', 'overflow', viewport)).toBe('hidden');
    }
  });

  it('gives the workspace grid row a zero minimum so a long task list cannot grow the grid', () => {
    for (const viewport of viewports) {
      expect(lastDeclared('.app', 'grid-template-rows', viewport)).toContain('minmax(0');
    }
  });

  it('makes .workspace-shell the scroll container and never the header or the page', () => {
    for (const viewport of viewports) {
      expect(lastDeclared('.workspace-shell', 'overflow', viewport)).toBe('auto');
      expect(declared('.workspace-shell', 'min-height', viewport)).toContain('0');
      // The header declares no scrolling of its own, so it cannot scroll away from the shell.
      expect(lastDeclared('.app-header', 'overflow', viewport)).toBeUndefined();
      // body/html keep their default overflow: the page itself is not the scroll container.
      expect(declared('body', 'overflow', viewport)).toEqual([]);
      expect(declared('html', 'overflow', viewport)).toEqual([]);
    }
  });

  it('gives the sidebar its own place and scrolls only its navigation list', () => {
    for (const viewport of viewports) {
      expect(declared('.sidebar', 'min-height', viewport)).toContain('0');
      expect(lastDeclared('.sidebar', 'overflow', viewport)).toBe('hidden');
    }
    // Desktop and the 1100px breakpoint: a navigation list taller than the sidebar scrolls itself.
    expect(lastDeclared('.sidebar > nav', 'overflow-y', 1440)).toBe('auto');
    expect(lastDeclared('.sidebar > nav', 'overflow-y', 1000)).toBe('auto');
    // Narrow screens keep the same semantics with a horizontal navigation bar.
    expect(lastDeclared('.sidebar > nav', 'overflow-y', 800)).toBe('hidden');
    expect(lastDeclared('.sidebar > nav', 'overflow-x', 800)).toBe('auto');
    expect(lastDeclared('.app-header', 'flex', 800)).toBe('none');
    expect(lastDeclared('.sidebar', 'flex', 800)).toBe('none');
    expect(lastDeclared('.workspace-shell', 'flex', 800)).toContain('1');
  });
});

// ---------------------------------------------------------------------------------------------
// Rendered element tree
// ---------------------------------------------------------------------------------------------

interface DomNode {
  readonly tag: string;
  readonly attrs: string;
  readonly className: string;
  readonly text: string;
  readonly children: DomNode[];
}

const voidTags = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'wbr']);

function tagEnd(html: string, open: number): number {
  let quote = '';
  for (let index = open + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    }
  }
  throw new Error(`unterminated tag at ${open}`);
}

function attributeOf(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match === null ? null : match[1] ?? null;
}

/** Minimal element-tree reader for React's static markup (no DOM implementation available). */
function parseMarkup(html: string): DomNode {
  const root: DomNode = { tag: '#root', attrs: '', className: '', text: '', children: [] };
  const open: DomNode[] = [root];
  const addText = (value: string): void => {
    if (value.length > 0) {
      open.at(-1)?.children.push({ tag: '#text', attrs: '', className: '', text: value, children: [] });
    }
  };
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start < 0) {
      addText(html.slice(index));
      break;
    }
    addText(html.slice(index, start));
    if (html.startsWith('<!--', start)) {
      index = html.indexOf('-->', start) + 3;
      continue;
    }
    const end = tagEnd(html, start);
    const raw = html.slice(start + 1, end);
    if (raw.startsWith('/')) {
      const closed = open.pop();
      if (closed === undefined || closed.tag !== raw.slice(1).trim()) {
        throw new Error(`unbalanced markup at </${raw.slice(1).trim()}>`);
      }
      index = end + 1;
      continue;
    }
    const selfClosing = raw.endsWith('/');
    const body = (selfClosing ? raw.slice(0, -1) : raw).trim();
    const space = body.search(/\s/);
    const tag = (space < 0 ? body : body.slice(0, space)).toLowerCase();
    const attrs = space < 0 ? '' : body.slice(space);
    const node: DomNode = {
      tag, attrs, className: attributeOf(attrs, 'class') ?? '', text: '', children: [],
    };
    open.at(-1)?.children.push(node);
    if (!selfClosing && !voidTags.has(tag)) open.push(node);
    index = end + 1;
  }
  return root;
}

function descendants(node: DomNode): readonly DomNode[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function withClass(root: DomNode, className: string): readonly DomNode[] {
  return descendants(root).filter((node) => node.className.split(/\s+/).includes(className));
}

function parentsOf(root: DomNode, target: DomNode): readonly DomNode[] {
  const chain: DomNode[] = [];
  const walk = (node: DomNode): boolean => {
    for (const child of node.children) {
      if (child === target) return true;
      chain.push(child);
      if (walk(child)) return true;
      chain.pop();
    }
    return false;
  };
  walk(root);
  return chain;
}

function shellMarkup(): string {
  // Console reads `window.location.origin` to build its Runtime client. Nothing in this test drives
  // a request (no effects run under server rendering), so a minimal stub is enough to render the
  // element tree. No browser behaviour is asserted from this stub.
  (globalThis as { window?: unknown }).window ??= { location: { origin: 'http://127.0.0.1:0' } };
  return renderToStaticMarkup(createElement(App, {
    initialToken: 'shell-layout-test-token', initialProjectId: null, tokenKey: 'codeestra.token',
  }));
}

describe('rendered console shell', () => {
  const root = parseMarkup(shellMarkup());
  const app = withClass(root, 'app');

  it('detects a header nested inside the scrolling column (so the guards below cannot pass for the wrong reason)', () => {
    const nested = parseMarkup(
      '<div class="app"><div class="workspace-shell"><header class="app-header">x</header></div></div>',
    );
    const header = withClass(nested, 'app-header')[0] as DomNode;
    const workspace = withClass(nested, 'workspace-shell')[0] as DomNode;
    expect(parentsOf(nested, header).map((node) => node.className)).toEqual(['app', 'workspace-shell']);
    expect(descendants(workspace)).toContain(header);
  });

  it('renders one shell root that is the outermost element', () => {
    expect(app).toHaveLength(1);
    expect(parentsOf(root, app[0] as DomNode)).toEqual([]);
  });

  it('keeps the header and the "工作空间" sidebar outside the scrolling workspace column', () => {
    const header = withClass(root, 'app-header');
    const sidebar = withClass(root, 'sidebar');
    const workspace = withClass(root, 'workspace-shell');
    expect(header).toHaveLength(1);
    expect(sidebar).toHaveLength(1);
    expect(workspace).toHaveLength(1);

    // Direct children of `.app`: the shell owns the viewport, and the scroll container is a sibling.
    for (const child of [header[0], sidebar[0], workspace[0]] as DomNode[]) {
      expect(parentsOf(root, child).map((node) => node.className)).toEqual(['app']);
    }
    // Neither the header nor the sidebar is inside the scroll container.
    expect(withClass(workspace[0] as DomNode, 'app-header')).toEqual([]);
    expect(withClass(workspace[0] as DomNode, 'sidebar')).toEqual([]);
    // The workspace column is where the page heading, the task list and the skip link target live.
    expect(withClass(workspace[0] as DomNode, 'page-heading')).toHaveLength(1);
    const main = descendants(workspace[0] as DomNode)
      .filter((node) => node.tag === 'main' && attributeOf(node.attrs, 'id') === 'workspace');
    expect(main).toHaveLength(1);
  });

  it('still holds the same shell controls after the layout change', () => {
    const header = withClass(root, 'app-header')[0] as DomNode;
    const sidebar = withClass(root, 'sidebar')[0] as DomNode;
    // Header: brand, project picker and refresh stay outside the scrolling column.
    expect(textOf(header)).toContain('Codeestra');
    expect(descendants(header).some((node) => attributeOf(node.attrs, 'aria-label') === '当前项目'))
      .toBe(true);
    expect(textOf(header)).toContain('刷新');
    // Sidebar: the navigation caption (not just a hidden mobile one), the nav landmark, theme and
    // the permission mode line.
    expect(textOf(sidebar)).toContain('工作空间');
    expect(descendants(sidebar).some((node) => node.tag === 'nav'
      && attributeOf(node.attrs, 'aria-label') === '主导航')).toBe(true);
    expect(descendants(sidebar).some((node) => attributeOf(node.attrs, 'aria-label') === '界面主题'))
      .toBe(true);
    expect(textOf(sidebar)).toMatch(/FULL|STRICT/u);
    // The skip link still points at the workspace column.
    const skip = descendants(root).filter((node) => node.className.includes('skip-link'));
    expect(skip).toHaveLength(1);
    expect(attributeOf((skip[0] as DomNode).attrs, 'href')).toBe('#workspace');
  });
});

/** Reads a subtree as text, so the control assertions do not depend on element nesting depth. */
function textOf(node: DomNode): string {
  return node.text + node.children.map((child) => textOf(child)).join('');
}
