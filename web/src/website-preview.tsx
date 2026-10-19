import { useEffect, useRef, useState } from 'react';
import './website-preview.css';

const slides = [
  { label: '多窗口会话', caption: '试试切换窗口布局，为不同任务安排独立的工作空间。' },
  { label: 'Agent 选择', caption: '选择熟悉的 Agent，写下你想完成的任务。' },
  { label: 'IM 集成', caption: '切换消息平台，了解如何将本地 Agent 接入聊天。' },
];

export function WebsitePreview({ agents }: { agents: { name: string; icon: string }[] }) {
  const previewRef = useRef<HTMLElement>(null);
  const [slide, setSlide] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [layout, setLayout] = useState(4);
  const [paneAgents, setPaneAgents] = useState(() => [agents[0].name, agents[1].name, agents[4].name, agents[5].name]);
  const [agent, setAgent] = useState(agents[0].name);
  const [draft, setDraft] = useState('');
  const [platform, setPlatform] = useState<'钉钉' | '飞书'>('钉钉');
  const playing = visible && pageVisible && !hovered && !focused && !paused && !reducedMotion;

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setReducedMotion(motion.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.25 });
    observer.observe(previewRef.current!);
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => setSlide(current => (current + 1) % slides.length), 7000);
    return () => window.clearTimeout(timer);
  }, [slide, cycle, playing]);

  function selectSlide(index: number) {
    setSlide(index);
    setCycle(current => current + 1);
  }

  return <figure className="product-preview" ref={previewRef}
    onPointerEnter={event => { if (event.pointerType !== 'touch') setHovered(true); }}
    onPointerLeave={() => setHovered(false)}
    onPointerDownCapture={() => setCycle(current => current + 1)}
    onFocusCapture={event => setFocused(event.target.matches(':focus-visible') || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="preview-switch" role="group" aria-label="选择产品交互演示">
      {slides.map((item, index) => <button type="button" key={item.label} aria-pressed={slide === index} aria-controls="preview-demo" onClick={() => selectSlide(index)}>
        {item.label}{slide === index && <span className="preview-progress" key={`${slide}-${cycle}-${playing}`} data-playing={playing} aria-hidden="true" />}
      </button>)}
    </div>
    <div className="preview-stage">
      <div className="preview-demo" id="preview-demo" data-ui>
        <aside className="demo-sidebar">
          <div className="demo-brand"><img src="/favicon.svg" width="26" height="26" alt="" /><strong>Agent Muster</strong></div>
          <span className="demo-tag">交互演示</span>
          <div className="demo-navigation">
            <button type="button" aria-pressed={slide !== 2} onClick={() => selectSlide(0)}>项目与会话</button>
            <button type="button" aria-pressed={slide === 2} onClick={() => selectSlide(2)}>IM 集成</button>
          </div>
          <span className="demo-sidebar-label">当前项目</span>
          <span className="demo-project">agent-muster</span>
          <p>选择上方页签<br />体验工作台</p>
        </aside>
        <div className="demo-workspace" key={slide}>
          <div className="demo-toolbar"><strong>{slides[slide].label}</strong>
            {slide === 0 && <div className="demo-layout" role="group" aria-label="演示窗口布局">
              {[{ count: 1, label: '单窗' }, { count: 2, label: '双栏' }, { count: 4, label: '四宫格' }].map(item => <button key={item.count} type="button" aria-pressed={layout === item.count} onClick={() => setLayout(item.count)}>{item.label}</button>)}
            </div>}
          </div>
          {slide === 0 ? <div className="demo-panes" data-layout={layout}>
            {paneAgents.slice(0, layout).map((name, index) => <div className="demo-pane" key={index}>
              <div className="demo-pane-heading"><span>新对话</span><span>窗口 {index + 1}</span></div>
              <div className="demo-pane-body"><strong>描述你想完成的任务</strong><p>在 agent-muster 中开始工作</p></div>
              <div className="demo-pane-composer"><span>agent-muster</span><select aria-label={`窗口 ${index + 1} 的演示 Agent`} value={name} onChange={event => setPaneAgents(current => current.map((value, pane) => pane === index ? event.target.value : value))}>{agents.map(item => <option key={item.name}>{item.name}</option>)}</select></div>
            </div>)}
          </div> : slide === 1 ? <div className="demo-agent-view">
            <div className="demo-agent-heading"><img src={agents.find(item => item.name === agent)!.icon} width="40" height="40" alt="" /><strong>这次，让 {agent} 来帮忙</strong></div>
            <div className="demo-agent-options" role="group" aria-label="选择演示 Agent">{agents.map(item => <button type="button" key={item.name} aria-pressed={agent === item.name} onClick={() => setAgent(item.name)}><img src={item.icon} width="22" height="22" alt="" />{item.name}</button>)}</div>
            <div className="demo-composer"><textarea aria-label="演示任务内容" placeholder="写下你想完成的任务…" value={draft} onChange={event => setDraft(event.target.value)} maxLength={2000} /><div><span>agent-muster · {agent}</span><a href="#start">启动后执行任务 <span aria-hidden="true">↗</span></a></div></div>
            <p className="demo-note">这里可以试写任务，启动本地工作台后交给 Agent 执行。</p>
          </div> : <div className="demo-im-view">
            <div className="demo-platforms" role="group" aria-label="选择演示消息平台">{(['钉钉', '飞书'] as const).map(item => <button type="button" key={item} aria-pressed={platform === item} onClick={() => setPlatform(item)}>{item}</button>)}</div>
            <div className="demo-im-intro"><strong>把 Agent 带到{platform}</strong><p>在聊天中发起任务，结果回到原对话。</p></div>
            <ol className="demo-im-steps"><li><strong>扫码创建应用</strong><p>使用{platform}扫描授权二维码，创建机器人应用。</p></li><li><strong>绑定项目与 Agent</strong><p>选择本地项目和已配置好的 Agent。</p></li><li><strong>在聊天中发送任务</strong><p>单聊机器人，或在群聊中提及它。</p></li></ol>
            <a className="demo-guide" href="#start">启动工作台，接入{platform} <span aria-hidden="true">↗</span></a>
          </div>}
        </div>
      </div>
    </div>
    <div className="preview-footer"><figcaption className="preview-caption" aria-live={playing ? 'off' : 'polite'}>{slides[slide].caption}</figcaption><button type="button" className="preview-playback" aria-pressed={paused} disabled={reducedMotion} onClick={() => setPaused(current => !current)}>{reducedMotion ? '已关闭自动切换' : paused ? '开启自动切换' : '暂停自动切换'}</button></div>
  </figure>;
}
