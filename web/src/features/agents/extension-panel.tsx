import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { extensionAgents, extensionTransports, type ExtensionAgent, type LocalSkill, type McpServer, type McpServerConfig } from '../../../../src/agents/extensions/types';
import type { AgentInfo } from '../../../../src/types';
import { Select } from '../../shared/components/select';
import { api } from '../../shared/lib/api';
import { AgentIcon } from './agent-icon';

type ExtensionKind = 'skills' | 'mcp';
type ExtensionItem = LocalSkill | McpServer;
type McpEditor = { name: string; source?: string; config: string; revision: string } | 'new';

function itemKey(item: ExtensionItem): string {
  return 'path' in item ? item.path : JSON.stringify([item.source, item.name]);
}

function useExtensionList<T>(path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<T[]>(path, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setItems(result); })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, reload]);
  useLayoutEffect(() => { setItems(null); }, [path]);

  async function run(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return { items, setItems, loading, busy, error, setError, run, refresh: () => setReload(value => value + 1) };
}

function Editor({ title, submitLabel, busy, error, onClose, onSubmit, children }: {
  title: string;
  submitLabel: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => { element.close(); };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!busy) onSubmit(new FormData(event.currentTarget));
  }

  return <dialog ref={dialog} className="project-dialog extension-dialog" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <form onSubmit={submit} aria-busy={busy}>
      <h2 id={titleId}>{title}</h2>
      <fieldset disabled={busy}>{children}</fieldset>
      {error && <p className="extension-error" role="alert">{error}</p>}
      <div className="project-dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" disabled={busy}>{busy ? '保存中…' : submitLabel}</button>
      </div>
    </form>
  </dialog>;
}

function parseConfig(text: FormDataEntryValue | null): Record<string, unknown> {
  let config: unknown;
  try { config = JSON.parse(String(text)); }
  catch { throw new Error('服务配置格式有误，请检查 JSON 语法'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('服务配置必须是 JSON 对象');
  return config as Record<string, unknown>;
}

function McpFields({ agent, editor }: { agent: ExtensionAgent; editor: McpEditor }) {
  const [transport, setTransport] = useState('http');
  if (editor !== 'new') return <label>服务配置（JSON）
    <textarea name="config" required autoFocus spellCheck={false} defaultValue={editor.config} />
  </label>;
  return <>
    <label>服务名称<input name="name" required autoFocus pattern="[a-zA-Z0-9_\-]+" maxLength={agent === 'dsh' ? 32 : undefined} title="仅支持字母、数字、连字符和下划线" /></label>
    <label>传输方式<select name="transport" value={transport} onChange={event => setTransport(event.target.value)}>
      {extensionTransports[agent].map(value => <option key={value} value={value}>{transportLabels.get(value)}</option>)}
    </select></label>
    <label>{transport === 'stdio' ? '启动命令' : '服务地址'}
      <input key={transport} name="endpoint" required autoComplete="off" spellCheck={false} placeholder={transport === 'stdio' ? '例如 npx' : '例如 https://example.com/mcp'} />
    </label>
    <details className="extension-advanced">
      <summary>高级配置（JSON）</summary>
      <label className="extension-config-label">{transport === 'stdio' ? `启动参数用 args，环境变量用 ${agent === 'opencode' ? 'environment' : 'env'}` : `请求头用 ${agent === 'codex' ? 'http_headers' : 'headers'}`}
        <textarea name="config" spellCheck={false} defaultValue="{}" />
      </label>
    </details>
  </>;
}

const transportLabels = new Map([['http', 'HTTP'], ['stdio', 'stdio'], ['sse', 'SSE'], ['ws', 'WebSocket'], ['unknown', '未知传输方式']]);

export function ExtensionPanel({ kind, agent, agents, refreshing, onRefreshAgents, onAgentChange }: {
  kind: ExtensionKind; agent: ExtensionAgent; agents: AgentInfo[]; refreshing: boolean;
  onRefreshAgents: () => Promise<void>; onAgentChange: (agent: ExtensionAgent) => void;
}) {
  const path = `/api/agents/${agent}/${kind}`;
  const list = useExtensionList<ExtensionItem>(path);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [editor, setEditor] = useState<McpEditor | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const bulkRemove = useRef<HTMLButtonElement>(null);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const skills = kind === 'skills';
  const disabled = list.loading || list.busy || refreshing;
  const action = skills ? '导入技能' : '新增 MCP 服务';
  const selectedItems = list.items?.filter(item => selected.has(itemKey(item))) ?? [];
  const allSelected = Boolean(list.items?.length && selectedItems.length === list.items.length);
  const multipleSources = new Set(list.items?.flatMap(item => 'source' in item && item.source ? [item.source] : [])).size > 1;

  useEffect(() => {
    const keys = new Set(list.items?.map(itemKey));
    setSelected(current => {
      const remaining = new Set([...current].filter(key => keys.has(key)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [list.items]);

  function toggleSelection(item: ExtensionItem) {
    setSelected(current => {
      const next = new Set(current);
      const key = itemKey(item);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function closeEditor() {
    setImporting(false);
    setEditor(null);
    list.setError('');
    requestAnimationFrame(() => editorTrigger.current?.focus());
  }

  function importSkill(form: FormData) {
    void list.run(async () => {
      const result = await api<LocalSkill>(path, { method: 'POST', body: JSON.stringify({ path: String(form.get('path')).trim() }) });
      list.setItems(items => [...(items ?? []), result].sort((a, b) => a.name.localeCompare(b.name)));
      closeEditor();
    });
  }

  function editMcp(server: McpServer) {
    void list.run(async () => {
      const query = server.source === undefined ? '' : `?source=${encodeURIComponent(server.source)}`;
      const result = await api<McpServerConfig>(`${path}/${encodeURIComponent(server.name)}${query}`);
      setEditor({ name: server.name, source: server.source, config: JSON.stringify(result.config, null, 2), revision: result.revision });
    });
  }

  function saveMcp(form: FormData, editor: McpEditor) {
    void list.run(async () => {
      const rawConfig = String(form.get('config')).trim();
      const config = editor === 'new' && rawConfig === '' ? {} : parseConfig(rawConfig);
      if (editor === 'new') {
        const name = String(form.get('name')).trim();
        const endpoint = String(form.get('endpoint')).trim();
        const transport = String(form.get('transport'));
        if (agent === 'opencode') {
          config.type = transport === 'stdio' ? 'local' : 'remote';
          if (transport === 'stdio') {
            const args = config.args === undefined ? [] : config.args;
            if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('args 必须是字符串数组');
            config.command = [endpoint, ...args];
            delete config.args;
          } else config.url = endpoint;
        } else {
          if (['claude', 'qodercn', 'workbuddy'].includes(agent)) config.type = transport;
          if (agent === 'dsh') {
            config.serverName = name;
            config.transport = transport === 'http' ? 'streamable-http' : transport;
          }
          if ((agent === 'kimi' || agent === 'cursor' || agent === 'pi') && transport === 'sse') config[agent === 'kimi' ? 'transport' : 'type'] = 'sse';
          const field = transport === 'stdio' ? 'command' : agent === 'gemini' && transport === 'http' ? 'httpUrl' : 'url';
          config[field] = endpoint;
        }
        list.setItems(await api<McpServer[]>(path, { method: 'POST', body: JSON.stringify({ name, config }) }));
      } else {
        list.setItems(await api<McpServer[]>(`${path}/${encodeURIComponent(editor.name)}`, {
          method: 'PUT', body: JSON.stringify({ config, revision: editor.revision, source: editor.source }),
        }));
      }
      closeEditor();
    });
  }

  function remove(items: ExtensionItem[]) {
    if (disabled || items.length === 0) return;
    const targets = items.map(item => 'path' in item ? item.path : `${item.name}${item.source ? `（${item.source}）` : ''}`).join('\n');
    const impact = skills ? '将删除所选技能文件或目录，也会影响共用这些技能的 Agent。' : `将删除它们在 ${extensionAgents[agent]} 中的用户级 MCP 配置。`;
    const message = `移除所选的 ${items.length} 项？${impact}\n\n${targets}`;
    if (!window.confirm(message)) return;
    void list.run(async () => {
      const failures: string[] = [];
      for (const item of items) {
        try {
          if ('path' in item) {
            await api(path, { method: 'DELETE', body: JSON.stringify({ path: item.path }) });
            list.setItems(current => current?.filter(entry => itemKey(entry) !== itemKey(item)) ?? []);
          } else {
            list.setItems(await api<McpServer[]>(`${path}/${encodeURIComponent(item.name)}`, {
              method: 'DELETE', body: JSON.stringify({ revision: item.revision, source: item.source }),
            }));
          }
          setSelected(current => {
            const next = new Set(current);
            next.delete(itemKey(item));
            return next;
          });
        } catch (reason) {
          failures.push(`${item.name}：${(reason as Error).message}`);
        }
      }
      requestAnimationFrame(() => {
        if (failures.length && items.length > 1) bulkRemove.current?.focus();
        else primary.current?.focus();
      });
      if (failures.length) throw new Error(`已移除 ${items.length - failures.length} 项，${failures.length} 项移除失败。\n${failures.join('\n')}`);
    });
  }

  return <div className="extension-panel">
    <div className="extension-toolbar">
      <div className="extension-scope">
        <Select value={agent} onChange={value => {
          if (value === agent) return;
          setSelected(new Set());
          list.setItems(null);
          onAgentChange(value as ExtensionAgent);
        }} disabled={list.busy || refreshing} renderIcon={value => <AgentIcon agent={value} />} aria-label="选择 Agent">
          {agents.filter(item => item.installed && Object.hasOwn(extensionAgents, item.id)).map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </Select>
        <span>用户级</span>
      </div>
      <div className="extension-actions">
        <button type="button" className="agent-heading-action" disabled={disabled} onClick={() => void list.run(async () => {
          await onRefreshAgents();
          list.refresh();
        })}>刷新列表</button>
        <button ref={primary} type="button" className="agent-heading-action primary" disabled={disabled || !list.items} onClick={event => {
          editorTrigger.current = event.currentTarget;
          list.setError('');
          if (skills) setImporting(true);
          else setEditor('new');
        }}>{action}</button>
      </div>
    </div>
    {!skills && <p className="extension-note">新启动的 Agent 进程会读取更新后的配置。</p>}
    {Boolean(list.items?.length) && <div className="extension-selection">
      <label className="extension-select-all">
        <input type="checkbox" checked={allSelected} disabled={disabled}
          ref={element => { if (element) element.indeterminate = selectedItems.length > 0 && !allSelected; }}
          onChange={() => setSelected(allSelected ? new Set() : new Set(list.items?.map(itemKey)))} />
        全选
      </label>
      <button ref={bulkRemove} type="button" className="agent-heading-action danger" disabled={disabled || selectedItems.length === 0} onClick={() => remove(selectedItems)}>
        移除所选{selectedItems.length > 0 && `（${selectedItems.length}）`}
      </button>
    </div>}
    {disabled && <p className="extension-note" role="status">{list.loading ? '正在读取列表…' : '正在处理…'}</p>}
    {!importing && !editor && list.error && <p className="extension-error" role="alert">{list.error}</p>}
    {!list.loading && list.items?.length === 0 && <p className="im-empty">{skills ? '暂无用户级技能，可以导入本地技能目录。' : '暂无用户级 MCP 服务。'}</p>}
    {list.items?.length ? <ul className="extension-list" aria-label={skills ? '用户级技能' : '用户级 MCP 服务'}>
      {list.items.map(item => <li key={itemKey(item)} data-selected={selected.has(itemKey(item))}>
        <label className="extension-choice">
          <input type="checkbox" checked={selected.has(itemKey(item))} disabled={disabled} aria-label={`选择 ${item.name}`} onChange={() => toggleSelection(item)} />
          <span className="extension-item-label">
            <strong>{item.name}</strong>
            {'path' in item ? <code>{item.path}</code> : <span className="extension-mcp-meta">
              <span>{transportLabels.get(item.transport) ?? item.transport}</span>
              {item.enabled !== undefined && <span className={`agent-status-tag ${item.enabled ? 'installed' : ''}`}>{item.enabled ? '已启用' : '已停用'}</span>}
            </span>}
            {!('path' in item) && multipleSources && <code>{item.source}</code>}
          </span>
        </label>
        <div className="extension-actions">
          {!('path' in item) && <button type="button" className="agent-heading-action" disabled={disabled} aria-label={`编辑 ${item.name}`} onClick={event => {
            editorTrigger.current = event.currentTarget;
            editMcp(item);
          }}>编辑</button>}
          <button type="button" className="agent-heading-action danger" disabled={disabled} aria-label={`移除 ${item.name}`} onClick={() => remove([item])}>移除</button>
        </div>
      </li>)}
    </ul> : null}
    {importing && <Editor title="导入技能" submitLabel="导入技能" busy={list.busy} error={list.error} onClose={closeEditor} onSubmit={importSkill}>
      <label>技能目录<input name="path" required autoFocus autoComplete="off" spellCheck={false} placeholder="输入目录的绝对路径" /></label>
      <p className="extension-note">目录需包含 SKILL.md。导入时会复制整个目录。</p>
    </Editor>}
    {editor && <Editor title={editor === 'new' ? action : `编辑 ${editor.name}`} submitLabel="保存配置" busy={list.busy} error={list.error} onClose={closeEditor} onSubmit={form => saveMcp(form, editor)}>
      <McpFields agent={agent} editor={editor} />
    </Editor>}
  </div>;
}
