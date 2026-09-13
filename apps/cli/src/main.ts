import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { maxEventReadLimit, runtimeResponseSchema, runtimeStreamFrameSchema,
  type RepositoryIdentity, type RuntimeRequest, type RuntimeResponse,
  type VerificationPolicyInspection } from '@codeestra/contracts';

/** The subset of `project.list` this client reads. */
interface TrustedProjectListing {
  readonly id: string;
  readonly name: string;
  readonly repoRoot: string;
}

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

/**
 * Follows the Runtime event log. stdout carries one JSON event envelope per line so it stays
 * script-friendly; subscription metadata goes to stderr.
 */
async function tailEvents(command: ClientRequest): Promise<void> {
  await ensureRuntime();
  const requestId = crypto.randomUUID();
  await new Promise<void>((resolveStream) => {
    let buffer = '';
    let finished = false;
    const finish = (code: number, error?: Error): void => {
      if (finished) return;
      finished = true;
      if (error !== undefined) {
        console.error(error.message);
        process.exitCode = code;
      }
      resolveStream();
    };
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ ...command, requestId, schemaVersion: 1 })}\n`);
        },
        data(socket, bytes) {
          const closeQuietly = (): void => { try { socket.end(); } catch { /* already closing */ } };
          buffer += new TextDecoder().decode(bytes);
          for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const frame = runtimeStreamFrameSchema.parse(JSON.parse(line));
              if (frame.type === 'event') console.log(JSON.stringify(frame.event));
              else if (frame.type === 'subscribed') {
                console.error(`Subscribed at cursor ${frame.cursor}`
                  + `${frame.projectId === null ? '' : ` for project ${frame.projectId}`}`);
              } else if (frame.type === 'error') {
                // Report before closing: end() can synchronously run the close handler, which
                // would otherwise finish this process with success.
                finish(1, new Error(`${frame.code}: ${frame.message}`));
                closeQuietly();
                return;
              }
            } catch (error) {
              finish(1, error instanceof Error ? error : new Error(String(error)));
              closeQuietly();
              return;
            }
          }
        },
        error(_socket, error) { finish(1, error); },
        close() { finish(0); },
      },
    }).catch((error: unknown) => {
      finish(1, error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function usage(): never {
  console.error(`Usage:
  bun run codeestra status
  bun run codeestra open [path] [--yes] [--no-open]
  bun run codeestra ui [--no-open]
  bun run codeestra stop
  bun run codeestra project inspect [path]
  bun run codeestra project policy [path]
  bun run codeestra project trust [path] [--yes]
  bun run codeestra project list
  bun run codeestra task create <project-id> <specification>
  bun run codeestra task list <project-id>
  bun run codeestra task submit <project-id> <task-id> <expected-version>
  bun run codeestra task run <project-id> <task-id> <expected-version> [--adapter <id>]
  bun run codeestra task status <project-id> <task-id>
  bun run codeestra task result prepare <project-id> <task-id> [execution-id]
  bun run codeestra task result commit <project-id> <task-id> <authorization-id> --confirm
  bun run codeestra task verify <project-id> <task-id> [execution-id]
  bun run codeestra task verification list <project-id> <task-id>
  bun run codeestra events list [--project <project-id>] [--since <sequence>] [--limit <n>]
  bun run codeestra events tail [--project <project-id>] [--since <sequence>]
  bun run codeestra attention list <project-id>
  bun run codeestra attention answer <project-id> <attention-id> confirm <yes|no>
  bun run codeestra attention answer <project-id> <attention-id> value <text>
  bun run codeestra attention answer <project-id> <attention-id> cancel`);
  process.exit(2);
}

const [group, action, firstArgument, ...remainingArguments] = Bun.argv.slice(2);

/**
 * The address the UI is opened at carries the token and the preselected project in its fragment:
 * fragments are never sent to the server, so neither value reaches a log or a history entry.
 */
function preselectProject(url: string, projectId: string): string {
  const separator = url.includes('#') ? '&' : '#';
  return `${url}${separator}project=${encodeURIComponent(projectId)}`;
}

function launchBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  Bun.spawn([opener, url], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref();
}

function describeVerificationPolicy(policy: VerificationPolicyInspection): void {
  if (policy.state !== 'PRESENT') {
    console.error('No verification policy at the main ref: task verify will refuse until'
      + ` ${'.codeestra/policies/verification.json'} exists at that ref.`);
    return;
  }
  console.error(`Verification policy (main ${policy.mainCommit.slice(0, 12)}`
    + `, digest ${String(policy.digest).slice(0, 12)}):`);
  for (const command of policy.policy?.commands ?? []) {
    console.error(`  ${command.id}: ${command.argv.join(' ')}`
      + ` (cwd ${command.cwd}, timeout ${command.timeoutSeconds}s)`);
  }
  console.error('task verify runs these in an isolated copy of the tested commit, never in your'
    + ' working tree.');
}

try {
  if (group === 'status' && action === undefined) {
    print(await call({ command: 'runtime.ping' }));
  } else if (group === 'ui') {
    // `ui` takes no positional arguments; every remaining token must be the --no-open flag.
    const flags = [action, firstArgument, ...remainingArguments]
      .filter((flag): flag is string => flag !== undefined);
    if (flags.some((flag) => flag !== '--no-open')) usage();
    const endpoint = await call({ command: 'runtime.ui' }) as { url: string };
    console.log(endpoint.url);
    console.error('The token is in the URL fragment: it stays in this terminal and in your browser session.');
    console.error('Closing the browser does not stop the Runtime or any Task.');
    if (!flags.includes('--no-open')) launchBrowser(endpoint.url);
  } else if (group === 'open') {
    // "Work on this repository": one complete, scriptable CLI path that inspects the repository,
    // shows the verification policy that will judge results, takes the same trust confirmation the
    // UI takes, then starts the Web UI with this project preselected. It composes existing
    // commands only, so nothing here is reachable from the UI that is not reachable from the CLI.
    const tokens = [action, firstArgument, ...remainingArguments]
      .filter((token): token is string => token !== undefined);
    const pathTokens = tokens.filter((token) => !token.startsWith('--'));
    const flagTokens = tokens.filter((token) => token.startsWith('--'));
    if (pathTokens.length > 1
      || flagTokens.some((flag) => flag !== '--yes' && flag !== '--no-open')) usage();
    const path = pathTokens[0] ?? process.cwd();

    const identity = await call({ command: 'project.inspect', path }) as RepositoryIdentity;
    console.error(`Repository: ${identity.repoRoot}`);
    console.error(`  main ref: ${identity.mainRef} · ${identity.objectFormat}`);
    console.error(`  HEAD: ${identity.headCommit}`);
    const policy = await call({ command: 'project.verificationPolicy',
      path }) as VerificationPolicyInspection;
    describeVerificationPolicy(policy);

    console.error('\nTrusting allows an Agent, commands, and Git hooks to run with your user'
      + ' permissions.');
    console.error('It does not authorize commits, main updates, pushes, or unknown tools.');
    const confirmed = flagTokens.includes('--yes')
      || prompt('Type TRUST to confirm:') === 'TRUST';
    if (!confirmed) throw new Error('Project trust was not confirmed');
    await call({
      command: 'project.trust',
      path,
      expectedIdentity: identity,
      expectedVerificationPolicy: policy.state === 'PRESENT'
        ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest as string }
        : { state: 'ABSENT', mainCommit: policy.mainCommit },
    });

    const projects = await call({ command: 'project.list' }) as TrustedProjectListing[];
    const project = projects.find((candidate) => candidate.repoRoot === identity.repoRoot);
    if (project === undefined) throw new Error('The trusted project was not listed');
    console.error(`\nTrusted project ${project.id} (${project.name}).`);

    const endpoint = await call({ command: 'runtime.ui' }) as { url: string };
    const url = preselectProject(endpoint.url, project.id);
    console.log(url);
    console.error('The Web UI opens on this project. The token stays in the URL fragment and in'
      + ' your browser session.');
    console.error('Next: create a draft task, submit it, then Run task… and answer the gate'
      + ' prompts. Results land on refs/heads/task/<task-id>; merge them yourself,'
      + ' for example: git merge task/<task-id>');
    if (!flagTokens.includes('--no-open')) launchBrowser(url);
  } else if (group === 'stop' && action === undefined) {
    print(await call({ command: 'runtime.stop' }));
  } else if (group === 'project' && action === 'inspect') {
    print(await call({ command: 'project.inspect', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'list') {
    print(await call({ command: 'project.list' }));
  } else if (group === 'project' && action === 'policy') {
    print(await call({ command: 'project.verificationPolicy', path: firstArgument ?? process.cwd() }));
  } else if (group === 'project' && action === 'trust') {
    const path = firstArgument !== undefined && firstArgument !== '--yes' ? firstArgument : process.cwd();
    const identity = await call({ command: 'project.inspect', path }) as RepositoryIdentity;
    print(identity);
    const policy = await call({ command: 'project.verificationPolicy',
      path }) as VerificationPolicyInspection;
    print(policy);
    console.error('\nTrusting allows an Agent, commands, and Git hooks to run with your user permissions.');
    console.error('It does not authorize commits, main updates, pushes, or unknown tools.');
    if (policy.state === 'PRESENT') {
      console.error('task verify will run these commands in an isolated copy of the tested commit:');
      for (const command of policy.policy?.commands ?? []) {
        console.error(`  ${command.id}: ${command.argv.join(' ')}`
          + ` (cwd ${command.cwd}, timeout ${command.timeoutSeconds}s)`);
      }
    } else {
      console.error('This project has no verification policy; task verify will refuse until one is added.');
    }
    const confirmed = Bun.argv.includes('--yes') || prompt('Type TRUST to confirm:') === 'TRUST';
    if (!confirmed) throw new Error('Project trust was not confirmed');
    print(await call({
      command: 'project.trust',
      path,
      expectedIdentity: identity,
      expectedVerificationPolicy: policy.state === 'PRESENT'
        ? { state: 'PRESENT', mainCommit: policy.mainCommit, digest: policy.digest as string }
        : { state: 'ABSENT', mainCommit: policy.mainCommit },
    }));
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
  } else if (group === 'task' && action === 'verify') {
    const [taskId, executionId, ...extra] = remainingArguments;
    if (firstArgument === undefined || taskId === undefined || extra.length !== 0) usage();
    const report = await call({
      command: 'task.verify',
      commandId: crypto.randomUUID(),
      projectId: firstArgument,
      taskId,
      ...(executionId === undefined ? {} : { executionId }),
    }) as { state: string };
    print(report);
    if (report.state !== 'PASSED') process.exit(1);
  } else if (group === 'task' && action === 'verification') {
    // `task verification <subcommand> …` lands the subcommand in firstArgument.
    const [projectId, taskId, ...extra] = remainingArguments;
    if (firstArgument !== 'list' || projectId === undefined || taskId === undefined
      || extra.length !== 0) usage();
    print(await call({ command: 'task.verification.list', projectId, taskId }));
  } else if (group === 'task' && action === 'result') {
    // `task result <subcommand> …` is a three-level command, so the subcommand lands in
    // firstArgument and the project ID is the first remaining argument.
    const subcommand = firstArgument;
    if (subcommand === 'prepare') {
      const [projectId, taskId, executionId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || extra.length !== 0) usage();
      print(await call({
        command: 'task.result.prepare',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        ...(executionId === undefined ? {} : { executionId }),
      }));
    } else if (subcommand === 'commit') {
      const [projectId, taskId, authorizationId, ...extra] = remainingArguments;
      if (projectId === undefined || taskId === undefined || authorizationId === undefined) usage();
      if (!extra.includes('--confirm') || extra.some((argument) => argument !== '--confirm')) usage();
      print(await call({
        command: 'task.result.commit',
        commandId: crypto.randomUUID(),
        projectId,
        taskId,
        authorizationId,
        confirm: true,
      }));
    } else {
      usage();
    }
  } else if (group === 'events' && (action === 'list' || action === 'tail')) {
    let projectId: string | undefined;
    let sinceSequence: number | undefined;
    let limit: number | undefined;
    const flags = [firstArgument, ...remainingArguments]
      .filter((flag): flag is string => flag !== undefined);
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index];
      const value = flags[index + 1];
      if (flag === '--project' && value !== undefined) {
        projectId = value;
        index += 1;
      } else if (flag === '--since' && value !== undefined) {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) usage();
        sinceSequence = parsed;
        index += 1;
      } else if (flag === '--limit' && value !== undefined && action === 'list') {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maxEventReadLimit) usage();
        limit = parsed;
        index += 1;
      } else {
        usage();
      }
    }
    if (action === 'list') {
      print(await call({
        command: 'events.list',
        ...(projectId === undefined ? {} : { projectId }),
        sinceSequence: sinceSequence ?? 0,
        limit: limit ?? 100,
      }));
    } else {
      await tailEvents({
        command: 'events.subscribe',
        ...(projectId === undefined ? {} : { projectId }),
        ...(sinceSequence === undefined ? {} : { sinceSequence }),
      });
    }
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
