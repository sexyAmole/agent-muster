import { useEffect, useState } from 'react';
import favicon from '../../public/favicon.svg';
import { AmbientBackground } from './components/ambient-background';
import { WebsitePreview } from './components/website-preview';
import { agents, desktopDownloads, documentation, features, installMethods, repository, tutorials } from './data';
import demoVideo from './media/quick-tour.mp4';
import demoPoster from './media/quick-tour.jpg';
import './website.css';

function Arrow() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg>;
}

function Brand() {
  return <a className="brand" href="#top" aria-label="Agent Muster 首页"><img src={favicon} width="34" height="34" alt="" /><span>Agent Muster</span></a>;
}

export function Website() {
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
      </div>
    </header>

    <main id="main">
      <section className="hero page-width" aria-labelledby="hero-title">
        <h1 id="hero-title">让 Agent 各展所长<br />让工作井然有序</h1>
        <p className="hero-description">在一个本地工作台中，管理你的 AI 编码 Agent、项目与会话。</p>
        <div className="hero-actions">
          <a className="button" href="#download">下载桌面端 <Arrow /></a>
          <a className="text-link" href="#demo">查看功能演示</a>
        </div>
        <WebsitePreview agents={agents} />
      </section>

      <section className="demo-section page-width" id="demo" aria-labelledby="demo-title">
        <div className="section-heading"><h2 id="demo-title">从本地任务到 IM 协作</h2><p>添加项目、选择 Agent、创建任务、多窗并行、检查 Git 差异，再通过钉钉接收任务与回复。无声字幕实录，包含鼠标引导和重点放大。</p></div>
        <video controls muted playsInline preload="none" poster={demoPoster} aria-label="Agent Muster 功能操作实录" src={demoVideo} />
        <div className="tutorial-links">{tutorials.map(tutorial => <a key={tutorial.title} href={tutorial.url} target="_blank" rel="noreferrer"><h3>{tutorial.title} <span aria-hidden="true">↗</span></h3><p>{tutorial.description}</p></a>)}</div>
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
        <div className="section-heading"><h2 id="download-title">在桌面，集合你的 Agent</h2><p>下载适合你系统的桌面安装包，开始使用本地工作台。</p></div>
        <ul className="desktop-downloads">
          {desktopDownloads.map(item => <li key={item.platform}><span>{item.platform}</span><a href={item.url} aria-label={`下载 ${item.platform} 安装包`}>{item.label}</a></li>)}
        </ul>
        <p className="download-note">始终前往最新正式 Release。请在 Assets 中选择对应系统和芯片的安装包。</p>
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
          <details><summary>使用钉钉、飞书或企业微信时，要保持电脑运行吗？<span aria-hidden="true">+</span></summary><p>需要保持电脑与 Agent Muster 运行，并能够连接对应消息平台。服务通过 SDK 长连接接收消息，无需配置公网 Webhook 地址。</p></details>
          <details><summary>可以同时使用不同的 Agent 吗？<span aria-hidden="true">+</span></summary><p>可以。单窗、双栏和四宫格布局中的窗口可以独立选择项目和会话，让不同 Agent 分别处理各自的任务。</p></details>
        </div>
      </section>

      <section className="closing page-width" aria-labelledby="closing-title"><h2 id="closing-title">把 Agent 集合起来<br />从你的下一个项目开始</h2><a className="button" href="#download">下载桌面端 <Arrow /></a><a className="text-link" href="#start">通过命令行启动</a></section>
    </main>

    <footer className="site-footer page-width"><Brand /><p>本地工作台，为你的编码 Agent 而造。</p><a href={repository} target="_blank" rel="noreferrer">GitHub ↗</a></footer>
  </>;
}
