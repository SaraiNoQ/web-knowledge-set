import { useState } from "react";
import { api } from "../api";

export function TweetVideoPlayer({ hash, label }: { hash: string; label: string }) {
  const [failed, setFailed] = useState(false);
  const source = api.assetUrl(hash);
  return <span className="tweet-video-player">
    <video controls playsInline preload="metadata" src={source} aria-label={label} onError={() => setFailed(true)} />
    {failed && <span role="status">视频暂不可播放，可下载后查看。</span>}
    <a href={source} download={`${label}.mp4`}>下载{label}</a>
  </span>;
}
