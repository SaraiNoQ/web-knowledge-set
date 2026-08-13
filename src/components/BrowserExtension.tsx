import { useEffect, useState } from "react";
import type { BrowserExtensionPairing, BrowserExtensionPairingCode } from "../../shared/types";
import { api } from "../api";

export function BrowserExtension() {
  const [pairings, setPairings] = useState<BrowserExtensionPairing[]>([]);
  const [code, setCode] = useState<BrowserExtensionPairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = (signal?: AbortSignal) => api.getBrowserExtensionPairings(signal)
    .then(({ pairings: value }) => setPairings(value));

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .catch((cause) => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, []);

  const generate = async () => {
    setBusy(true);
    setError("");
    try { setCode(await api.createBrowserExtensionPairingCode()); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  const revoke = async (pairing: BrowserExtensionPairing) => {
    setBusy(true);
    setError("");
    try {
      await api.revokeBrowserExtensionPairing(pairing.id);
      setPairings((current) => current.filter(({ id }) => id !== pairing.id));
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="extension-help" aria-labelledby="extension-title">
    <span>02 · BROWSER CLIPPER</span>
    <h3 id="extension-title">浏览器扩展</h3>
    <p>在已登录网页中提取当前可见正文。扩展不申请 Cookie、历史或全部网页权限，只在点击时读取当前标签页。</p>
    <div className="extension-downloads">
      <a href="/extensions/zhiye-clipper-chrome.zip" download>下载 Chrome 扩展</a>
      <a href="/extensions/zhiye-clipper-firefox.zip" download>下载 Firefox 扩展</a>
    </div>
    <p>Chrome：解压后在扩展管理页选择“加载已解压的扩展程序”。Firefox：解压后在 about:debugging 临时加载 manifest.json。</p>
    <button type="button" className="guide-button" onClick={() => void generate()} disabled={busy}>生成 5 分钟配对码</button>
    <button type="button" className="guide-button" onClick={() => void load().catch((cause) => setError((cause as Error).message))} disabled={busy}>刷新配对列表</button>
    {code && <output className="extension-code" aria-live="polite"><strong>{code.code}</strong><small>仅可使用一次，{new Date(code.expiresAt).toLocaleTimeString()} 前有效</small></output>}
    {pairings.length > 0 && <ul className="extension-pairings">{pairings.map((pairing) => <li key={pairing.id}>
      <span>{pairing.browser === "chrome" ? "Chrome" : "Firefox"} · {new Date(pairing.createdAt).toLocaleDateString()}</span>
      <button type="button" onClick={() => void revoke(pairing)} disabled={busy}>撤销</button>
    </li>)}</ul>}
    <p>每次剪藏都会创建新副本；图片只保留原链接，不上传登录凭证、完整 DOM 或登录态图片字节。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
