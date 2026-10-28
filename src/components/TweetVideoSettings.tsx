import { DEFAULT_TWEET_VIDEO_MAX_BYTES, MAX_TWEET_VIDEO_BYTES, MIN_TWEET_VIDEO_BYTES } from "../../shared/tweet-video";
import { useEffect, useState } from "react";
import { api, type TweetVideoSettingsState } from "../api";
import { Button, Input } from "./ui/Controls";

export function TweetVideoSettings() {
  const [settings, setSettings] = useState<TweetVideoSettingsState | null>(null);
  const [limitMb, setLimitMb] = useState(String(DEFAULT_TWEET_VIDEO_MAX_BYTES / 1_000_000));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async (signal?: AbortSignal) => {
    setError("");
    try {
      const value = await api.getTweetVideoSettings(signal);
      if (signal?.aborted) return;
      setSettings(value); setLimitMb(String(value.maxBytes / 1_000_000));
    } catch (cause) {
      if (!signal?.aborted) setError((cause as Error).message);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);
  const maxMb = Number(limitMb);
  const valid = limitMb.trim() !== "" && Number.isInteger(maxMb) && maxMb >= MIN_TWEET_VIDEO_BYTES / 1_000_000 && maxMb <= MAX_TWEET_VIDEO_BYTES / 1_000_000;
  const save = async () => {
    if (!settings || !valid || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const value = await api.setTweetVideoSettings({ maxBytes: maxMb * 1_000_000, revision: settings.revision });
      setSettings(value); setLimitMb(String(value.maxBytes / 1_000_000)); setNotice("已保存，后续抓取生效。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="tweet-video-settings" aria-labelledby="tweet-video-settings-title">
    <h2 id="tweet-video-settings-title">推文视频</h2>
    <label className="tweet-video-limit">每条推文视频上限<Input type="number" min={MIN_TWEET_VIDEO_BYTES / 1_000_000} max={MAX_TWEET_VIDEO_BYTES / 1_000_000} step={1} value={limitMb} disabled={!settings || busy} onChange={(event) => { setLimitMb(event.target.value); setNotice(""); }} aria-describedby="tweet-video-limit-description" /><span>MB</span></label>
    <p id="tweet-video-limit-description">按本条推文全部视频合计，范围 1–100 MB。超限只跳过视频，文字和图片照常保存。</p>
    <Button disabled={!settings || !valid || busy} onClick={() => void save()}>{busy ? "保存中…" : "保存视频设置"}</Button>
    {notice && <p role="status">{notice}</p>}
    {error && <div role="alert"><p>{error}</p><Button disabled={busy} onClick={() => void load()}>重新载入视频设置</Button></div>}
  </section>;
}
