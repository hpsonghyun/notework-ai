// Model names and approximate download sizes verified against the official Ollama library.
// Memory choices below are conservative plugin heuristics, not vendor hardware guarantees.
const CATALOG=Object.freeze([
  {id:'embeddinggemma:latest',name:'EmbeddingGemma',downloadMB:622,description:'A compact multilingual embedding model for local semantic search. Requires Ollama 0.11.10 or later.',sourceUrl:'https://ollama.com/library/embeddinggemma'},
  {id:'qwen3-embedding:0.6b',name:'Qwen3 Embedding 0.6B',downloadMB:639,description:'A multilingual embedding alternative for text and code retrieval.',sourceUrl:'https://ollama.com/library/qwen3-embedding:0.6b'},
  {id:'all-minilm:latest',name:'All MiniLM',downloadMB:46,description:'A small embedding model for limited memory. Its short context may reject long text chunks; prefer a multilingual model for multilingual notes.',sourceUrl:'https://ollama.com/library/all-minilm'},
]);
function memory(value){const number=Number(value);return Number.isFinite(number)&&number>0?number:null;}
function tag(value){return typeof value==='string'?(value.includes(':')?value:value+':latest'):'';}
export function embeddingRecommendations({hardware,desktop=true,installedModels=null}={}){
  const ramGiB=memory(hardware?.ramGiB??(hardware?.totalmem?hardware.totalmem/2**30:null));
  const freeGiB=memory(hardware?.freeGiB);
  const measured=ramGiB!==null;
  const limited=measured&&(ramGiB<4||(freeGiB!==null&&freeGiB<1.5));
  const recommendedId=limited?'all-minilm:latest':'embeddinggemma:latest';
  const hardwareSummary=measured?`${ramGiB.toFixed(1)} GiB RAM${freeGiB!==null?`, ${freeGiB.toFixed(1)} GiB currently free`:''}${Number.isSafeInteger(hardware?.threads)&&hardware.threads>0?`, ${hardware.threads} CPU threads`:''}.`:'Hardware memory has not been measured.';
  return {
    available:desktop,recommendedId:desktop?recommendedId:null,hardwareMeasured:measured,hardwareSummary,
    reason:!desktop?'Local Ollama model downloads require a desktop computer with Ollama running.':limited?'Measured memory is limited. Start with the smallest download, or close other apps before using a multilingual model.':measured?'Measured memory supports starting with a compact multilingual model. Actual speed and readiness depend on Ollama, free memory and hardware.':'Start with the compact multilingual option. Check this computer to tailor the suggestion to measured memory.',
    cost:'Local embeddings have no per-call API billing. Downloads use internet data and disk space; inference uses your computer, memory and electricity.',
    requirement:'Install and start Ollama separately. Downloads begin only when you choose Download embedding model. The running local Ollama server retrieves weights from its library.',
    models:CATALOG.map(item=>({...item,recommended:desktop&&item.id===recommendedId,installed:Array.isArray(installedModels)?installedModels.some(model=>tag(model.id??model.model??model.name)===item.id&&model.capabilities?.includes('embedding')):null})),
    sources:['https://docs.ollama.com/capabilities/embeddings'],
  };
}
export function connectionSetupGuide({desktop=true}={}){
  return [
    {id:'llm',title:'1. Connect an answer model',description:desktop?'Choose an existing supported official subscription connection, or enter your own OpenAI or Anthropic API key. API billing belongs to that provider account; a chat subscription does not supply an API key.':'Enter your own OpenAI or Anthropic API key. API billing belongs to that provider account; a chat subscription does not supply an API key.',required:true},
    {id:'embedding',title:'2. Choose how to search notes',description:desktop?'Use keyword search without an embedding API, or use a local Ollama embedding model. Start Ollama, choose a recommendation or enter a library model name, then explicitly download or select an installed embedding model. Embedding models find source passages; the answer model writes the answer.':'Use keyword search on this device. Local Ollama discovery, hardware checks and model downloads are desktop actions.',required:true},
    {id:'jev',title:'3. Optionally connect Jev',description:'Jev uses its own API key and provider account for optional semantic classification and relation judgments. It is separate from the answer model and local embeddings. You can leave Jev disconnected.',required:false},
    {id:'knowledge',title:'4. Build knowledge from your selection',description:'Select the notes to include, choose the search and semantic routes, review any API request limits, and explicitly allow the build.',required:true},
  ];
}
