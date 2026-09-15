/**
 * Agent 设置页：模型 / 思考深度 / 插件选择（FOUNDATION-071 / ADR-0044）。
 *
 * 这一页只是同一 Runtime 命令面的便利前端（ADR-0008）：它读 `agent.config.get`、
 * `agent.plugins.list`，写 `agent.config.set`，不新增加载语义、不发确认、不做本地校验代替
 * Runtime 的判断。Runtime 拒绝什么，这一页就显示什么。
 *
 * 页面必须如实说清两件事：
 * 1. 这些值只对**新建 Session** 生效，并把生效的插件列表与来源层写进 Execution 记录；
 * 2. Pi 的 fail-closed 审批门禁靠 `--no-extensions` 保证「唯一被加载的 extension 是 Codeestra
 *    自己的」。用户显式勾选的第三方 extension 可能影响或绕过该审批——本轮不新增审批层、
 *    也不做运行期越权拦截（用户已拍板），只在页面、ADR 与 Execution 留痕三处如实记录。
 */
import { useCallback, useEffect, useState } from 'react';
import { RuntimeClient, describeError } from './api.js';
import { usePendingAction } from './use-pending-action.js';

const pluginKinds = ['extensions', 'skills', 'promptTemplates', 'themes'] as const;
type PluginKind = (typeof pluginKinds)[number];

const kindLabels: Record<PluginKind, string> = {
  extensions: '扩展（extensions）',
  skills: '技能（skills）',
  promptTemplates: '提示词模板（prompt templates）',
  themes: '主题（themes）',
};

/** 服务端稳定 reason code 的中文说明；未知 code 原样显示，不猜含义。 */
const reasonLabels: Record<string, string> = {
  NOT_FOUND: '路径不存在',
  NOT_READABLE: '无法读取',
  UNSUPPORTED_FILE_TYPE: '不是该类可加载的文件类型',
  SYMLINK_OUTSIDE_PROVIDER_DIRECTORY: '符号链接指向仓库工作树，只读检测不扫描仓库内目录',
  TYPE_UNDETERMINED: '类型无法判定（既不是可加载文件，也不是含入口文件的目录）',
  PROVIDER_STATE_UNREADABLE: 'provider 自身状态不可读，无法核验是否启用',
  PROVIDER_DISABLED: 'provider 自身配置已禁用',
  ADAPTER_DOES_NOT_SUPPORT_PLUGIN_SELECTION: '该 adapter 不支持插件选择',
};

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

interface ScopeView {
  readonly provider: string | null;
  readonly model: string | null;
  readonly thinkingLevel: string | null;
  readonly pluginSelection: Record<string, readonly string[]> | null;
}

interface ConfigurationView {
  readonly adapterId: string;
  readonly global: ScopeView | null;
  readonly project: ScopeView | null;
  readonly effective: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly thinkingLevel: string | null;
  };
  readonly sources: Record<string, string>;
  readonly pluginSelection: Record<string, readonly string[]> | null;
  readonly pluginSelectionSource: 'GLOBAL' | 'PROJECT' | null;
  readonly thirdPartyExtensionApprovalRisk: boolean;
}

interface CandidateView {
  readonly kind: PluginKind;
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly providerEnabled: boolean | null;
  readonly selectable: boolean;
  readonly reason: string | null;
  readonly selected: boolean;
}

interface DetectionView {
  readonly adapterId: string;
  readonly pluginSelectionSupport: 'SUPPORTED' | 'UNSUPPORTED';
  readonly providerConfigDirectory: string;
  readonly providerStateReadable: boolean;
  readonly candidates: readonly CandidateView[];
  readonly selection: Record<string, readonly string[]> | null;
  readonly selectionSource: 'GLOBAL' | 'PROJECT' | null;
}

function sourceLabel(source: string): string {
  if (source === 'ENVIRONMENT') return '环境变量';
  if (source === 'PROJECT') return '项目覆盖';
  if (source === 'GLOBAL') return '全局默认';
  return '适配器默认';
}

function reasonLabel(reason: string): string {
  return reasonLabels[reason] ?? reason;
}

export function AgentSettingsPanel({ client, projectId, run }: {
  readonly client: RuntimeClient;
  readonly projectId: string | null;
  readonly run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const actions = usePendingAction(run);
  const [config, setConfig] = useState<ConfigurationView | null>(null);
  const [detection, setDetection] = useState<DetectionView | null>(null);
  const [adapterId, setAdapterId] = useState('pi');
  const [scope, setScope] = useState<'GLOBAL' | 'PROJECT'>('GLOBAL');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinkingLevel, setThinkingLevel] = useState('');
  // 选择状态以「完整列表」形式呈现：勾选即写入整份选择，取消勾选即从列表移除，没有隐藏的合并。
  const [chosen, setChosen] = useState<Record<PluginKind, string[]>>({
    extensions: [], skills: [], promptTemplates: [], themes: [],
  });

  const reload = useCallback(async (): Promise<void> => {
    const [nextConfig, nextDetection] = await Promise.all([
      client.command<ConfigurationView>({
        command: 'agent.config.get', adapterId,
        ...(projectId === null ? {} : { projectId }),
      }),
      client.command<DetectionView>({
        command: 'agent.plugins.list', adapterId,
        ...(projectId === null ? {} : { projectId }),
      }),
    ]);
    setConfig(nextConfig);
    setDetection(nextDetection);
    const record = scope === 'PROJECT' ? nextConfig.project : nextConfig.global;
    setProvider(record?.provider ?? '');
    setModel(record?.model ?? '');
    setThinkingLevel(record?.thinkingLevel ?? '');
    setChosen({
      extensions: [...(record?.pluginSelection?.['extensions'] ?? [])],
      skills: [...(record?.pluginSelection?.['skills'] ?? [])],
      promptTemplates: [...(record?.pluginSelection?.['promptTemplates'] ?? [])],
      themes: [...(record?.pluginSelection?.['themes'] ?? [])],
    });
  }, [adapterId, client, projectId, scope]);

  useEffect(() => { void run('正在加载 Agent 设置', reload); }, [reload, run]);
  useEffect(() => { setScope(projectId === null ? 'GLOBAL' : 'PROJECT'); }, [projectId]);

  const toggle = (candidate: CandidateView): void => {
    setChosen((current) => {
      const paths = current[candidate.kind];
      const next = paths.includes(candidate.path)
        ? paths.filter((path) => path !== candidate.path)
        : [...paths, candidate.path];
      return { ...current, [candidate.kind]: next };
    });
  };

  const saving = actions.pending.has('plugin-selection');
  const selectedCount = pluginKinds.reduce((total, kind) => total + chosen[kind].length, 0);
  const extensionRisk = chosen.extensions.length > 0;
  const unsupported = detection?.pluginSelectionSupport === 'UNSUPPORTED';

  return (
    <section className="card">
      <h2>Agent 设置</h2>
      <p className="muted">
        adapter、模型、思考深度与插件选择都在这里配置，走的是与 CLI 同一条命令面。修改只对
        <strong>新建 Session</strong> 生效，不重启 Runtime、不需要确认；每次执行都会把当时生效的
        插件列表（路径 + 类别 + 来源层）写进 Execution 记录。
      </p>
      {extensionRisk ? (
        <p className="muted">
          ⚠ 已选择第三方 extension。Pi 的 fail-closed 审批门禁靠 --no-extensions 保证「唯一被加载的
          extension 是 Codeestra 自己的」，用户显式加载的第三方 extension 可能影响或绕过该审批。
          本轮不新增审批层、也不做运行期拦截，这一事实会被记录到 Execution。
        </p>
      ) : null}

      <div className="row">
        <label>
          Adapter
          <select value={adapterId} onChange={(event) => setAdapterId(event.target.value)}>
            <option value="pi">pi</option>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
        </label>
        <label>
          作用域
          <select value={scope} onChange={(event) => setScope(event.target.value as 'GLOBAL' | 'PROJECT')}
            disabled={projectId === null}>
            <option value="GLOBAL">全局默认</option>
            <option value="PROJECT">项目覆盖</option>
          </select>
        </label>
      </div>
      {projectId === null ? <p className="muted">未选择项目：只能编辑全局默认。</p> : null}

      {unsupported ? (
        <p className="muted">
          {detection?.adapterId} 的 adapter 能力投影报告 <strong>pluginSelection: UNSUPPORTED</strong>：
          该 adapter 本轮不支持插件开关，因此不显示候选列表，也不会把选择写进配置。
        </p>
      ) : null}

      {config === null ? <p className="muted">正在加载…</p> : (
        <>
          <h3>当前生效值（{config.adapterId}）</h3>
          <table>
            <thead><tr><th>字段</th><th>值</th><th>来源</th></tr></thead>
            <tbody>
              <tr>
                <td>Provider</td>
                <td>{config.effective.provider ?? '适配器默认'}</td>
                <td>{sourceLabel(config.sources['provider'] ?? 'DEFAULT')}</td>
              </tr>
              <tr>
                <td>模型</td>
                <td>{config.effective.model ?? '适配器默认'}</td>
                <td>{sourceLabel(config.sources['model'] ?? 'DEFAULT')}</td>
              </tr>
              <tr>
                <td>思考深度</td>
                <td>{config.effective.thinkingLevel ?? '适配器默认'}</td>
                <td>{sourceLabel(config.sources['thinkingLevel'] ?? 'DEFAULT')}</td>
              </tr>
              {pluginKinds.map((kind) => (
                <tr key={kind}>
                  <td>{kindLabels[kind]}</td>
                  <td>
                    {(config.pluginSelection?.[kind] ?? []).length === 0
                      ? '未选择（不加载）'
                      : (config.pluginSelection?.[kind] ?? []).join('、')}
                  </td>
                  <td>
                    {(config.pluginSelection?.[kind] ?? []).length === 0
                      ? '不适用'
                      : sourceLabel(config.pluginSelectionSource ?? 'DEFAULT')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {unsupported || detection === null ? null : (
        <>
          <h3>插件候选（只读检测）</h3>
          <p className="muted">
            来源：{detection.providerConfigDirectory}
            {detection.providerStateReadable
              ? ''
              : '（settings.json 不可读：provider 是否启用无法核验，一律按「不可核验」显示）'}
            。检测只读 provider 自己的用户配置目录，不扫描仓库内的 .pi/、.claude/、.codex/，也不写任何配置。
          </p>
          {detection.candidates.length === 0 ? <p className="muted">没有可列出的候选。</p> : null}
          {pluginKinds.map((kind) => {
            const candidates = detection.candidates.filter((candidate) => candidate.kind === kind);
            if (candidates.length === 0) return null;
            return (
              <div key={kind}>
                <h4>{kindLabels[kind]}（{candidates.length}）</h4>
                <ul>
                  {candidates.map((candidate) => (
                    <li key={`${candidate.kind}:${candidate.path}`}>
                      <label>
                        <input
                          type="checkbox"
                          checked={chosen[kind].includes(candidate.path)}
                          disabled={!candidate.selectable || saving}
                          onChange={() => toggle(candidate)}
                        />
                        {' '}
                        {candidate.name}
                        {' '}
                        <span className="muted">
                          {candidate.path} · 来源 {candidate.source} ·
                          {' '}
                          {candidate.providerEnabled === null
                            ? 'provider 启用状态：不可核验'
                            : `provider ${candidate.providerEnabled ? '已启用' : '未启用'}`}
                          {candidate.selectable
                            ? ''
                            : ` · 不可启用：${reasonLabel(candidate.reason ?? 'UNKNOWN')}`}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </>
      )}

      {unsupported ? null : (
        <>
          <h3>编辑并保存（{scope === 'GLOBAL' ? '全局默认' : '项目覆盖'}）</h3>
          <div className="row">
            <label>
              Provider
              <input value={provider} onChange={(event) => setProvider(event.target.value)}
                placeholder="留空 = 适配器默认" />
            </label>
            <label>
              模型
              <input value={model} onChange={(event) => setModel(event.target.value)}
                placeholder="留空 = 适配器默认" />
            </label>
            <label>
              思考深度
              <select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
                <option value="">适配器默认</option>
                {thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
          </div>
          <p className="muted">
            已勾选 {selectedCount} 个插件路径。保存会以这组勾选整体替换该作用域的选择（不是与低优先级
            作用域合并）；取消全部勾选等于「不加载任何插件」。路径不可核验时 Runtime 会拒绝保存并给出
            稳定错误码，此处不会替你静默丢弃。
          </p>
          <button
            type="button"
            disabled={saving || (scope === 'PROJECT' && projectId === null)}
            onClick={() => void actions.run('plugin-selection', '正在保存 Agent 设置', async () => {
              try {
                await client.command({
                  command: 'agent.config.set',
                  adapterId,
                  scope,
                  ...(scope === 'PROJECT' && projectId !== null ? { projectId } : {}),
                  provider: provider.trim() === '' ? null : provider.trim(),
                  model: model.trim() === '' ? null : model.trim(),
                  thinkingLevel: thinkingLevel === '' ? null : thinkingLevel,
                  pluginSelection: selectedCount === 0 ? null : chosen,
                });
              } finally {
                await reload();
              }
            })}
          >
            {saving ? '正在保存…' : '保存'}
          </button>
          <button type="button" className="ghost" disabled={saving}
            onClick={() => void actions.run('plugin-selection', '正在清除插件选择', async () => {
              try {
                await client.command({
                  command: 'agent.config.set',
                  adapterId,
                  scope,
                  ...(scope === 'PROJECT' && projectId !== null ? { projectId } : {}),
                  pluginSelection: null,
                });
              } finally {
                await reload();
              }
            })}
          >
            清除选择
          </button>
        </>
      )}
    </section>
  );
}

/** 一次失败的解释保持在页面内：Runtime 的错误码是稳定值，直接显示，不翻译成猜测。 */
export function describeAgentSettingsError(error: unknown): string {
  return describeError(error);
}
