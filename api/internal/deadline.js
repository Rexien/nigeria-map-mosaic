// Vercel Serverless Function routing /api/internal/deadline to provider-neutral authority
import { handleNodeRequest } from '../../server/api.mjs';

export default async function handler(req, res) {
  return handleNodeRequest(req, res);
}
