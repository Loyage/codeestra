import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { runtimeResponseSchema, type RepositoryIdentity, type RuntimeRequest, type RuntimeResponse } from '@codeestra/contracts';

type ClientRequest = RuntimeRequest extends infer Request
  ? Request extends RuntimeRequest ? Omit<Request, 'requestId' | 'schemaVersion'> : never
  : never;

const home = Bun.env.CODEESTRA_HOME
  ?? join(Bun.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'codeestra');
const socketPath = join(home, 'runtime.sock');
const runtimeEntry = resolve(import.meta.dir, '../../runtime/src/main.ts');

function request(command: ClientRequest): Promise<RuntimeResponse> {
  return new Promise((resolveResponse, reject) => {
    let buffer = '';
    void Bun.connect<{ sent: boolean }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { sent: true };
          socket.write(`${JSON.stringify({ ...command, requestId: crypto.randomUUID(), schemaVersion: 1 })}\n`);
        },
        data(socket, bytes) {
          buffer += new TextDecoder().decode(bytes);
          const newline = buffer.indexOf('\n');
          if (newline !== -1) {
            socket.end();
            try {
              resolveResponse(runtimeResponseSchema.parse(JSON.parse(buffer.slice(0, newline))));
            } catch (error) {
              reject(error);
            }
          }
        },
        error(_socket, error) { reject(error); },
        close() {
          if (!buffer.includes('\n')) reject(new Error('Runtime closed the connection without a response'));
        },
      },
    }).catch(reject);
  });
}

async function ensureRuntime(): Promise<void> {
  try {
    await request({ command: 'runtime.ping' });
    return;
  } catch {
    const child = Bun.spawn([process.execPath, 'run', runtimeEntry], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
      env: { ...Bun.env, CODEESTRA_HOME: home },
    });
    child.unref();
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(50);
    try {
      await request({ command: 'runtime.ping' });
      return;
    } catch { /* Runtime is still starting. */ }
  }
  throw new Error('Runtime did not become ready');
}

async function call(command: ClientRequest): Promise<unknown> {
  await ensureRuntime();
  const response = await request(command);
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function usage(): never {
  console.error(`Usage:
  bun run codeestra status
  bun run codeestra stop
  bun run codeestra project inspect [path]
  bun run codeestra project trust [path] [--yes]
  bun run codeestra project list
  bun run codeestra task create <project-id> <specification>
  bun run codeestra task list <project-id>
  bun run codeestra task submit <project-id> <task-id> <expected-version>
  bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter <id>]
  bun run codeestra task status <project-id> <task-id>
  bun run codeestra attention list <project-id>
  bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
  bun run codeestra attention answer <project-id> <attention-id> value <text>
  bun run codeestra attention answer <project-id> <attention-id> cancel`);
  process.exit(2);
}

const [group, action, firstArgument, ...remainingArguments] = Bun.argv.slice(2);

try {
  if (group === 'status' && action === undefined) {
    print(await call({ command: 'runtime.ping' }));
  } else if (group === 'stop' && action === undefined) {
    print(await call({ command: 'runtime.stop' }));
  } else if (group === 'project' && action === 'inspect') {
    print(await call({ command: 'project.inspect', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'list') {
    print(await call({ command: 'project.list' }));
  } else if (group === 'project' && action === 'trust') {
    const path = firstArgument !== undefined && firstArgument !== '--yes' ? firstArgument : process.cwd();
    const identity = await call({ command: 'project.inspect', path }) as RepositoryIdentity;
    print(identity);
    console.error('\nTrusting allows an Agent, commands, and Git hooks to run with your user permissions.');
    console.error('It does not authorize commits, main updates, pushes, or unknown tools.');
    const confirmed = Bun.argv.includes('--yes') || prompt('Type TRUST to confirm:') === 'TRUST';
    if (!confirmed) throw new Error('Project trust was not confirmed');
    print(await call({ command: 'project.trust', path, expectedIdentity: identity }));
  } else if (group === 'task' && action === 'create') {
    if (firstArgument === undefined || remainingArguments.length === 0) usage();
    print(await call({
      command: 'task.create',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      specification: remainingArguments.join(' '),
      constraints: [],
      kind: 'DEVELOPMENT',
    }));
  } else if (group === 'task' && action === 'list') {
    if (firstArgument === undefined || remainingArguments.length !== 0) usage();
    print(await call({ command: 'task.list', projectId: firstArgument }));
  } else if (group === 'task' && action === 'status') {
    const [taskId, ...extra] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined || extra.length !== 0) usage();
    print(await call({ command: 'task.status', projectId: firstArgument, taskId }));
  } else if (group === 'task' && action === 'run') {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedTaskVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || !Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 0) usage();
    let adapterId = 'pi';
    const argumentsWithoutAdapter: string[] = [];
    for (let index = 0; index < extra.length; index += 1) {
      const argument = extra[index];
      if (argument === '--adapter') {
        const value = extra[index + 1];
        if (value === undefined) usage();
        adapterId = value;
        index += 1;
      } else {
        argumentsWithoutAdapter.push(argument as string);
      }
    }
    if (argumentsWithoutAdapter.length !== 0) usage();
    print(await call({
      command: 'task.run',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedTaskVersion,
      adapterId,
    }));
  } else if (group === 'attention' && action === 'list') {
    if (firstArgument === undefined || remainingArguments.length !== 0) usage();
    print(await call({ command: 'attention.list', projectId: firstArgument }));
  } else if (group === 'attention' && action === 'answer') {
    const [attentionId, answerType, ...answerArguments] = remainingArguments;
    if (firstArgument === undefined || attentionId === undefined || answerType === undefined) usage();
    let answer: { type: 'CONFIRM'; confirmed: boolean } | { type: 'VALUE'; value: string }
      | { type: 'CANCEL' };
    if (answerType === 'confirm' && answerArguments.length === 1
      && ['yes', 'no'].includes(answerArguments[0] ?? '')) {
      answer = { type: 'CONFIRM', confirmed: answerArguments[0] === 'yes' };
    } else if (answerType === 'value' && answerArguments.length > 0) {
      answer = { type: 'VALUE', value: answerArguments.join(' ') };
    } else if (answerType === 'cancel' && answerArguments.length === 0) {
      answer = { type: 'CANCEL' };
    } else {
      usage();
    }
    print(await call({
      command: 'attention.answer',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      attentionId,
      answer,
    }));
  } else if (group === 'task' && action === 'submit') {
    const [taskId, versionText, ...extra] = remainingArguments;
    const expectedVersion = Number(versionText);
    if (firstArgument === undefined || taskId === undefined || versionText === undefined
      || extra.length !== 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) usage();
    print(await call({
      command: 'task.submit',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      expectedVersion,
    }));
  } else {
    usage();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
