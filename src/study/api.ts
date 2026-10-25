import { api, request, cloudLlmHeaders } from "../api";
import type { StudyTopic, StudyTopicDetail, StudyDocument, ReadingProgress, ReviewItem, ReviewGrade, MergeRecord, DuplicateCandidate, LinkHealth, StudyAnswer } from "../../shared/study-types";
import type { ReadingAnnotation } from "../../shared/reader-tools";
import type { RelatedOptions, RelatedResult, ConnectionEvidence } from "../../shared/related";
const json = (body:unknown,method="POST",signal?:AbortSignal):RequestInit => ({method,body:JSON.stringify(body),signal});
const path = (id:string) => encodeURIComponent(id);
export const studyApi = {
  listTopics: (signal?:AbortSignal) => request<StudyTopic[]>("/api/study/topics",{signal}),
  topic: (id:string,signal?:AbortSignal) => request<StudyTopicDetail>(`/api/study/topics/${path(id)}`,{signal}),
  createTopic: (name:string) => request<StudyTopicDetail>("/api/study/topics",json({name})),
  sourceCollections: (signal?:AbortSignal) => request<Array<{id:string;name:string;updatedAt:string;documents:Array<{id:string;title:string;revision:number}>}>>("/api/study/source-collections",{signal}),
  fromCollection: (collection:{id:string;updatedAt:string;documents:Array<{id:string;revision:number}>},name?:string) => request<StudyTopicDetail>("/api/study/from-collection",json({collectionId:collection.id,updatedAt:collection.updatedAt,documents:collection.documents.map(({id,revision})=>({id,revision})),...(name?{name}:{})})),
  updateTopic: (id:string,revision:number,changes:{name?:string;note?:string;documentId?:string;annotationId?:string;removeDocumentId?:string;removeAnnotationId?:string}) => request<StudyTopicDetail>(`/api/study/topics/${path(id)}`,json({revision,...changes},"PATCH")),
  addDocument: (topic:StudyTopic,documentId:string) => studyApi.updateTopic(topic.id,topic.revision,{documentId}),
  deleteTopic: (id:string,revision:number) => request(`/api/study/topics/${path(id)}`,json({revision},"DELETE")),
  documents: (options:{q?:string;unread?:boolean;page?:number}={},signal?:AbortSignal) => request<{items:StudyDocument[];total:number;page:number}>("/api/study/documents?"+new URLSearchParams({q:options.q??"",unread:String(Boolean(options.unread)),page:String(options.page??1)}),{signal}),
  annotations: (page=1,signal?:AbortSignal) => request<{items:ReadingAnnotation[];total:number;page:number}>(`/api/study/annotations?page=${page}`,{signal}),
  related: (id:string,options:RelatedOptions={},signal?:AbortSignal) => request<RelatedResult>(`/api/study/related/${path(id)}?`+new URLSearchParams({limit:String(options.limit??10),...(options.cursor?{cursor:options.cursor}:{}),...(options.types?{types:options.types.join(",")}:{})}),{signal}),
  connectionEvidence: (id:string,signal?:AbortSignal) => request<ConnectionEvidence|null>(`/api/study/connections/${path(id)}/evidence`,{signal}),
  setConnectionEvidence: (documentId:string,id:string,input:{revision:number;sourceAnnotationId?:string|null;targetAnnotationId?:string|null;relationType:"manual"|"citation"}) => request<ConnectionEvidence>(`/api/study/connections/${path(id)}/evidence`,json({documentId,...input},"PUT")),
  async ask(id:string,question:string,signal?:AbortSignal,topicRevision?:number,scope?:Array<{id:string;revision:number}>) { if(!topicRevision) throw new Error("请重新打开专题后提问。");const settings=await api.getLlmSettings(signal);return request<StudyAnswer>(`/api/study/topics/${path(id)}/ask`,{...json({question,topicRevision,settingsRevision:settings.revision,scope},"POST",signal),headers:cloudLlmHeaders(settings.remote.endpointUrl)}); },
  duplicates: (cursor?:string,signal?:AbortSignal) => request<{items:DuplicateCandidate[];nextCursor:string|null;scanned:number}>("/api/study/duplicates"+(cursor?`?cursor=${path(cursor)}`:""),{signal}),
  checkSource: (id:string,revision:number,signal?:AbortSignal) => request<LinkHealth>(`/api/study/documents/${path(id)}/check-source`,json({revision},"POST",signal)),
  merge: (keepId:string,sourceId:string,keepRevision:number,sourceRevision:number) => request<MergeRecord>("/api/study/merges",json({keepId,sourceId,keepRevision,sourceRevision})),
  mergeHistory: (signal?:AbortSignal) => request<MergeRecord[]>("/api/study/merges",{signal}),
  undoMerge: (id:string) => request(`/api/study/merges/${path(id)}/undo`,json({})),
  progress: (id:string,signal?:AbortSignal) => request<ReadingProgress|null>(`/api/study/documents/${path(id)}/progress`,{signal}),
  saveProgress: (id:string,value:Omit<ReadingProgress,"documentId"|"updatedAt">) => request<ReadingProgress>(`/api/study/documents/${path(id)}/progress`,json(value,"PUT")),
  reviews: (options:{all?:boolean}={},signal?:AbortSignal) => request<ReviewItem[]>(`/api/study/reviews?all=${Boolean(options.all)}`,{signal}),
  scheduleReview: (annotationId:string) => request("/api/study/reviews",json({annotationId})),
  gradeReview: (annotationId:string,revision:number,grade:ReviewGrade) => request(`/api/study/reviews/${path(annotationId)}`,json({revision,grade},"PATCH")),
  tags: (id:string,revision:number,tags:string[]) => request(`/api/study/documents/${path(id)}/tags`,json({revision,tags},"PUT")),
};
