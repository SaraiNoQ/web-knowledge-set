import { expect, test } from "@playwright/test";

test.beforeEach(async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({reducedMotion:"reduce"});
  await page.route("**/api/settings/onboarding",route=>route.fulfill({json:{completed:true,revision:1}}));
});

test("topic question reaches the real service transport and opens its returned citation",async({page,request})=>{
  const state=await request.get("/api/documents"),headers={Origin:"http://127.0.0.1:4174","X-Zhiye-Data-Epoch":state.headers()["x-zhiye-data-epoch"]},title=`真实问答${Date.now()}`;
  const {document}=await(await request.post("/api/documents",{headers,data:{title}})).json();
  const text="The paper states that graph learning shares representations across nodes.";
  await request.patch(`/api/documents/${document.id}`,{headers,data:{revision:document.revision,markdown:text}});
  const topic=await(await request.post("/api/study/topics",{headers,data:{name:`真实研究${Date.now()}`}})).json();
  await request.patch(`/api/study/topics/${topic.id}`,{headers,data:{revision:topic.revision,documentId:document.id}});
  await page.goto("/");await page.getByRole("button",{name:"研究",exact:true}).click();
  const workspace=page.getByRole("region",{name:"研究工作台"});await workspace.getByRole("button",{name:topic.name,exact:true}).click();
  const question=workspace.getByRole("region",{name:"专题问答"});
  await question.getByRole("textbox",{name:"问题",exact:true}).fill("Which representations does graph learning share?");
  await question.getByRole("button",{name:"基于专题提问",exact:true}).click();
  await expect(question.getByLabel("专题回答")).toContainText(text);
  await question.getByRole("button",{name:title,exact:true}).click();
  await expect(page.getByLabel("Markdown 编辑器")).toContainText(text);
  await expect.poll(()=>page.evaluate(()=>getSelection()?.toString())).toBe(text);
});

test("manual duplicate governance preserves both original records and can undo the merge",async({page,request})=>{
  const state=await request.get("/api/documents"),headers={Origin:"http://127.0.0.1:4174","X-Zhiye-Data-Epoch":state.headers()["x-zhiye-data-epoch"]},suffix=Date.now();
  const names=[`治理保留${suffix}`,`治理来源${suffix}`],docs:Array<{id:string}>=[];
  const body="The repeated study paragraph discusses shared graph representations and reliable evidence. ".repeat(6);
  for(const title of names){const {document}=await(await request.post("/api/documents",{headers,data:{title}})).json();await request.patch(`/api/documents/${document.id}`,{headers,data:{revision:document.revision,markdown:body}});docs.push(document);}
  await page.goto("/");await page.getByRole("button",{name:"研究",exact:true}).click();const workspace=page.getByRole("region",{name:"研究工作台"});
  await workspace.getByRole("button",{name:"治理",exact:true}).click();
  const candidate=workspace.locator(".study-duplicate-list > li").filter({hasText:names[0]}).filter({hasText:names[1]});
  await expect(candidate).toBeVisible();
  await candidate.getByRole("radio",{name:new RegExp(names[0]!)}).check();await candidate.getByRole("button",{name:"合并所选资料",exact:true}).click();
  await page.getByRole("alertdialog",{name:"确认合并资料",exact:true}).getByRole("button",{name:"合并资料",exact:true}).click();
  await expect.poll(async()=>(await(await request.get(`/api/documents/${docs[1]!.id}`)).json()).deletedAt).not.toBeNull();
  expect((await(await request.get(`/api/documents/${docs[1]!.id}`)).json()).markdown).toBe(body);
  const history=workspace.getByRole("region",{name:"合并历史"}).locator("li").filter({hasText:names[0]}).filter({hasText:names[1]});
  await history.getByRole("button",{name:"撤回合并",exact:true}).click();await page.getByRole("alertdialog",{name:"撤回合并",exact:true}).getByRole("button",{name:"撤回合并",exact:true}).click();
  await expect.poll(async()=>(await(await request.get(`/api/documents/${docs[1]!.id}`)).json()).deletedAt).toBeNull();
  expect((await(await request.get(`/api/documents/${docs[0]!.id}`)).json()).markdown).toBe(body);
});
