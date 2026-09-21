// Stable Vercel authority router. All /api/* requests are rewritten here.
import { handleNodeRequest } from '../server/api.mjs';

export default async function handler(req, res) {
  return handleNodeRequest(req, res);
}
