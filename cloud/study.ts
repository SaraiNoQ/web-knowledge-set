import { settingsRow, llmRequestKey, modelEndpoint, modelName } from "./ai";
import { CloudHttpError, type D1Database } from "./extension";
import { publicUrl } from "./net";
import type { StudyServices } from "../shared/study-http";
import { jsonContainsSecret } from "../shared/llm-stream";
export async function answerCloudQuestion(request:Request,db:D1Database,payload:string,settingsRevision:number,system:string,epoch:string) {
  const row=await settingsRow(db);if(!row.value.enabled)throw new CloudHttpError(409,"LLM_DISABLED","请先启用智能设置。");if(row.revision!==settingsRevision)throw new CloudHttpError(409,"LLM_SETTINGS_CONFLICT","模型设置已变化。");
  const key=llmRequestKey(request),url=modelEndpoint(row.value.remote.endpointUrl),name=modelName(row.value.remote.model),signal=AbortSignal.any([request.signal,AbortSignal.timeout(60000)]);
  const before=await db.prepare("SELECT (SELECT value FROM app_settings WHERE key='data_epoch') AS epoch,(SELECT revision FROM app_settings WHERE key='llm_settings') AS revision").first<{epoch:string;revision:number}>();
  if(before?.epoch!==epoch||before.revision!==settingsRevision)throw new CloudHttpError(409,"STALE_DATA_EPOCH","资料或模型设置已变化。");
  const response=await fetch(url,{method:"POST",redirect:"manual",signal,headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify({model:name,temperature:0,max_tokens:4096,...(url==="https://api.deepseek.com/chat/completions"?{thinking:{type:"disabled"}}:{}),messages:[{role:"system",content:system},{role:"user",content:payload}]})});
  if(!response.ok||response.status>=300||!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")){await response.body?.cancel();throw new CloudHttpError(502,"LLM_PROTOCOL_REJECTED","模型未返回可验证的回答。");}
  const reader=response.body?.getReader();if(!reader)throw new CloudHttpError(502,"LLM_INVALID_RESPONSE","模型响应为空。");let text="",size=0;const decoder=new TextDecoder("utf-8",{fatal:true});
  try {while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>256*1024)throw new CloudHttpError(502,"LLM_RESPONSE_TOO_LARGE","模型响应过大。");text+=decoder.decode(next.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  signal.throwIfAborted();if(text.includes(key))throw new CloudHttpError(502,"LLM_SECRET_ECHO","模型响应包含凭据，已丢弃。");
  const value=JSON.parse(text) as {choices?:Array<{finish_reason?:string;message?:{content?:unknown}}>};const choice=value.choices?.[0];if(choice?.finish_reason!=="stop"||typeof choice.message?.content!=="string")throw new CloudHttpError(502,"LLM_INVALID_RESPONSE","模型回答不完整。");
  if(jsonContainsSecret(choice.message.content,key))throw new CloudHttpError(502,"LLM_SECRET_ECHO","模型响应包含凭据，已丢弃。");
  const state=await db.prepare("SELECT (SELECT value FROM app_settings WHERE key='data_epoch') AS epoch,(SELECT revision FROM app_settings WHERE key='llm_settings') AS revision").first<{epoch:string;revision:number}>();
  if(state?.epoch!==epoch||state.revision!==settingsRevision)throw new CloudHttpError(409,"STALE_DATA_EPOCH","资料或模型设置已变化。");return choice.message.content;
}
export const checkCloudSource:StudyServices["source"] = async(input,signal) => {
  if(!/^https?:\/\//u.test(input))return {state:"unknown",status:null,message:"本地资料没有远程网页来源。"};
  let url=input;try {for(let redirects=0;redirects<4;redirects++){url=await publicUrl(url);signal.throwIfAborted();const r=await fetch(url,{method:"HEAD",redirect:"manual",signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});await r.body?.cancel();if(r.status>=300&&r.status<400&&r.headers.get("location")){url=new URL(r.headers.get("location")!,url).href;continue;}return {status:r.status,state:r.ok?"ok":[401,403,429].includes(r.status)?"restricted":[404,410].includes(r.status)?"unavailable":"unknown",message:r.ok?"来源当前可访问。":[401,403,429].includes(r.status)?"来源要求登录或限制访问，不能据此判定失效。":`来源返回 HTTP ${r.status}。`};}return {state:"unknown",status:null,message:"来源重定向过多，尚未确认状态。"};}catch(error){signal.throwIfAborted();return {state:"unknown",status:null,message:error instanceof CloudHttpError&&error.code==="BLOCKED_ADDRESS"?"来源地址不符合公开网络访问规则。":"本次网络检查失败，不能据此判定来源失效。"};}
};
