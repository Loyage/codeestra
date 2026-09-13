import { useEffect, useId, useRef, useState } from 'react';
import type { RuntimeClient } from './api.js';
import { usePendingAction } from './use-pending-action.js';
import type { TaskView } from './types.js';

/** One row of the constraint editor; `id` is only a React key until the Task is created. */
interface ConstraintDraft {
  readonly id: string;
  readonly text: string;
}

/**
 * The bottom-docked new-task composer.
 *
 * It is `position: sticky; bottom: 0` in normal flow rather than a fixed overlay, so it stays
 * reachable while the page scrolls without covering the content above it — which also means the
 * page needs no compensating bottom padding, and a long expansion can still be scrolled past.
 *
 * The collapsed bar and every field in the expanded panel map to what `codeestra task create`
 * accepts from a script (`--constraint`, `--kind`), so nothing here is reachable only from the UI
 * (PROJECT_SPEC §1.1, ADR-0008). `SELF` stays visible but disabled: the Runtime has no
 * Self-Evolution behaviour yet, so offering it would claim a capability that does not exist.
 */
export function NewTaskDock(props: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
  readonly onCreated: (task: TaskView) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [specification, setSpecification] = useState('');
  const [constraints, setConstraints] = useState<readonly ConstraintDraft[]>([]);
  const actions = usePendingAction(props.run);
  const pending = actions.pending.has('create');
  const panelId = useId();
  const kindHintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Set by an explicit toggle so the first render does not steal focus from the page. */
  const focusAfterToggle = useRef(false);

  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (expanded ? textareaRef.current : inputRef.current)?.focus();
  }, [expanded]);

  const toggle = (next: boolean): void => {
    focusAfterToggle.current = true;
    setExpanded(next);
  };

  const text = specification.trim();
  const canCreate = !pending && text.length > 0;
  const create = (): void => {
    if (!canCreate) return;
    void actions.run('create', '正在创建任务', async () => {
      const created = await props.client.command<TaskView>({
        command: 'task.create',
        commandId: crypto.randomUUID(),
        projectId: props.projectId,
        specification: text,
        // Blank rows are dropped rather than sent: the Runtime rejects a blank constraint text.
        constraints: constraints
          .filter((row) => row.text.trim().length > 0)
          .map((row) => ({ id: row.id, text: row.text.trim() })),
        kind: 'DEVELOPMENT',
      });
      // Clearing and collapsing makes the dock ready for the next task and keeps the newly
      // selected draft visible instead of behind expanded inputs.
      setSpecification('');
      setConstraints([]);
      setExpanded(false);
      await props.onCreated(created);
    });
  };

  if (!expanded) {
    return (
      <section className="new-task-dock" aria-label="新建任务">
        <form
          className="new-task-bar"
          onSubmit={(event) => { event.preventDefault(); create(); }}
        >
          <input
            ref={inputRef}
            type="text"
            aria-label="新任务内容"
            value={specification}
            placeholder="描述一项具体的改动，回车即创建草稿"
            onChange={(event) => setSpecification(event.target.value)}
          />
          <button type="submit" className="primary" disabled={!canCreate}>
            {pending ? '正在创建…' : '＋ 创建草稿'}
          </button>
          <button
            type="button"
            aria-expanded={false}
            onClick={() => toggle(true)}
          >
            展开 ⌃
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="new-task-dock" aria-label="新建任务">
      <form
        className="new-task-detail"
        onSubmit={(event) => { event.preventDefault(); create(); }}
      >
        <div className="section-heading">
          <h3><label htmlFor={panelId}>新建任务 · 详细设定</label></h3>
          <div className="actions">
            <button type="submit" className="primary" disabled={!canCreate}>
              {pending ? '正在创建…' : '＋ 创建草稿'}
            </button>
            <button type="button" aria-expanded onClick={() => toggle(false)}>收起 ⌄</button>
          </div>
        </div>
        <textarea
          id={panelId}
          ref={textareaRef}
          rows={6}
          value={specification}
          placeholder="描述要完成的改动：目标、范围与验收方式"
          onChange={(event) => setSpecification(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              toggle(false);
            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              create();
            }
          }}
        />
        <p className="muted hint">
          ⌘/Ctrl + Enter 创建 · Esc 收起。草稿不会自动启动 Agent，仍需先提交为就绪。
        </p>

        <fieldset className="dock-constraints">
          <legend className="eyebrow">约束</legend>
          {constraints.length === 0 ? (
            <p className="muted hint">
              还没有约束。每一项都是 Agent 必须遵守的具体限制，会作为规格的一部分保存。
            </p>
          ) : null}
          <ul className="dock-constraint-list">
            {constraints.map((row, index) => (
              <li key={row.id}>
                <input
                  type="text"
                  aria-label={`约束 ${index + 1}`}
                  value={row.text}
                  placeholder="例如：不要改动 apps/ui 之外的文件"
                  onChange={(event) => {
                    const next = event.target.value;
                    setConstraints((previous) => previous.map((candidate) => (
                      candidate.id === row.id ? { ...candidate, text: next } : candidate)));
                  }}
                />
                <button
                  type="button"
                  onClick={() => setConstraints((previous) => previous.filter(
                    (candidate) => candidate.id !== row.id))}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setConstraints((previous) => [...previous,
              { id: crypto.randomUUID(), text: '' }])}
          >
            ＋ 添加约束
          </button>
        </fieldset>

        <div className="dock-kind">
          <label className="inline">
            任务类型
            <select value="DEVELOPMENT" aria-describedby={kindHintId}
              onChange={() => {}}>
              <option value="DEVELOPMENT">DEVELOPMENT · 开发任务</option>
              {/* Visible but unselectable: the kind exists in the contract and the database, but
                  nothing in the Runtime treats it differently yet. */}
              <option value="SELF" disabled>SELF · 自演进（未实现）</option>
            </select>
          </label>
          <span className="muted hint" id={kindHintId}>
            SELF 尚未实现：Runtime 没有隔离的 self worktree，也没有 Candidate/Stable 隔离；
            命令行 <code>task create --kind SELF</code> 同样会被拒绝。
          </span>
        </div>
      </form>
    </section>
  );
}
