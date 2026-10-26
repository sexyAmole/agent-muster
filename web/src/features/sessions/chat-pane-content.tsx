import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mergeSessionEvents } from '../../../../src/sessions/events';
import type { SessionEvent as Event, ImBinding, AgentSession as Session, SessionStatus as Status } from '../../../../src/types';
import { useErrorMessage } from '../../shared/components/message';
import { apiUrl } from '../../shared/lib/api-url';
import { api } from '../../shared/lib/api';
import { shortDate } from '../../shared/lib/date';
import { shortPath } from '../projects/project-label';
import { ChatComposer } from './chat-composer';
import { ChatHeader } from './chat-header';
import { ConversationItem } from './conversation-item';
import { ExecutionSteps } from './execution-steps';
import { conversationItems, conversationText, executionRounds } from './session-utils';
import type { ChatPaneProps, SessionSummary } from './types';
type SessionPage = { events: Event[]; hasMore: boolean };

export function ChatPaneContent({ index, pane, multi, active: focused, agents, projects, sessions, feishuApps, pickingProject, onAddProject, onProjectChange, onSessionCreated, onSessionUpdate, panelControls }: ChatPaneProps & {
  panelControls: React.ReactNode;
}) {
  const selectedId = pane.sessionId;
  const [selected, setSelected] = useState<Session | null>(() => {
    const summary = sessions.find(session => session.id === selectedId);
    return summary ? { ...summary, events: [] } : null;
  });
  const [modelReadiness, setModelReadiness] = useState<{ sessionId: string | null; ready: boolean }>({ sessionId: null, ready: false });
  const onModelsReady = useCallback((sessionId: string | null, ready: boolean) => setModelReadiness({ sessionId, ready }), []);
  const modelsReady = modelReadiness.sessionId === selectedId && modelReadiness.ready;
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyController = useRef<AbortController | null>(null);
  const historyScroll = useRef<{ height: number; top: number } | null>(null);
  const [pushingId, setPushingId] = useState<number | null>(null);
  const [error, setError] = useState('');
  useErrorMessage(error, setError);
  const [copiedTarget, setCopiedTarget] = useState<'conversation' | 'run-log' | number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followConversation = useRef(true);

  useEffect(() => {
    if (!selectedId) { setSelected(null); return; }
    let current = true;
    let source: EventSource | undefined;
    setHasMoreHistory(false);
    Promise.all([api<SessionSummary>(`/api/sessions/${selectedId}`), api<SessionPage>(`/api/sessions/${selectedId}/messages?limit=10`)]).then(([metadata, { hasMore, events }]) => {
      const session = { ...metadata, events };
      if (!current) return;
      setSelected(session);
      setHasMoreHistory(hasMore);
      onSessionUpdate(session);
      source = new EventSource(apiUrl(`/api/sessions/${selectedId}/events?after=${Math.max(0, ...session.events.map(event => event.id))}`));
      source.onmessage = messageEvent => {
        const event = JSON.parse(messageEvent.data) as Event;
        setSelected(previous => {
          if (!previous || previous.id !== selectedId) return previous;
          if (event.clearStreamIds) previous = { ...previous, events: previous.events.filter(item => !item.streaming || !event.clearStreamIds!.includes(item.streamId!)) };
          if (event.streamId) {
            return { ...previous, updatedAt: Math.max(previous.updatedAt, event.timestamp), events: mergeSessionEvents([...previous.events, event]) };
          }
          if (previous.events.some(item => item.id === event.id)) {
            return event.pushedToIm ? { ...previous, events: previous.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : previous;
          }
          if (!event.streaming && event.id <= Math.max(0, ...previous.events.map(item => item.id))) return previous;
          const updated = { ...previous, ...(event.im ? { im: previous.im?.map(binding => binding.platform === event.im?.platform ? { ...binding, ...event.im } as ImBinding : binding) } : {}), status: event.type === 'status' ? event.text as Status : previous.status, usage: event.type === 'usage' ? JSON.parse(event.text) as Session['usage'] : previous.usage, updatedAt: event.timestamp, events: previous.agent === 'pi' ? mergeSessionEvents([...previous.events, event]) : [...previous.events, event] };
          return updated;
        });
        if (event.type === 'status') {
          onSessionUpdate({ id: selectedId, status: event.text as Status, updatedAt: event.timestamp });
          api<SessionSummary>(`/api/sessions/${selectedId}`).then(latest => {
            if (!current) return;
            setSelected(previous => {
              if (!previous || previous.id !== selectedId) return previous;
              return previous.updatedAt > latest.updatedAt
                ? { ...previous, externalSessionId: latest.externalSessionId }
                : { ...previous, ...latest };
            });
            onSessionUpdate(latest);
          }).catch(reason => { if (current) setError((reason as Error).message); });
        }
      };
    }).catch(reason => { if (current) setError((reason as Error).message); });
    return () => { current = false; source?.close(); historyController.current?.abort(); };
  }, [selectedId]);

  useEffect(() => {
    followConversation.current = true;
    if (conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.id]);

  useLayoutEffect(() => {
    const scroll = historyScroll.current;
    const element = conversationRef.current;
    if (!scroll || !element) return;
    element.scrollTop = scroll.top + element.scrollHeight - scroll.height;
    historyScroll.current = null;
  }, [selected?.events, hasMoreHistory]);

  useEffect(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, [selected?.events]);

  useEffect(() => {
    if (copiedTarget === null) return;
    const timer = window.setTimeout(() => setCopiedTarget(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedTarget]);

  const copyText = useCallback(async (text: string, target: 'conversation' | 'run-log' | number) => {
    setError('');
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
    } catch (reason) { setError(`复制失败：${(reason as Error).message}`); }
  }, []);

  const loadHistory = useCallback(async () => {
    const before = selected?.events[0]?.id;
    if (!selected || before === undefined || !hasMoreHistory || historyController.current) return;
    const controller = new AbortController();
    historyController.current = controller;
    setLoadingHistory(true);
    try {
      const page = await api<SessionPage>(`/api/sessions/${selected.id}/messages?limit=10&before=${before}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const element = conversationRef.current;
      if (element) historyScroll.current = { height: element.scrollHeight, top: element.scrollTop };
      followConversation.current = false;
      setSelected(current => current?.id === selected.id
        ? { ...current, events: current.agent === 'pi' ? mergeSessionEvents([...page.events, ...current.events]) : [...page.events.filter(event => !current.events.some(item => item.id === event.id)), ...current.events] }
        : current);
      setHasMoreHistory(page.hasMore);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally {
      historyController.current = null;
      if (!controller.signal.aborted) setLoadingHistory(false);
    }
  }, [selected, hasMoreHistory]);

  async function copyConversation() {
    if (!selected) return;
    try {
      const { events } = await api<SessionPage>(`/api/sessions/${selected.id}/messages`);
      await copyText(conversationText({ ...selected, events }), 'conversation');
    } catch (reason) { setError(`复制失败：${(reason as Error).message}`); }
  }

  async function pushToIm(event: Event) {
    if (!selected || !selected.im?.length || event.type !== 'output' || !event.text.trim() || pushingId !== null || event.pushedToIm) return;
    setError(''); setPushingId(event.id);
    try {
      const session = await api<SessionSummary>(`/api/sessions/${selected.id}/${selected.im.some(binding => binding.platform === 'feishu') ? 'feishu' : selected.im.some(binding => binding.platform === 'wecom') ? 'wecom' : selected.im.some(binding => binding.platform === 'weixin') ? 'weixin' : 'dingtalk'}/messages`, { method: 'POST', body: JSON.stringify({ eventId: event.id }) });
      onSessionUpdate(session);
      setSelected(current => current?.id === session.id ? { ...current, events: current.events.map(item => item.id === event.id ? { ...item, pushedToIm: true } : item) } : current);
    } catch (reason) { setError((reason as Error).message); }
    finally { setPushingId(null); }
  }

  const resendMessage = useCallback(async (event: Event, content: string) => {
    if (!modelsReady) throw new Error('请等待模型加载完成后再发送');
    if (!selected || selected.status !== 'stopped' || [...selected.events].reverse().find(item => item.type === 'message')?.id !== event.id) throw new Error('只能编辑当前已停止任务的最后一条消息');
    const session = await api<SessionSummary>(`/api/sessions/${selected.id}/messages`, { method: 'POST', body: JSON.stringify({ content, model: selected.model, permissionMode: selected.permissionMode, imageIds: event.images?.map(image => shortPath(image.path)) }) });
    onSessionUpdate(session);
    setSelected(current => current?.id === session.id ? { ...current, ...session } : current);
  }, [selected, onSessionUpdate, modelsReady]);

  const imPlatform = selected?.im?.some(binding => binding.platform === 'feishu') ? '飞书' : selected?.im?.some(binding => binding.platform === 'wecom') ? '企业微信' : selected?.im?.some(binding => binding.platform === 'weixin') ? '微信' : '钉钉';

  const followStream = useCallback(() => {
    if (followConversation.current && conversationRef.current) conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
  }, []);

  const conversation = useMemo(() => {
    if (!selected) return null;
    const editableMessage = modelsReady && selected.status === 'stopped' && selected.externalSessionId && agents.some(agent => agent.id === selected.agent && agent.installed) ? [...selected.events].reverse().find(event => event.type === 'message') : undefined;
    const renderItem = (item: Event | Event[], showActions = false) => {
      const event = Array.isArray(item) ? item[0] : item;
      return <ConversationItem key={event.streamId || event.id} item={item} index={index} session={selected} showActions={showActions} copiedTarget={copiedTarget} pushingId={pushingId} imPlatform={imPlatform} copyText={copyText} pushToIm={pushToIm} followStream={followStream} resendMessage={event.id === editableMessage?.id ? resendMessage : undefined} />;
    };

    let previousDay: string | undefined;
    const renderDatedItem = (item: Event | Event[], showActions = false) => {
      const event = Array.isArray(item) ? item[0] : item;
      const date = new Date(event.timestamp);
      const day = date.toDateString();
      const showDate = day !== previousDay;
      previousDay = day;
      return <React.Fragment key={event.streamId || event.id}>
        {showDate && <div className="date-divider" role="separator" aria-label={date.toLocaleString('zh-CN', { hour12: false })}><time dateTime={date.toISOString()}>{shortDate(date) || '今天'} {date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time></div>}
        {renderItem(item, showActions)}
      </React.Fragment>;
    };

    return executionRounds(selected).map(round => {
      const items = conversationItems({ ...selected, events: round.events, status: round.end ? round.end.text as Status : selected.status });
      const finalOutput = round.end ? [...round.events].reverse().find(event => event.type === 'output') : undefined;
      const isResult = (item: Event) => item === finalOutput || item.type === 'im_message' || item.type === 'error' || Boolean(item.imageGeneration || item.images?.length);
      const steps = items.filter(item => Array.isArray(item) || !isResult(item));
      const stepEvents = steps.flatMap(item => Array.isArray(item) ? item : [item]);
      const results = items.filter(item => !Array.isArray(item) && isResult(item));
      return <React.Fragment key={round.id}>
        {round.message && renderDatedItem(round.message)}
        <div className="execution-response">
          <ExecutionSteps round={round} stepCount={stepEvents.length} commandCount={stepEvents.filter(event => event.type === 'tool').length}>{steps.map(item => renderItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}</ExecutionSteps>
          {results.map(item => renderDatedItem(item, !Array.isArray(item) && !item.streaming && item === finalOutput))}
        </div>
      </React.Fragment>;
    });
  }, [selected, index, agents, copiedTarget, pushingId, onSessionUpdate, followStream, resendMessage]);

  return <section className="output-panel" aria-label={`对话窗口 ${index + 1}`}>
    <ChatHeader index={index} multi={multi} projects={projects} feishuApps={feishuApps} selected={selected ? { ...selected, title: sessions.find(session => session.id === selected.id)?.title } : null} copiedTarget={copiedTarget} copyConversation={copyConversation} copyText={copyText} panelControls={panelControls} />
    <div className="conversation-scroll" key={selected?.id} ref={conversationRef} role="log" aria-label={`窗口 ${index + 1} 对话记录`} onScroll={event => {
      const element = event.currentTarget;
      followConversation.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (element.scrollTop <= 1) void loadHistory();
    }}>
      {selected ? <div className="chat-thread">
        {hasMoreHistory && <button className="history-load" disabled={loadingHistory} onClick={() => void loadHistory()}>{loadingHistory ? '加载中…' : '加载更早消息'}</button>}
        {conversation}
      </div> : <div className="chat-empty"><strong>描述你想完成的任务</strong></div>}
    </div>
    <ChatComposer index={index} pane={pane} agents={agents} projects={projects} sessions={sessions} pickingProject={pickingProject} onAddProject={onAddProject} onProjectChange={onProjectChange} onSessionCreated={onSessionCreated} onSessionUpdate={onSessionUpdate} focused={focused} selected={selected} setSelected={setSelected} setError={setError} onModelsReady={onModelsReady} />
  </section>;
}
