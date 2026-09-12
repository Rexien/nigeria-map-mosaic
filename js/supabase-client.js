/* Compatibility data source for the retained D3 Nigeria mosaic. */
(function(root){
  let timer=null,last='';
  const fallback=[
    {id:'seed-1',raw_word:'Resilience',stem:'resilien',created_at:new Date().toISOString()},
    {id:'seed-2',raw_word:'Egusi soup',stem:'egusi soup',created_at:new Date().toISOString()},
    {id:'seed-3',raw_word:'Warm hospitality',stem:'warm hospital',created_at:new Date().toISOString()}
  ];
  async function fetchResponses(){
    try{const r=await fetch('/api/lens/approved',{headers:{accept:'application/json'}});if(!r.ok)throw new Error();const body=await r.json();return body.responses.map(x=>({id:x.id,raw_word:x.phrase,word_lower:x.normalized_phrase,stem:(root.WordStemmer?.stem(x.phrase)||x.normalized_phrase),is_hidden:false,is_flagged:false,created_at:x.created_at}));}catch{return fallback;}
  }
  function subscribeRealtime(callbacks={}){clearInterval(timer);timer=setInterval(async()=>{const rows=await fetchResponses();const signature=JSON.stringify(rows.map(x=>[x.id,x.raw_word]));if(last&&signature!==last)callbacks.onUpdate?.({id:'refresh'});last=signature;},3000);return{unsubscribe(){clearInterval(timer)}};}
  root.MosaicDB={init(){},fetchResponses,subscribeRealtime,isDemoMode:()=>false};
})(window);
