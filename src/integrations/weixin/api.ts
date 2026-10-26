import { randomBytes } from 'node:crypto';

// 接口字段参照腾讯 openclaw-weixin 的 docs/protocol_zh_CN.md。
export const apiBase = 'https://ilinkai.weixin.qq.com';
const protocolVersion = '2.4.8';
const clientVersion = String((2 << 16) | (4 << 8) | 8);

export type WeixinImage = { aeskey?: string; media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string } };
export type WeixinMessage = {
  message_id?: number; from_user_id?: string; message_type?: number; group_id?: string; context_token?: string;
  item_list?: { type: number; text_item?: { text?: string }; image_item?: WeixinImage; voice_item?: { text?: string } }[];
};
export type QrStatus = {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'need_verifycode' | 'verify_code_blocked' | 'scaned_but_redirect' | 'binded_redirect';
  bot_token?: string; ilink_bot_id?: string; baseurl?: string; ilink_user_id?: string; redirect_host?: string;
};

export function validateApiBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.hostname !== 'ilinkai.weixin.qq.com' && !url.hostname.endsWith('.ilinkai.weixin.qq.com')) || url.username || url.password || url.port) throw new Error('微信返回了无效的接口地址');
  return url.origin;
}

export async function weixinRequest<T>(base: string, endpoint: string, options: { body?: object; token?: string; signal?: AbortSignal; timeout?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': clientVersion };
  if (options.body) {
    headers['Content-Type'] = 'application/json';
    headers.AuthorizationType = 'ilink_bot_token';
    headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
  }
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const timeout = AbortSignal.timeout(options.timeout ?? 15000);
  const response = await fetch(new URL(`/ilink/bot/${endpoint}`, validateApiBase(base)), {
    method: options.body ? 'POST' : 'GET', headers,
    body: options.body ? JSON.stringify({ ...options.body, ...(options.token ? { base_info: { channel_version: protocolVersion, bot_agent: 'AgentMuster/0.1.20' } } : {}) }) : undefined,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`微信接口请求失败（${response.status}）`);
  const result = await response.json() as T & { ret?: number; errcode?: number };
  if (result.ret === -14 || result.errcode === -14) throw new WeixinAuthError('微信登录已过期，请重新扫码连接');
  if (result.ret || result.errcode) throw new Error(`微信接口返回错误（${result.ret || result.errcode}）`);
  return result;
}

export class WeixinAuthError extends Error {}
