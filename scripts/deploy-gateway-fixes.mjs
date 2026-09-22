// Explicit, code-only gateway deployment. Environment/secrets are managed separately.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const files=['gateway/server.mjs','gateway/lib/batch-flusher.mjs','gateway/lib/sqlite-queue.mjs','lib/credentials.mjs'];
const sshKey=process.env.NIAC_SSH_KEY;
const host=process.env.NIAC_DEPLOY_HOST;
if(process.argv[2]!=='--confirm-gateway-deploy')throw new Error('Explicit --confirm-gateway-deploy is required');
if(!sshKey||!host)throw new Error('NIAC_SSH_KEY and NIAC_DEPLOY_HOST are required');

for(const relPath of files){
  const remotePath=`/home/ubuntu/niac-gateway/${relPath.replace(/\\/g,'/')}`;
  const result=spawnSync('ssh',['-i',sshKey,'-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',host,`cat > ${remotePath}`],{input:fs.readFileSync(relPath,'utf8'),encoding:'utf8'});
  if(result.status!==0)throw new Error(`Failed to deploy ${relPath}: ${result.stderr||result.error}`);
}

const restart=spawnSync('ssh',['-i',sshKey,'-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new',host,'sudo systemctl restart niac-gateway && systemctl is-active niac-gateway'],{encoding:'utf8',stdio:'inherit'});
if(restart.status!==0)throw new Error('Gateway restart/health check failed');
console.log('Gateway code deployed; environment was not modified.');
