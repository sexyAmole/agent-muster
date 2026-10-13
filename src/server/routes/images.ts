import { Router, raw, type NextFunction, type Request, type Response } from 'express';
import type { SessionManager } from '../../sessions/manager.js';

export function createImageRouter(sessions: SessionManager) {
  const router = Router();
  router.post('/', raw({ type: '*/*', limit: '10mb' }), async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) throw new Error('图片内容无效');
      const mimeType = request.get('Content-Type')?.split(';')[0].trim().toLowerCase();
      if (!mimeType) throw new Error('缺少图片类型');
      response.status(201).json({ id: await sessions.uploadImage(request.body, mimeType) });
    } catch (error) { response.status(400).json({ error: (error as Error).message }); }
  });
  router.use((error: Error & { status?: number }, _request: Request, response: Response, _next: NextFunction) => {
    response.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? '单张图片不能超过 10 MB' : '图片上传失败' });
  });
  return router;
}
