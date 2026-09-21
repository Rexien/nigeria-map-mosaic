// Universal Vercel Serverless Function entrypoint routing /api/* to authority
import { handleNodeRequest } from '../server/api.mjs';

export default async function handler(req, res) {
  return handleNodeRequest(req, res);
}
