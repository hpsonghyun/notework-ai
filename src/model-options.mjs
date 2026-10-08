const EFFORTS=new Set(['none','minimal','low','medium','high','xhigh','max','ultra']);

export function validateReasoningEffort(value) {
  if(value==null||value==='')return '';
  if(typeof value!=='string'||!EFFORTS.has(value))throw new Error('Choose a supported reasoning effort.');
  return value;
}

export function reasoningEfforts(model) {
  if(!model)return [];
  const supplied=model.supportedReasoningEfforts ?? model.supportedEffortLevels ?? model.supported_reasoning_efforts;
  if(Array.isArray(supplied))return [...new Set(supplied.map(item=>typeof item==='string'?item:item?.reasoningEffort??item?.reasoning_effort??item?.effort).filter(value=>EFFORTS.has(value)))];
  // Published capabilities are used only for already discovered account models.
  // They never add an unlisted model to the picker.
  if(/^gpt-6(?:\.1)?-sol(?:-|$)/.test(model.id||''))return ['low','medium','high','xhigh','max'];
  return [];
}

export function normalizeReasoningEffort(model,value) {
  return reasoningEfforts(model).includes(value)?value:'';
}
