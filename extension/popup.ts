const API = "https://clip.sarainoq.cn";
const browserKind = navigator.userAgent.includes("Firefox") ? "firefox" : "chrome";
const webext = typeof browser === "undefined" ? chrome : browser;

const pairPanel = document.querySelector<HTMLElement>("#pair-panel")!;
const clipPanel = document.querySelector<HTMLElement>("#clip-panel")!;
const pairingForm = document.querySelector<HTMLFormElement>("#pairing-form")!;
const codeInput = document.querySelector<HTMLInputElement>("#pairing-code")!;
const extractButton = document.querySelector<HTMLButtonElement>("#extract")!;
const quickSaveButton = document.querySelector<HTMLButtonElement>("#quick-save")!;
const settingsButton = document.querySelector<HTMLButtonElement>("#settings")!;
const settingsPanel = document.querySelector<HTMLElement>("#settings-panel")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const captureScene = document.querySelector<HTMLElement>("#capture-scene")!;
const captureCaption = document.querySelector<HTMLElement>("#capture-caption")!;
const clipForm = document.querySelector<HTMLFormElement>("#clip-form")!;
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const sourceInput = document.querySelector<HTMLInputElement>("#source")!;
const markdownInput = document.querySelector<HTMLTextAreaElement>("#markdown")!;
const count = document.querySelector<HTMLElement>("#count")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
const aiTitleInput = document.querySelector<HTMLInputElement>("#ai-title")!;
const aiKeyRow = document.querySelector<HTMLElement>("#ai-key-row")!;
const aiKeyInput = document.querySelector<HTMLInputElement>("#ai-key")!;
let busy = false;
let metadata: Pick<ZhiyeClipResult, "author" | "publishedAt"> = { author: null, publishedAt: null };

function message(value: string, error = false) {
  statusElement.textContent = value;
  statusElement.classList.toggle("error", error);
}

async function token() {
  const stored = await webext.storage.local.get(["token"]);
  return typeof stored.token === "string" ? stored.token : null;
}

async function responseJson(response: Response) {
  const payload = await response.json().catch(() => null) as {
    error?: { code?: string }; token?: string; documentId?: string; aiTitleError?: string | null;
  } | null;
  if (!response.ok) throw new Error(payload?.error?.code ?? `HTTP_${response.status}`);
  return payload ?? {};
}

async function notifyOpenLibraries(documentId: string) {
  const tabs = await webext.tabs.query({ url: "https://zhiye.sarainoq.cn/*" });
  const results = await Promise.allSettled(tabs.flatMap(({ id }) => id == null ? [] : [webext.scripting.executeScript({
    target: { tabId: id },
    func: (savedId: string) => window.dispatchEvent(new CustomEvent("zhiye:extension-saved", { detail: savedId })),
    args: [documentId],
  })]));
  return results.some(({ status }) => status === "fulfilled");
}

async function showState() {
  const paired = Boolean(await token());
  pairPanel.hidden = paired;
  clipPanel.hidden = !paired;
  settingsButton.hidden = !paired;
  settingsPanel.hidden = true;
}

/**
 * Reads the key from the live field. The field is restored from storage on open
 * but only written back on its change event, so reading storage here could leave
 * out a key the user typed or pasted just before saving.
 */
function typedAiTitleKey() {
  const key = aiKeyInput.value.trim();
  return aiTitleInput.checked && key ? key : null;
}

async function loadAiSettings() {
  const stored = await webext.storage.local.get(["llmTitle", "llmKey"]);
  aiTitleInput.checked = stored.llmTitle === true;
  aiKeyInput.value = typeof stored.llmKey === "string" ? stored.llmKey : "";
  aiKeyRow.hidden = !aiTitleInput.checked;
}

aiTitleInput.addEventListener("change", async () => {
  aiKeyRow.hidden = !aiTitleInput.checked;
  // Turning the feature off drops the stored key as well, so an unchecked
  // extension holds no AI credential at all.
  if (!aiTitleInput.checked) aiKeyInput.value = "";
  await webext.storage.local.set({ llmTitle: aiTitleInput.checked, llmKey: aiKeyInput.value.trim() })
    .then(() => message("设置已保存。"), () => message("设置未保存，请重试。", true));
  if (aiTitleInput.checked) aiKeyInput.focus();
});

aiKeyInput.addEventListener("change", async () => {
  const value = aiKeyInput.value.trim();
  aiKeyInput.value = value;
  await webext.storage.local.set({ llmKey: value })
    .then(() => message("设置已保存。"), () => message("密钥未保存，请重试。", true));
});

pairingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message("正在配对…");
  try {
    const response = await fetch(`${API}/api/browser-extension/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: codeInput.value.trim().toUpperCase(), browser: browserKind }),
    });
    const payload = await responseJson(response);
    if (!payload.token) throw new Error("PAIRING_FAILED");
    await webext.storage.local.set({ token: payload.token });
    codeInput.value = "";
    await showState();
    message("已连接，请打开网页并读取正文。");
  } catch (error) {
    message(`配对失败：${(error as Error).message}`, true);
  }
});

function showSettings(open: boolean) {
  clipPanel.hidden = open;
  settingsPanel.hidden = !open;
  settingsButton.hidden = open;
  message("");
  if (open) document.querySelector<HTMLElement>("#settings-heading")!.focus();
  else settingsButton.focus();
}

settingsButton.addEventListener("click", () => showSettings(true));
backButton.addEventListener("click", () => showSettings(false));

function captureFeedback(state: "reading" | "saving" | "success" | "error") {
  captureScene.hidden = false;
  captureScene.dataset.state = state;
  captureCaption.textContent = { reading: "正在读取", saving: "正在保存", success: "已收入织页", error: "未能完成" }[state];
}

async function readPage(): Promise<ZhiyeClipResult> {
  const [tab] = await webext.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//u.test(tab.url)) {
    throw new Error("当前页面不支持剪藏，请使用织页的手动摘录。");
  }
  await webext.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  const [execution] = await webext.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.__ZHIYE_CLIP_RESULT__,
  });
  const result = execution?.result;
  if (!result?.markdown) throw new Error("页面没有可剪藏的正文，请使用织页的手动摘录。");
  return result;
}

async function saveClip(clip: ZhiyeClipResult) {
  const currentToken = await token();
  if (!currentToken) throw new Error("EXTENSION_UNAUTHORIZED");
  const key = typedAiTitleKey();
  // A storage failure must not discard a captured page or prevent its save.
  if (key) await webext.storage.local.set({ llmTitle: true, llmKey: key }).catch(() => {});
  const response = await fetch(`${API}/api/browser-extension/clips`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${currentToken}`,
      "Content-Type": "application/json",
      ...(key ? { "X-Zhiye-LLM-Key": key } : {}),
    },
    body: JSON.stringify(clip),
  });
  const payload = await responseJson(response);
  const notified = payload.documentId ? await notifyOpenLibraries(payload.documentId).catch(() => false) : false;
  clipForm.hidden = true;
  if (!key) message(notified ? "已保存，织片列表已更新。" : "已另存一张新织片。");
  else if (payload.aiTitleError) message(`已保存；AI 标题未生成（${payload.aiTitleError}），已保留原标题。`, true);
  else message(notified ? "已保存，标题已换成中文，织页目录已自动刷新。" : "已保存，标题已换成中文。");
}

async function runCapture(action: "preview" | "quick" | "save") {
  if (busy) return;
  busy = true;
  const buttons = [extractButton, quickSaveButton, settingsButton, clipForm.querySelector<HTMLButtonElement>("button")!];
  buttons.forEach((button) => { button.disabled = true; });
  clipPanel.setAttribute("aria-busy", "true");
  const quick = action === "quick";
  captureScene.hidden = true;
  if (action !== "save") clipForm.hidden = true;
  if (quick) captureFeedback("reading");
  let saving = action === "save";
  message(saving ? "正在保存新副本…" : "正在读取当前页面…");
  try {
    // Wait for restored AI preferences before either capture path can submit.
    await settingsReady;
    const clip = action === "save" ? {
      title: titleInput.value.trim(), sourceUrl: sourceInput.value.trim(),
      markdown: markdownInput.value, ...metadata,
    } : await readPage();
    if (action === "preview") {
      titleInput.value = clip.title;
      sourceInput.value = clip.sourceUrl;
      markdownInput.value = clip.markdown;
      metadata = { author: clip.author, publishedAt: clip.publishedAt };
      count.textContent = `${clip.markdown.length.toLocaleString()} 字符`;
      clipForm.hidden = false;
      message(typedAiTitleKey()
        ? "请核对正文。保存时生成中文标题，最多20字。"
        : "请核对正文。图片会尝试缓存；失败时保留链接。");
    } else {
      saving = true;
      message("正在保存新副本，请保持弹窗打开…");
      if (quick) captureFeedback("saving");
      await saveClip(clip);
      if (quick) captureFeedback("success");
    }
  } catch (error) {
    const code = (error as Error).message;
    if (quick) captureFeedback("error");
    if (code === "EXTENSION_UNAUTHORIZED") {
      await webext.storage.local.remove(["token"]).catch(() => {});
      await showState();
    }
    message(`${saving ? "保存失败：" : ""}${code}`, true);
  } finally {
    busy = false;
    buttons.forEach((button) => { button.disabled = false; });
    clipPanel.setAttribute("aria-busy", "false");
  }
}

extractButton.addEventListener("click", () => { void runCapture("preview"); });
quickSaveButton.addEventListener("click", () => { void runCapture("quick"); });
clipForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void runCapture("save");
});

markdownInput.addEventListener("input", () => {
  count.textContent = `${markdownInput.value.length.toLocaleString()} 字符`;
});

const settingsReady = loadAiSettings();
void settingsReady.then(() => { settingsButton.disabled = false; }, () => message("无法读取 AI 设置，请重新打开插件。", true));
void showState().catch(() => message("无法读取连接信息，请重新打开插件。", true));
