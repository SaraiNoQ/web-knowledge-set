const API = "http://127.0.0.1:4301";
const browserKind = navigator.userAgent.includes("Firefox") ? "firefox" : "chrome";
const webext = typeof browser === "undefined" ? chrome : browser;

const pairPanel = document.querySelector<HTMLElement>("#pair-panel")!;
const clipPanel = document.querySelector<HTMLElement>("#clip-panel")!;
const pairingForm = document.querySelector<HTMLFormElement>("#pairing-form")!;
const codeInput = document.querySelector<HTMLInputElement>("#pairing-code")!;
const extractButton = document.querySelector<HTMLButtonElement>("#extract")!;
const clipForm = document.querySelector<HTMLFormElement>("#clip-form")!;
const titleInput = document.querySelector<HTMLInputElement>("#title")!;
const sourceInput = document.querySelector<HTMLInputElement>("#source")!;
const markdownInput = document.querySelector<HTMLTextAreaElement>("#markdown")!;
const count = document.querySelector<HTMLElement>("#count")!;
const statusElement = document.querySelector<HTMLElement>("#status")!;
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
  const payload = await response.json().catch(() => null) as { error?: { code?: string }; token?: string; documentId?: string } | null;
  if (!response.ok) throw new Error(payload?.error?.code ?? `HTTP_${response.status}`);
  return payload ?? {};
}

async function showState() {
  const paired = Boolean(await token());
  pairPanel.hidden = paired;
  clipPanel.hidden = !paired;
}

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
    message("已配对。打开登录后的网页并点击提取。");
  } catch (error) {
    message(`配对失败：${(error as Error).message}`, true);
  }
});

extractButton.addEventListener("click", async () => {
  message("正在读取当前页面…");
  try {
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
    titleInput.value = result.title;
    sourceInput.value = result.sourceUrl;
    markdownInput.value = result.markdown;
    metadata = { author: result.author, publishedAt: result.publishedAt };
    count.textContent = `${result.markdown.length.toLocaleString()} 字符`;
    clipForm.hidden = false;
    message("请核对正文后保存。图片仅保留原链接。");
  } catch (error) {
    message((error as Error).message, true);
  }
});

clipForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  message("正在保存新副本…");
  try {
    const currentToken = await token();
    if (!currentToken) throw new Error("EXTENSION_UNAUTHORIZED");
    const response = await fetch(`${API}/api/browser-extension/clips`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${currentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceUrl: sourceInput.value.trim(),
        title: titleInput.value.trim(),
        author: metadata.author,
        publishedAt: metadata.publishedAt,
        markdown: markdownInput.value,
      }),
    });
    await responseJson(response);
    clipForm.hidden = true;
    message("已保存为织页中的新副本。");
  } catch (error) {
    const code = (error as Error).message;
    if (code === "EXTENSION_UNAUTHORIZED") {
      await webext.storage.local.remove(["token"]);
      await showState();
    }
    message(`保存失败：${code}`, true);
  }
});

markdownInput.addEventListener("input", () => {
  count.textContent = `${markdownInput.value.length.toLocaleString()} 字符`;
});

void showState();
