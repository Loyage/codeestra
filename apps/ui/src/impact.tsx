import { useCallback, useEffect, useState } from 'react';
import { describeError, RuntimeClient } from './api.js';
import { HitList, taskTag } from './schedule.js';
import {
  impactConfirmationStateLabel,
  impactDispositionLabel,
  impactIncompleteReasonLabel,
  impactPolicyStateLabel,
  impactValidationCodeLabel,
  verdictLabel,
  verdictStateClass,
  waitReasonLabel,
} from './scheduling-labels.js';
import type {
  ImpactAssessmentReportView,
  ImpactPolicyReportView,
  ImpactPolicyValidationView,
  ImpactSnapshotView,
  ImpactTaskSnapshotView,
  TaskView,
} from './types.js';

/**
 * Deterministic conflict analysis (FOUNDATION-053 / ADR-0031), as read-only projections of
 * `project impact validate|show|explain`.
 *
 * The UI never computes an overlap and never reinterprets a verdict: `complete: false` is shown as
 * such, every reason code is printed with its stable name, and `UNKNOWN` is rendered as "cannot be
 * proven" — never as "no conflict".
 */

function shortId(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/** The mapping report behind every verdict; a mapping that is not confirmed makes everything UNKNOWN. */
function PolicySummary({ policy }: { readonly policy: ImpactPolicyReportView }) {
  return (
    <dl className="kv">
      <dt>映射状态</dt>
      <dd>
        {impactPolicyStateLabel(policy.state)}
        {' · '}确认：{impactConfirmationStateLabel(policy.confirmationState)}
        {' · '}{policy.confirmed ? '正在生效' : '不生效：所有判定都会是 UNKNOWN'}
      </dd>
      <dt>main 引用</dt>
      <dd className="mono">{policy.mainRef} @ {shortId(policy.mainCommit)}</dd>
      <dt>摘要</dt>
      <dd className="mono">策略 {shortId(policy.digest)} · 内容 {shortId(policy.contentDigest)}</dd>
      <dt>声明数量</dt>
      <dd>重要目录 {policy.importantDirectories} · 模块 {policy.modules} · 全局资源 {policy.globalResources}</dd>
      {policy.state === 'INVALID' ? (
        <>
          <dt>错误</dt>
          <dd className="error">{policy.errorCode ?? '—'}
            {policy.errorMessage === null ? null : <div className="hint">{policy.errorMessage}</div>}</dd>
        </>
      ) : null}
    </dl>
  );
}

/** One recorded ImpactSnapshot: what the analyzer observed, verbatim. */
function SnapshotDetails({ snapshot }: { readonly snapshot: ImpactSnapshotView }) {
  return (
    <>
      <p className="muted hint">
        快照 <span className="mono">{shortId(snapshot.id)}</span> ·
        {' '}分析器 <span className="mono">{snapshot.analyzerVersion}</span> ·
        {' '}映射 <span className="mono">{snapshot.policyVersion}</span> ·
        {' '}路径大小写 {snapshot.caseMode} ·
        {' '}{new Date(snapshot.createdAt).toLocaleString('zh-CN')}
      </p>
      <p>
        完整性：
        {snapshot.complete
          ? <span className="state state-ready">完整（可参与 SAFE）</span>
          : <span className="state state-unknown">不完整（complete=false，不可能是 SAFE）</span>}
      </p>
      {snapshot.incompleteReasons.length === 0 ? null : (
        <ul className="list">
          {snapshot.incompleteReasons.map((code) => (
            <li key={code} className="muted"><span className="mono">{code}</span> {impactIncompleteReasonLabel(code)}</li>
          ))}
        </ul>
      )}
      <dl className="kv">
        <dt>变更指纹</dt><dd className="mono">{snapshot.changeFingerprint}</dd>
        <dt>changed 路径</dt>
        <dd>
          {snapshot.files.length === 0 ? '无' : (
            <details>
              <summary>{snapshot.files.length} 个路径</summary>
              <div className="mono hint">{snapshot.files.join('\n')}</div>
            </details>
          )}
        </dd>
        <dt>命中重要目录</dt>
        <dd className="mono">{snapshot.importantDirectories.length === 0 ? '未命中'
          : snapshot.importantDirectories.join('、')}</dd>
        <dt>命中模块</dt>
        <dd className="mono">{snapshot.modules.length === 0 ? '未命中' : snapshot.modules.join('、')}</dd>
        <dt>全局资源</dt>
        <dd>
          {snapshot.globalResources.length === 0 ? '未命中' : (
            <ul className="list">
              {snapshot.globalResources.map((resource) => (
                <li key={resource.id} className="muted">
                  <span className="mono">{resource.id}</span>（{resource.kind}）
                  {resource.written ? ' · 本 revision 改动' : ''}
                  {resource.read ? ' · 本 revision 依赖它' : ''}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>映射未分类的路径</dt>
        <dd>
          {snapshot.unclassifiedFiles.length === 0 ? '无'
            : `${snapshot.unclassifiedFiles.length} 个（报告，不当作「无影响」）`}
        </dd>
      </dl>
      {snapshot.evidence.length === 0 ? null : (
        <details><summary className="muted">证据（{snapshot.evidence.length} 行）</summary>
          <ul className="list">
            {snapshot.evidence.map((line, index) => (
              <li key={`${String(index)}-${line.slice(0, 20)}`} className="muted hint">{line}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** One Task's impact snapshot as `project impact show` reports it, including the unavailable case. */
function ImpactSubject({ view }: { readonly view: ImpactTaskSnapshotView }) {
  return (
    <>
      <div className="row-head">
        <span className="muted">任务状态 {view.taskState}</span>
        <span className="state">{impactDispositionLabel(view.disposition)}</span>
        <span className="muted mono">revision {shortId(view.revisionId)}</span>
      </div>
      {view.dispositionDetail === null ? null : <p className="muted hint">{view.dispositionDetail}</p>}
      <p className="muted hint">
        工作区基线 <span className="mono">{shortId(view.baseline.workspaceBaseCommit)}</span> ·
        {' '}项目 dev <span className="mono">{shortId(view.baseline.projectDevCommit)}</span> ·
        {view.baseline.matchesProjectDev
          ? ' 与 dev 一致'
          : ' 与 dev 不一致：在另一个基线之上的任务与它的对比是 UNKNOWN'}
      </p>
      <p className="muted hint">路径大小写实测 {view.caseMode}（{view.caseModeSource}）：{view.caseModeDetail}</p>
      {view.snapshot === null ? (
        <p className="error">
          无法派生快照：{view.unavailableDetail ?? 'Runtime 没有给出原因'}
          {' '}——没有快照就意味着无法排除与它的重叠，相关判定只能是 UNKNOWN。
        </p>
      ) : <SnapshotDetails snapshot={view.snapshot} />}
    </>
  );
}

/** `project impact validate`: is the mapping present and actually in effect? */
export function ImpactPolicyPanel({ client, projectId, repoRoot, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly repoRoot: string;
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [view, setView] = useState<ImpactPolicyValidationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<ImpactPolicyValidationView>({
        command: 'project.impact.validate', path: repoRoot,
      });
      setView(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, repoRoot]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  return (
    <section className="impact-policy-panel">
      <h4>影响映射 · impact.json <span className="muted hint">project impact validate · ADR-0031</span></h4>
      <p className="muted hint">
        映射只从项目 main 引用读取，Task 分支上的同名文件不参与判定。映射缺失、无效或未确认时，
        <strong>每一个判定都会是 UNKNOWN</strong>（不是「无冲突」）。
      </p>
      {error === null ? null : <p className="error" role="alert">影响映射校验失败：{error}</p>}
      <div className="actions">
        <button type="button" onClick={() => { void run('正在校验影响映射', load); }}>重新校验</button>
        <span className="muted mono">{repoRoot}</span>
      </div>
      {view === null ? <p className="muted" role="status">正在校验影响映射…</p> : (
        <>
          <p>
            <span className={view.code === 'OK' || view.code === 'OK_UNTRUSTED'
              ? 'state state-ready' : 'state state-unknown'}>
              {view.code}
            </span>
            {' '}<span className="muted">{impactValidationCodeLabel(view.code)}</span>
          </p>
          <p className="muted hint">
            main <span className="mono">{view.mainRef} @ {shortId(view.mainCommit)}</span> ·
            {' '}分析器 <span className="mono">{view.analyzerVersion}</span> ·
            {' '}{view.trusted === null ? '此仓库尚未被信任'
              : `已信任为 ${view.trusted.name}`}
          </p>
          <PolicySummary policy={view.policy} />
          {view.warnings.length === 0 ? null : (
            <ul className="list">
              {view.warnings.map((warning, index) => (
                <li key={`${String(index)}-${warning.slice(0, 24)}`} className="muted hint">{warning}</li>
              ))}
            </ul>
          )}
          <p className="muted hint">项目 {shortId(projectId)}</p>
        </>
      )}
    </section>
  );
}

/** `project impact show` + `explain` for one Task: the snapshot and the verdict with its hits. */
export function ImpactTaskPanel({ client, projectId, taskId, tasks, refreshToken, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string;
  readonly taskId: string;
  readonly tasks: readonly TaskView[];
  readonly refreshToken: number;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [snapshotView, setSnapshotView] = useState<ImpactTaskSnapshotView | null>(null);
  const [explain, setExplain] = useState<ImpactAssessmentReportView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await client.command<ImpactTaskSnapshotView>({
        command: 'project.impact.show', projectId, taskId,
      });
      setSnapshotView(next);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [client, projectId, taskId]);

  useEffect(() => {
    setExplain(null);
    void load();
  }, [load, refreshToken]);

  const assessment = explain?.assessment ?? null;

  return (
    <section className="impact-task-panel">
      <h4>影响与冲突判定 <span className="muted hint">project impact show / explain · 只读</span></h4>
      {error === null ? null : <p className="error" role="alert">影响投影读取失败：{error}</p>}
      <div className="actions">
        <button type="button" onClick={() => { void run('正在刷新影响快照', load); }}>刷新快照</button>
        <button type="button" onClick={() => {
          void run('正在解释冲突判定', async () => {
            try {
              setExplain(await client.command<ImpactAssessmentReportView>({
                command: 'project.impact.explain', projectId, taskId,
              }));
            } catch (caught) {
              setError(describeError(caught));
            }
          });
        }}>解释判定（explain）</button>
      </div>

      {snapshotView === null ? <p className="muted" role="status">正在读取影响快照…</p> : (
        <>
          <h5 className="eyebrow">候选快照</h5>
          <ImpactSubject view={snapshotView} />
          <details><summary className="muted">映射状态</summary>
            <PolicySummary policy={snapshotView.policy} />
          </details>
        </>
      )}

      {explain === null || assessment === null ? null : (
        <>
          <h5 className="eyebrow">判定</h5>
          <div className="row-head">
            <span className={verdictStateClass(assessment.verdict)}>{verdictLabel(assessment.verdict)}</span>
            <span className="muted hint">
              对比了 {assessment.comparedTaskIds.length} 个活跃/预留任务 ·
              候选快照 {assessment.candidateComplete ? '完整' : '不完整（complete=false）'}
            </span>
          </div>
          {assessment.candidateIncompleteReasons.length === 0 ? null : (
            <ul className="list">
              {assessment.candidateIncompleteReasons.map((code) => (
                <li key={code} className="muted"><span className="mono">{code}</span> {impactIncompleteReasonLabel(code)}</li>
              ))}
            </ul>
          )}
          {assessment.reasonCodes.length === 0 ? null : (
            <ul className="list">
              {assessment.reasonCodes.map((code) => (
                <li key={code} className="muted">
                  <span className="mono">{code}</span> {waitReasonLabel(code)}
                </li>
              ))}
            </ul>
          )}
          <HitList hits={assessment.hits} tasks={tasks} />

          <h5 className="eyebrow">逐活跃任务</h5>
          {explain.active.length === 0 ? <p className="muted">没有活跃/预留任务可对比。</p> : (
            <div className="table-scroll"><table>
              <thead>
                <tr><th>任务</th><th>状态</th><th>执行</th><th>快照</th><th>不完整原因</th><th>记录</th></tr>
              </thead>
              <tbody>
                {explain.active.map((peer) => (
                  <tr key={peer.taskId}>
                    <td>{taskTag(peer.taskId, tasks)}
                      <div className="muted hint mono">revision {shortId(peer.revisionId)}</div></td>
                    <td>{peer.taskState}</td>
                    <td>{peer.executionState}</td>
                    <td>{peer.complete ? <span className="state state-ready">完整</span>
                      : <span className="state state-unknown">不完整</span>}
                      <div className="muted hint">{impactDispositionLabel(peer.disposition)}</div></td>
                    <td className="hint">{peer.incompleteReasons.length === 0 ? '—'
                      : peer.incompleteReasons.map((code) => impactIncompleteReasonLabel(code)).join('；')}</td>
                    <td className="mono">{peer.changeFingerprint === null ? '—'
                      : shortId(peer.changeFingerprint)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}

          {explain.recordedAssessments.length === 0 ? null : (
            <details>
              <summary className="muted">
                已落库的逐配对判定（append-only，{explain.recordedAssessments.length} 条）
              </summary>
              <ul className="list">
                {explain.recordedAssessments.map((record) => (
                  <li key={record.otherTaskId} className="muted">
                    {taskTag(record.otherTaskId, tasks)} · {verdictLabel(record.verdict)} ·
                    reason <span className="mono">{record.reasonCodes.join('、') || '—'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {explain.explanation.length === 0 ? null : (
            <details>
              <summary className="muted">判定解释（{explain.explanation.length} 行，Runtime 原文）</summary>
              <ul className="list">
                {explain.explanation.map((line, index) => (
                  <li key={`${String(index)}-${line.slice(0, 24)}`} className="muted hint">{line}</li>
                ))}
              </ul>
            </details>
          )}

          {assessment.evidence.length === 0 ? null : (
            <details>
              <summary className="muted">判定证据（{assessment.evidence.length} 行）</summary>
              <ul className="list">
                {assessment.evidence.map((line, index) => (
                  <li key={`${String(index)}-${line.slice(0, 20)}`} className="muted hint">{line}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
