import { readFile } from 'node:fs/promises';

/**
 * A PID is reused by the OS, so it is not identity on its own. This reads a
 * provider-process start token that can be compared later, and returns `null`
 * when no such token can be read. Callers must fail closed on `null`.
 */
export async function readProcessStartToken(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return (await readLinuxStartToken(pid)) ?? (await readPsStartToken(pid));
}

async function readLinuxStartToken(pid: number): Promise<string | null> {
  let stat: string;
  let bootId: string;
  try {
    [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
    ]);
  } catch {
    return null;
  }
  const afterName = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
  // Fields after the command name start at 1-based field 3; starttime is field 22.
  const startTime = afterName[19];
  const boot = bootId.trim();
  if (startTime === undefined || boot.length === 0) return null;
  return `linux:${boot}:${startTime}`;
}

async function readPsStartToken(pid: number): Promise<string | null> {
  try {
    const process = Bun.spawn(['ps', '-o', 'lstart=', '-p', String(pid)], {
      stdout: 'pipe', stderr: 'ignore',
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    const value = stdout.trim();
    if (exitCode !== 0 || value.length === 0) return null;
    return `ps:${value}`;
  } catch {
    return null;
  }
}
