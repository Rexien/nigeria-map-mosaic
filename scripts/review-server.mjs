// Local-only draft preview. Deliberately has no event API or database imports.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, extname} from 'node:path';
export const root = fileURLToPath(new URL('../',import.meta.url));
export function allowedPath(path) {
  return /^\/review\/[a-zA-Z0-9_-]+\.(html|js|css)$/.test(path) || /^\/review\/assets\/\d+\.(jpg|png)$/.test(path) || ['/css/app.css','/css/display-screen.css'].includes(path);
}
export function createReviewServer() {
  return http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/'){res.writeHead(302,{Location:'/review/index.html'});return res.end();}
    if(req.method!=='GET'||!allowedPath(path)){res.writeHead(404);return res.end('Not available in the isolated review.');}
    try {
      const data=await readFile(resolve(root,'.'+path));
      res.writeHead(200,{'Content-Type':{'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.png':'image/png'}[extname(path)],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'",'X-Robots-Tag':'noindex, nofollow'});res.end(data);
    }catch{res.writeHead(404);res.end('Preview file not found.');}
  });
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.REVIEW_PORT||4175);
  createReviewServer().listen(port,'127.0.0.1',()=>console.log(`Isolated review: http://127.0.0.1:${port}/review/index.html`));
}
