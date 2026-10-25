import http from "node:http";
import https from "node:https";
import { resolvePublicTarget } from "./url-security.js";
import type { StudyServices } from "../shared/study-http.js";
export const checkLocalSource:StudyServices["source"] = async(input,signal) => {
  if(!/^https?:\/\//u.test(input))return {state:"unknown",status:null,message:"本地资料没有远程网页来源。"};let url=input;
  try {for(let redirects=0;redirects<4;redirects++) {
    const target=await resolvePublicTarget(url),combined=AbortSignal.any([signal,AbortSignal.timeout(10000)]);combined.throwIfAborted();
    const result=await new Promise<{status:number;location?:string}>((resolve,reject)=>{const req=(target.url.protocol==="https:"?https:http).request(target.url,{method:"HEAD",signal:combined,lookup:(_h,_o,cb)=>cb(null,target.address,target.family),headers:{"User-Agent":"Zhiye source availability check"}},response=>{const status=response.statusCode??0,location=response.headers.location;response.destroy();resolve({status,location});});req.once("error",reject);req.end();});
    if(result.status>=300&&result.status<400&&result.location){url=new URL(result.location,url).href;continue;}
    return {status:result.status,state:result.status>=200&&result.status<300?"ok":[401,403,429].includes(result.status)?"restricted":[404,410].includes(result.status)?"unavailable":"unknown",message:result.status>=200&&result.status<300?"来源当前可访问。":[401,403,429].includes(result.status)?"来源要求登录或限制访问，不能据此判定失效。":`来源返回 HTTP ${result.status}。`};
  }return {state:"unknown",status:null,message:"来源重定向过多，尚未确认状态。"};}catch{signal.throwIfAborted();return {state:"unknown",status:null,message:"本次网络检查未能确认来源状态。"};}
};
