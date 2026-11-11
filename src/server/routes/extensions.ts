import { Router, type Request, type Response } from 'express';
import { changeMcpServer, getMcpServer, listMcpServers } from '../../agents/extensions/mcp.js';
import { importSkill, listSkills, removeSkill } from '../../agents/extensions/skills.js';
import { extensionAgents, type ExtensionAgent } from '../../agents/extensions/types.js';
import type { AgentRegistry } from '../../agents/registry.js';

function extensionRoute<T extends { agent: string }>(registry: AgentRegistry, run: (agent: ExtensionAgent, request: Request<T>, response: Response) => Promise<unknown>) {
  return async (request: Request<T>, response: Response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { agent } = request.params;
      if (!Object.hasOwn(extensionAgents, agent)) throw new Error('此 Agent 暂不支持扩展管理');
      if (!registry.get(agent)?.installed) throw new Error('此 Agent 尚未安装，请刷新 Agent 列表');
      await run(agent as ExtensionAgent, request, response);
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  };
}

function requireRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('缺少 MCP 配置版本，请刷新列表');
  return value;
}

function configSource(value: unknown): string | undefined {
  if (value !== undefined && typeof value !== 'string') throw new Error('MCP 配置来源无效，请刷新列表');
  return value;
}

export function createExtensionRouter(registry: AgentRegistry) {
  const router = Router();
  const skills = '/agents/:agent/skills';
  const mcp = '/agents/:agent/mcp';
  const mcpServer = '/agents/:agent/mcp/:name';

  router.get(skills, extensionRoute(registry, async (agent, _request, response) => {
    response.json(await listSkills(agent));
  }));
  router.post(skills, extensionRoute(registry, async (agent, request, response) => {
    response.status(201).json(await importSkill(agent, request.body?.path));
  }));
  router.delete(skills, extensionRoute(registry, async (agent, request, response) => {
    await removeSkill(agent, request.body?.path);
    response.json({ removed: true });
  }));
  router.get(mcp, extensionRoute(registry, async (agent, _request, response) => {
    response.json(await listMcpServers(agent));
  }));
  router.get(mcpServer, extensionRoute<{ agent: string; name: string }>(registry, async (agent, request, response) => {
    response.json(await getMcpServer(agent, request.params.name, configSource(request.query.source)));
  }));
  router.post(mcp, extensionRoute(registry, async (agent, request, response) => {
    const { name, config } = request.body ?? {};
    if (typeof name !== 'string' || config === null) throw new Error('请输入 MCP 服务名称和配置');
    response.status(201).json(await changeMcpServer(agent, name, config));
  }));
  router.put(mcpServer, extensionRoute<{ agent: string; name: string }>(registry, async (agent, request, response) => {
    const { config, revision } = request.body ?? {};
    if (config === null) throw new Error('请输入 MCP 服务配置');
    response.json(await changeMcpServer(agent, request.params.name, config, requireRevision(revision), configSource(request.body?.source)));
  }));
  router.delete(mcpServer, extensionRoute<{ agent: string; name: string }>(registry, async (agent, request, response) => {
    response.json(await changeMcpServer(agent, request.params.name, null, requireRevision(request.body?.revision), configSource(request.body?.source)));
  }));
  return router;
}
