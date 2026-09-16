import { useEffect, useId, useRef, useState } from 'react';
import type { RuntimeClient } from './api.js';
import { usePendingAction } from './use-pending-action.js';
import type { TaskView } from './types.js';

/**
 * The Task input bounds, mirrored from `@codeestra/contracts` (ADR-0065 D01).
 *
 * Like the other wire literals in this app, they are copied rather than imported: this client owns no
 * dependency on the server packages, and the Runtime remains the authority — these values only drive
 * `maxLength` and the button's disabled state so a user is not asked to submit something the Runtime
 * will refuse. `packages/contracts/test/request.test.ts` owns the authoritative shape.
 */
const maxDisplayTitleChars = 200;
const maxNamingTitleChars = 50;
const namingTitlePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * The bottom-docked new-task composer.
 *
 * It is `position: sticky; bottom: 0` in normal flow rather than a fixed overlay, so it stays
 * reachable while the page scrolls without covering the content above it — which also means the
 * page needs no compensating bottom padding.
 *
 * Three fields are required (ADR-0065): the display title the task list shows, the naming title the
 * branch and worktree directory are named after, and the Task detail the Agent works from. Because
 * none of them can be derived from the others, the dock no longer has a collapsed single-line form:
 * a one-line composer could not produce a valid `task create` command. Every field maps to a
 * `codeestra task create` flag (`--title`, `--name`, positional detail), so nothing here is
 * reachable only from the UI (PROJECT_SPEC §1.1, ADR-0008).
 */
export function NewTaskDock(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
  readonly onCreated: (task: TaskView) => Promise<void>;
}) {
  const [displayTitle, setDisplayTitle] = useState('');
  const [namingTitle, setNamingTitle] = useState('');
  const [specification, setSpecification] = useState('');
  const actions = usePendingAction(props.run);
  const pending = actions.pending.has('create');
  const panelId = useId();
  const namingHintId = useId();
  const titleRef = useRef<HTMLInputElement>(null);

  // Focus the first field once when the dock appears, so a user who just switched projects can start
  // typing. It is not refocused on every render: that would fight the caret while editing.
  const focusedOnMount = useRef(false);
  useEffect(() => {
    if (focusedOnMount.current) return;
    focusedOnMount.current = true;
    titleRef.current?.focus();
  }, []);

  const title = displayTitle.trim();
  const name = namingTitle.trim();
  // The same shape the Runtime accepts, checked here so the button's disabled state and the refusal
  // agree. The Runtime stays authoritative; this only avoids a pointless round trip.
  const nameValid = name.length > 0 && name.length <= maxNamingTitleChars
    && namingTitlePattern.test(name);
  const detail = specification.trim();
  const canCreate = !pending && title.length > 0 && nameValid && detail.length > 0;
  const create = (): void => {
    if (!canCreate) return;
    void actions.run('create', '正在创建任务', async () => {
      const created = await props.client.command<TaskView>({
        command: 'task.create',
        commandId: crypto.randomUUID(),
        projectId: props.projectId,
        displayTitle: title,
        namingTitle: name,
        specification: detail,
      });
      // Clearing keeps the dock ready for the next task.
      setDisplayTitle('');
      setNamingTitle('');
      setSpecification('');
      await props.onCreated(created);
    });
  };

  return (
    <section className="new-task-dock" aria-label="新建任务">
      <form
        className="new-task-detail"
        onSubmit={(event) => { event.preventDefault(); create(); }}
      >
        <div className="section-heading">
          <h3>新建任务</h3>
          <div className="actions">
            <button type="submit" className="primary" disabled={!canCreate}>
              {pending ? '正在创建…' : '＋ 创建草稿'}
            </button>
          </div>
        </div>

        <label htmlFor={`${panelId}-title`}>
          显示标题<span className="muted hint">（任务列表显示的一句话摘要，必填）</span>
        </label>
        <input
          id={`${panelId}-title`}
          ref={titleRef}
          type="text"
          aria-label="显示标题"
          maxLength={maxDisplayTitleChars}
          value={displayTitle}
          placeholder="例如：给 parser 补一个 CRLF 输入用例"
          onChange={(event) => setDisplayTitle(event.target.value)}
        />

        <label htmlFor={`${panelId}-name`}>
          命名标题<span className="muted hint">（分支与 worktree 目录名，必填）</span>
        </label>
        <input
          id={`${panelId}-name`}
          type="text"
          aria-label="命名标题"
          aria-describedby={namingHintId}
          maxLength={maxNamingTitleChars}
          value={namingTitle}
          placeholder="例如：parser-crlf-case"
          onChange={(event) => setNamingTitle(event.target.value)}
        />
        <p className="muted hint" id={namingHintId}>
          小写英文短横线 slug（<code>^[a-z][a-z0-9]*(-[a-z0-9]+)*$</code>），不能有空格；
          分支为 <code>task/&lt;编号&gt;-&lt;命名标题&gt;</code>，worktree 目录同此名。
        </p>

        <label htmlFor={`${panelId}-detail`}>
          任务详情<span className="muted hint">（Agent 实际依据的正文，必填）</span>
        </label>
        <textarea
          id={`${panelId}-detail`}
          rows={6}
          value={specification}
          placeholder="描述要完成的改动：目标、范围与验收方式"
          onChange={(event) => setSpecification(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              create();
            }
          }}
        />
        <p className="muted hint">
          ⌘/Ctrl + Enter 创建。草稿不会自动启动 Agent，仍需先提交为就绪。
        </p>
      </form>
    </section>
  );
}
