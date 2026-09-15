(function(root){
  const TOKEN_KEY='niac_participant_token', CREDENTIAL_KEY='niac_participant_credential', PROFILE_KEY='niac_participant_profile', ADMIN_KEY='niac_admin_access_token';
  const base=()=>root.APP_CONFIG?.API_BASE||'/api';let gatewayAnswerUrl=null;
  function getToken(){return localStorage.getItem(TOKEN_KEY)}
  function getCredential(){return localStorage.getItem(CREDENTIAL_KEY)||getToken()}
  function getProfile(){try{return JSON.parse(localStorage.getItem(PROFILE_KEY)||'null')}catch{return null}}
  function saveSession(data){localStorage.setItem(TOKEN_KEY,data.token);if(data.credential)localStorage.setItem(CREDENTIAL_KEY,data.credential);localStorage.setItem(PROFILE_KEY,JSON.stringify(data.participant));}
  async function request(path,{method='GET',body,admin=false,idempotencyKey,timeout=8000}={}){
    if(path==='/answers'&&method==='POST'&&gatewayAnswerUrl){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
      try{
        const response=await fetch(gatewayAnswerUrl,{method:'POST',headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${getCredential()}`},body:JSON.stringify(body),signal:controller.signal,cache:'no-store'});
        let data={};try{data=await response.json()}catch{}
        if(response.ok)return data;
        if(response.status<500)throw Object.assign(new Error(data.error||'Answer was rejected'),{status:response.status,code:data.code,noFallback:true});
      }catch(error){if(error.noFallback)throw error}finally{clearTimeout(timer)}
    }
    const headers={accept:'application/json'};if(body)headers['content-type']='application/json';
    const auth=admin?sessionStorage.getItem(ADMIN_KEY):getToken();if(auth)headers.authorization=`Bearer ${auth}`;if(idempotencyKey)headers['idempotency-key']=idempotencyKey;
    const attempts=method==='GET'?2:1;let lastError;
    for(let attempt=0;attempt<attempts;attempt++){
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
      try{
        const response=await fetch(`${base()}${path}`,{method,headers,body:body?JSON.stringify(body):undefined,signal:controller.signal,cache:'no-store'});let data={};try{data=await response.json()}catch{}
        if(!response.ok)throw Object.assign(new Error(data.error||'Request failed'),{status:response.status,code:data.code});return data;
      }catch(error){lastError=error;if(attempt+1<attempts)await new Promise(resolve=>setTimeout(resolve,250));}
      finally{clearTimeout(timer)}
    }
    if(lastError?.name==='AbortError')throw Object.assign(new Error('Connection timed out. Check the network and try again.'),{code:'CONNECTION_TIMEOUT'});
    throw lastError;
  }
  async function join(alias){const data=await request('/participants',{method:'POST',body:{alias}});saveSession(data);return data}
  async function recover(recoveryCode){const data=await request('/recover',{method:'POST',body:{recoveryCode}});saveSession(data);return data}
  function requireParticipant(){if(!getToken()){location.href='/?next='+encodeURIComponent(location.pathname);return false}return true}
  root.NIACApi={request,join,recover,getToken,getProfile,saveSession,requireParticipant,configureGateway:url=>{gatewayAnswerUrl=url||null},setAdminToken:t=>sessionStorage.setItem(ADMIN_KEY,t),clearAdmin:()=>sessionStorage.removeItem(ADMIN_KEY),hasAdmin:()=>Boolean(sessionStorage.getItem(ADMIN_KEY))};
})(window);
