import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import multiPane from '../../docs/screenshots/multi-pane.jpg';
import agentSelector from '../../docs/screenshots/agent-selector.jpg';
import agentManagement from '../../docs/screenshots/agent-management.jpg';
import imIntegration from '../../docs/screenshots/im-integration.jpg';
import codex from './assets/agents/codex.svg';
import claude from './assets/agents/claude.svg';
import pi from './assets/agents/pi.svg';
import kimi from './assets/agents/kimi.svg';
import gemini from './assets/agents/gemini.svg';
import opencode from './assets/agents/opencode.svg';
import cursor from './assets/agents/cursor.svg';
import { WebsitePreview } from './website-preview';
import './website.css';

const repository = 'https://github.com/sexyAmole/agent-muster';
const documentation = `${repository}/blob/main/README.zh-CN.md`;
const agents = [
  { name: 'Codex', icon: codex },
  { name: 'Claude Code', icon: claude },
  { name: 'Pi', icon: pi },
  { name: 'Kimi CLI', icon: kimi },
  { name: 'Gemini CLI', icon: gemini },
  { name: 'OpenCode', icon: opencode },
  { name: 'Cursor', icon: cursor },
];
const features = [
  {
    label: '多窗口会话',
    title: '任务并行，上下文各自清晰',
    description: '单窗、双栏、四宫格，按任务安排你的工作台。每个窗口独立选择项目和会话。',
    detail: '按项目保存对话记录，随时继续已有任务，实时查看回复、工具调用与执行状态。',
    image: multiPane,
    alt: '四宫格会话布局，每个窗口独立选择项目与 Agent',
    anchor: '创建第一个任务',
    link: '了解如何创建任务',
  },
  {
    label: 'Agent 管理',
    title: '不同 Agent，统一管理',
    description: '自动检测本机 Agent CLI，集中查看安装状态、版本与命令路径，直接安装、更新或卸载。',
    detail: '选择适合任务的 Agent 与模型，延续已有的登录和模型配置。',
    image: agentManagement,
    alt: 'Agent 管理界面中的版本、安装状态与管理操作',
    anchor: '功能',
    link: '查看支持的 Agent',
  },
  {
    label: 'IM 集成',
    title: '任务，从一条消息开始',
    description: '扫码接入钉钉或飞书，将应用绑定项目和 Agent。在单聊或群聊中发起任务，结果回到原对话。',
    detail: '同一聊天继续已有会话，支持通过指令切换项目和模型。保持本地服务运行，无需公网地址。',
    image: imIntegration,
    alt: '钉钉和飞书应用的扫码接入界面',
    anchor: 'im-集成',
    link: '了解消息平台接入',
  },
  {
    label: '本地工作',
    title: '工作在本地，选择在你手中',
    description: '项目与对话记录保存在本机，Agent 在你选择的项目目录中执行任务。',
    detail: '继续使用各 Agent 自己的登录与模型配置。Agent Muster 负责把工作组织起来。',
    image: agentSelector,
    alt: '在本地项目中选择 Agent 和模型创建任务',
    anchor: '本地数据',
    link: '查看本地数据说明',
  },
];
const installMethods = [
  { label: '直接运行', command: 'npx agent-muster', description: '无需全局安装，在终端执行后自动打开本地工作台。' },
  { label: '全局安装', command: 'npm install -g agent-muster\nagent-muster', description: '安装后，随时使用 agent-muster 命令启动工作台。' },
];

function Arrow() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>;
}

function Brand() {
  return <a className="brand" href="#top" aria-label="Agent Muster 首页"><img src="/favicon.svg" width="34" height="34" alt="" /><span>Agent Muster</span></a>;
}

function AmbientBackground() {
  const backgroundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const background = backgroundRef.current!;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pointerX = 0;
    let pointerY = 0;
    let frame = 0;

    function update() {
      frame = 0;
      const scrollRange = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      background.style.setProperty('--pointer-x', `${motion.matches ? 0 : pointerX}px`);
      background.style.setProperty('--pointer-y', `${motion.matches ? 0 : pointerY}px`);
      background.style.setProperty('--scroll-y', `${motion.matches ? 0 : window.scrollY / scrollRange * 240}px`);
    }

    function scheduleUpdate() {
      if (!frame) frame = window.requestAnimationFrame(update);
    }

    function handlePointerMove(event: PointerEvent) {
      if (motion.matches || event.pointerType === 'touch') return;
      pointerX = (event.clientX / window.innerWidth - 0.5) * 100;
      pointerY = (event.clientY / window.innerHeight - 0.5) * 80;
      scheduleUpdate();
    }

    function resetPointer() {
      pointerX = 0;
      pointerY = 0;
      scheduleUpdate();
    }

    function handlePointerOut(event: PointerEvent) {
      if (!event.relatedTarget) resetPointer();
    }

    function handleScroll() {
      if (!motion.matches) scheduleUpdate();
    }

    update();
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerout', handlePointerOut, { passive: true });
    window.addEventListener('blur', resetPointer);
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    motion.addEventListener('change', scheduleUpdate);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerout', handlePointerOut);
      window.removeEventListener('blur', resetPointer);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', scheduleUpdate);
      motion.removeEventListener('change', scheduleUpdate);
    };
  }, []);

  return <div className="ambient-background" ref={backgroundRef} aria-hidden="true">
    <div className="ambient-shape"><span /></div>
    <div className="ambient-shape"><span /></div>
    <div className="ambient-shape"><span /></div>
  </div>;
}

function Website() {
  const [installMethod, setInstallMethod] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const selectedInstall = installMethods[installMethod];

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (motion.matches) return;
    const sections = document.querySelectorAll<HTMLElement>('.feature-section, .download-section, .start-section, .faq-section, .closing');
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.remove('reveal-pending');
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.08 });
    for (const section of sections) {
      section.classList.add('reveal-section', 'reveal-pending');
      observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(selectedInstall.command);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  }

  return <>
    <AmbientBackground />
    <a className="skip-link" href="#main">跳转到主要内容</a>
    <header className="site-header" id="top">
      <div className="header-inner page-width">
        <Brand />
        <nav aria-label="主导航">
          <a href="#features">功能</a>
          <a href="#download">下载</a>
          <a href={documentation} target="_blank" rel="noreferrer">使用文档</a>
          <a href={repository} target="_blank" rel="noreferrer">GitHub <span aria-hidden="true">↗</span></a>
        </nav>
        <a className="header-action" href="#download">下载桌面端 <Arrow /></a>
      </div>
    </header>

    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <h1 id="hero-title">让 Agent 各展所长<br />让工作井然有序</h1>
        <p className="hero-description">在一个本地工作台中，管理你的 AI 编码 Agent、项目与会话。</p>
        <div className="hero-actions">
          <a className="button" href="#download">下载桌面端 <Arrow /></a>
          <a className="text-link" href="#start">通过命令行启动</a>
        </div>
        <WebsitePreview agents={agents} />
      </section>

      <section className="feature-section page-width" id="features" aria-labelledby="features-title">
        <div className="section-heading"><h2 id="features-title">少一点切换，多一点专注</h2><p>从多窗口会话到消息平台接入，在一个工作台里安排你的任务。</p></div>
        <div className="feature-grid">
          {features.map((item, index) => <article className="feature-showcase" key={item.label} aria-labelledby={`feature-${index}`}>
            <figure className="feature-image"><img src={item.image} alt={item.alt} width="1440" height="900" loading="lazy" /></figure>
            <div className="feature-copy">
              <h3 id={`feature-${index}`}>{item.title}</h3>
              <p>{item.description}</p>
              <p>{item.detail}</p>
              <a className="text-link" href={`${documentation}#${item.anchor}`} target="_blank" rel="noreferrer">{item.link} <span aria-hidden="true">↗</span></a>
            </div>
          </article>)}
        </div>
        <div className="feature-agents">
          <p>支持你熟悉的编码 Agent</p>
          <ul className="agent-list">{agents.map(agent => <li key={agent.name}><img src={agent.icon} width="28" height="28" alt="" /><span>{agent.name}</span></li>)}</ul>
        </div>
      </section>

      <section className="download-section page-width" id="download" aria-labelledby="download-title">
        <div className="section-heading"><h2 id="download-title">在桌面，集合你的 Agent</h2><p>桌面安装包将通过 GitHub Releases 发布，选择适合你的系统。</p></div>
        <ul className="desktop-downloads">
          {['macOS · Apple 芯片', 'Windows · 64 位', 'Linux · AppImage'].map(platform => <li key={platform}><span>{platform}</span><button type="button" disabled aria-label={`${platform} 安装包待发布`}>待发布</button></li>)}
        </ul>
        <p className="download-note">桌面安装包尚未发布，现在可以通过命令行启动。</p>
        <a className="text-link" href={`${repository}/releases`} target="_blank" rel="noreferrer">查看 GitHub Releases <span aria-hidden="true">↗</span></a>
      </section>

      <section className="start-section page-width" id="start" aria-labelledby="start-title">
        <div className="start-heading"><h2 id="start-title">下一步，打开工作台</h2><p>准备好 Node.js 22.19.0 或更高版本，<br />以及至少一个已安装并配置好的 Agent CLI。</p></div>
        <div className="install-panel">
          <div className="install-switch" role="group" aria-label="选择安装方式">{installMethods.map((method, index) => <button key={method.label} type="button" aria-pressed={installMethod === index} onClick={() => { setInstallMethod(index); setCopyState('idle'); }}>{method.label}</button>)}</div>
          <div className="command-row"><pre><code>{selectedInstall.command}</code></pre><button type="button" className="copy-button" onClick={() => { void copyCommand(); }}>{copyState === 'copied' ? '已复制' : '复制命令'}</button></div>
          <p className="install-description" aria-live="polite">{copyState === 'error' ? '未能访问剪贴板，请选中上方命令手动复制。' : selectedInstall.description}</p>
        </div>
        <div className="start-notes"><span>在本机浏览器中运行</span><span>支持 macOS、Windows、Linux</span><a href={documentation} target="_blank" rel="noreferrer">完整安装说明 ↗</a></div>
      </section>

      <section className="faq-section page-width" aria-labelledby="faq-title">
        <h2 id="faq-title">开始之前，你可能想知道</h2>
        <div className="faq-list">
          <details><summary>需要单独配置模型 API 吗？<span aria-hidden="true">+</span></summary><p>Agent Muster 调用本机的 Agent CLI。先完成对应 CLI 的安装、登录与模型配置，工作台会读取可用模型。模型权限和费用由对应服务管理。</p></details>
          <details><summary>数据会保存在哪里？<span aria-hidden="true">+</span></summary><p>项目、对话记录和 IM 接入配置保存在用户主目录的 .agent-muster 中。本地 Web 服务仅监听 127.0.0.1；Agent 执行任务时仍会按其自身配置连接模型服务。</p></details>
          <details><summary>使用钉钉或飞书时，要保持电脑运行吗？<span aria-hidden="true">+</span></summary><p>需要保持电脑与 Agent Muster 运行，并能够连接对应消息平台。服务通过 SDK 长连接接收消息，无需配置公网 Webhook 地址。</p></details>
          <details><summary>可以同时使用不同的 Agent 吗？<span aria-hidden="true">+</span></summary><p>可以。单窗、双栏和四宫格布局中的窗口可以独立选择项目和会话，让不同 Agent 分别处理各自的任务。</p></details>
        </div>
      </section>

      <section className="closing page-width" aria-labelledby="closing-title"><h2 id="closing-title">把 Agent 集合起来<br />从你的下一个项目开始</h2><a className="button" href="#download">下载桌面端 <Arrow /></a><a className="text-link" href="#start">通过命令行启动</a></section>
    </main>

    <footer className="site-footer page-width"><Brand /><p>本地工作台，为你的编码 Agent 而造。</p><a href={repository} target="_blank" rel="noreferrer">GitHub ↗</a></footer>
  </>;
}

createRoot(document.getElementById('root')!).render(<Website />);
