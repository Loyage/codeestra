import { homedir } from 'node:os';
import { join } from 'node:path';

export function runtimeHome(environment: Readonly<Record<string, string | undefined>> = Bun.env): string {
  return environment.CODEESTRA_HOME
    ?? join(environment.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codeestra');
}

export function runtimeSocketPath(home = runtimeHome()): string {
  return join(home, 'runtime.sock');
}
