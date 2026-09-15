/**
 * The single source of truth for the UI channel (ADR-0049), shared by the Vite build and the app.
 *
 * The channel is a fact of the build, never a runtime guess: the only source is
 * `VITE_CODEESTRA_CHANNEL`, and only the exact value `dev` (case-sensitive) selects the dev
 * channel. A build that does not set the variable is the stable channel and renders no marker,
 * writes no `data-*` attribute and keeps the plain title — so a dev marker cannot leak into the
 * stable build by being committed to a branch.
 *
 * Consequence, deliberately chosen: building in the dev clone with `bun run build:ui` (rather than
 * `bun run build:ui:dev`) produces an unmarked interface. Missing a marker is the safe direction;
 * a stable interface carrying the dev marker is not.
 */

export const channelEnvironmentVariable = 'VITE_CODEESTRA_CHANNEL';

export type UiChannel = 'stable' | 'dev';

export function readUiChannel(value: string | undefined): UiChannel {
  return value === 'dev' ? 'dev' : 'stable';
}

/**
 * The dev marking of the served HTML: the channel attribute and the title suffix. The stable
 * channel returns the document unchanged, so `index.html` is only ever touched by a dev build.
 */
export function markChannelHtml(html: string, channel: UiChannel): string {
  if (channel !== 'dev') return html;
  return html
    .replace('<html lang="zh-CN">', '<html lang="zh-CN" data-channel="dev">')
    .replace('<title>Codeestra</title>', '<title>Codeestra DEV</title>');
}
