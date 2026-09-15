/**
 * The dev channel marker (ADR-0049).
 *
 * The channel itself is decided by `channel-value.ts` and marked into the served HTML by the Vite
 * build, so this module only carries the project-local facts: the variable to read at build time,
 * the brand name and the banner element. The banner is a notice, not a control — it exposes no
 * action, hides no function and carries no command-face semantics.
 */

import { channelEnvironmentVariable, readUiChannel, type UiChannel } from '../channel-value.js';

export const uiChannel: UiChannel = readUiChannel(import.meta.env[channelEnvironmentVariable]);

export function channelBrandName(channel: UiChannel): string {
  return channel === 'dev' ? 'Codeestra DEV' : 'Codeestra';
}

export function ChannelBanner({ channel }: { readonly channel: UiChannel }) {
  if (channel !== 'dev') return null;
  return (
    <p className="dev-banner" role="status">
      <strong>开发版 DEV</strong>
      <span>非稳定代码：这是 dev clone 的运行结果，不要当作稳定版；改动请与稳定界面自行对照。</span>
    </p>
  );
}
