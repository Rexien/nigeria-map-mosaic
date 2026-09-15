export function createReadCache(now=Date.now){
  const entries=new Map();
  return {
    async get(key,ttl,load,expiresAt=()=>Infinity){
      const prior=entries.get(key);
      if(prior&&(prior.pending||prior.until>now()))return prior.promise;
      const entry={pending:true,until:0};
      entry.promise=Promise.resolve().then(load).then(value=>{
        entry.pending=false;entry.until=Math.min(now()+ttl,expiresAt(value));return value;
      },error=>{if(entries.get(key)===entry)entries.delete(key);throw error});
      entries.set(key,entry);return entry.promise;
    },
    clear(){entries.clear()}
  };
}

export function createRateLimiter(now=Date.now){
  const rates=new Map();
  return function limit(identity,bucket,max,windowMs=60000){
    const time=now(),key=bucket+':'+identity;
    if(rates.size>=10000)for(const [k,v] of rates)if(v.until<=time)rates.delete(k);
    let entry=rates.get(key);
    if(!entry||entry.until<=time){
      if(rates.size>=20000)throw Object.assign(new Error('Please retry shortly.'),{status:429});
      entry={count:0,until:time+windowMs};rates.set(key,entry);
    }
    if(++entry.count>max)throw Object.assign(new Error('Too many requests. Try again shortly.'),{status:429});
  };
}
