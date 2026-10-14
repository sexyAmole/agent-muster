import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { findJsonl } from '../jsonl.js';
import { join, basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { object, string, tokens, hasTokens, detail, json } from './shared.js';
import type { AgentProvider, ParsedResult } from './shared.js';

interface CodexModel {
  model: string;
  displayName: string;
}

function codexModels(): Promise<CodexModel[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error?: Error, models?: CodexModel[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.kill();
      if (error) reject(error);
      else if (models) resolve(models);
    };
    const timer = setTimeout(() => finish(new Error('Codex model query timed out')), 15000);
    child.on('error', error => finish(error));
    child.stdin.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex exited before returning models')));
    lines.on('line', line => {
      try {
        const message = JSON.parse(line) as { id?: number; error?: { message: string }; result?: { data: CodexModel[] } };
        if (message.error) { finish(new Error(message.error.message)); return; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: true } })}\n`);
        }
        if (message.id === 2 && message.result) finish(undefined, message.result.data);
      } catch (error) { finish(error as Error); }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_muster', version: '0.1.0' } } })}\n`);
  });
}

export const codex: AgentProvider = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  installation: { kind: 'npm', packageName: '@openai/codex' },
  async models() {
    const models = await codexModels();
    const catalog = JSON.parse(await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8')) as { models: { slug: string; context_window?: number }[] };
    return models.filter(model => model.model !== 'gpt-6.1-sol').map(model => ({ id: model.model, name: model.displayName, contextWindow: catalog.models.find(item => item.slug === model.model)?.context_window }));
  },
  async configuredModel() {
    const config = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
    return /^model\s*=\s*['"]([^'"]+)['"]/m.exec(config)?.[1];
  },
  async sessionLogFile(session) {
    const directory = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), '.codex');
    return findJsonl(join(directory, 'sessions'), file => basename(file).endsWith(`-${session.externalSessionId}.jsonl`));
  },
  launch(prompt, externalSessionId, model, images) {
    const imageArgs = images?.flatMap(image => ['--image', image.path]) || [];
    return {
      command: 'codex',
      args: externalSessionId
        ? ['exec', 'resume', ...imageArgs, '--json', '--skip-git-repo-check', ...(model ? ['--model', model] : []), externalSessionId, '-']
        : ['exec', ...imageArgs, '--json', '--skip-git-repo-check', ...(model ? ['--model', model] : []), '-'],
      prompt,
    };
  },
  createReader() {
    const handlers = new Map<string, (event: Record<string, unknown>) => ParsedResult>([
      ['thread.started', event => ({ externalSessionId: string(event.thread_id) })],
      ['turn.completed', event => {
        const usage = object(event.usage);
        if (usage && hasTokens(usage, ['input_tokens', 'output_tokens'])) return { usage: { inputTokens: tokens(usage.input_tokens), outputTokens: tokens(usage.output_tokens) }, usageIsTotal: true };
        return {};
      }],
      ['item.completed', event => {
        const item = object(event.item);
        if (item?.type === 'agent_message') return { text: string(item.text) };
        if (item?.type === 'command_execution') return { tools: [{ name: `$ ${string(item.command) || 'command'}`, detail: string(item.aggregated_output) }] };
        if (item?.type === 'mcp_tool_call') return { tools: [{ name: `${string(item.server) || 'MCP'} / ${string(item.tool) || 'tool'}`, detail: detail(item.result) }] };
        return {};
      }],
      ['error', event => ({ error: string(event.message) || 'Codex error' })],
      ['plain', event => ({ text: string(event.text) })],
    ]);
    return line => {
      const event = json(line);
      if (!event || typeof event.type !== 'string') return {};
      const handle = handlers.get(event.type);
      return handle ? handle(event) : {};
    };
  },
};
