import { Button } from "./ui/Controls";
import { useEffect, useState } from "react";
import type { BrowserExtensionPairing, BrowserExtensionPairingCode } from "../../shared/types";
import { api } from "../api";

export function BrowserExtension({ onPairingCountChange }: { onPairingCountChange?: (count: number) => void }) {
  const [pairings, setPairings] = useState<BrowserExtensionPairing[]>([]);
  const [code, setCode] = useState<BrowserExtensionPairingCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = (signal?: AbortSignal) => api.getBrowserExtensionPairings(signal)
    .then(({ pairings: value }) => {
      setPairings(value);
      onPairingCountChange?.(value.length);
    });

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
      setPairings((current) => {
        const next = current.filter(({ id }) => id !== pairing.id);
        onPairingCountChange?.(next.length);
        return next;
      });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };

  return <section className="extension-help" aria-labelledby="extension-title">
    <span>02 · BROWSER CLIPPER</span>
    <h3 id="extension-title">浏览助手</h3>
    <div className="extension-downloads">
      <a href="/extensions/zhiye-clipper-chrome.zip?v=0.3.10" download>下载 Chrome 扩展 0.3.10</a>
      <a href="/extensions/zhiye-clipper-firefox.xpi?v=0.3.10" download>下载 Firefox 扩展 0.3.10</a>
    </div>
    <p className="extension-help__single-line" tabIndex={0}>Chrome：覆盖旧文件夹，重新加载扩展。</p>
    <p className="extension-help__single-line" tabIndex={0}>Firefox：下载 XPI，在扩展管理页安装。</p>
    <div className="extension-actions">
      <Button type="button" className="primary-button" onClick={() => void generate()} disabled={busy}>{busy ? "生成中…" : "连接码"}</Button>
      <Button type="button" className="guide-button" onClick={() => void load().catch((cause) => setError((cause as Error).message))} disabled={busy}>刷新连接</Button>
    </div>
    {code ? <div className="extension-code" role="status" aria-live="polite"><strong>{code.code}</strong><small>仅可使用一次，{new Date(code.expiresAt).toLocaleTimeString()} 前有效</small></div> : <p className="extension-code-empty">点击“连接码”生成，五分钟内有效。</p>}
    {pairings.length > 0 && <ul className="extension-pairings">{pairings.map((pairing) => <li key={pairing.id}>
      <span>{pairing.browser === "chrome" ? "Chrome" : "Firefox"} · {new Date(pairing.createdAt).toLocaleDateString()}</span>
      <Button type="button" onClick={() => void revoke(pairing)} disabled={busy}>断开连接</Button>
    </li>)}</ul>}
    <p className="extension-help__single-line" tabIndex={0}>仅向 clip.sarainoq.cn 保存新织片。保存后会通知已打开的织页刷新列表。图片会尝试缓存，失败时保留链接。不上传登录凭证、完整网页结构。不上传需登录才能读取的图片内容。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
