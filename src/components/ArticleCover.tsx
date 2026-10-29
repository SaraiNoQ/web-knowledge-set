import { useState } from "react";
import type { HomeCard } from "../../shared/home";
import { api } from "../api";

export function ArticleCover({ article, preview = false }: { article: HomeCard; preview?: boolean }) {
  const [failedHash, setFailedHash] = useState<string | null>(null);
  const title = article.shortTitle || article.title;
  const showImage = article.coverHash && article.coverHash !== failedHash;
  return <span className={`article-cover article-cover--${article.color}${showImage ? " article-cover--image" : ""}`}>
    {showImage ? <img src={api.homeCoverUrl(article.coverHash!)} alt={preview ? `${article.title}的封面预览` : ""} loading={preview ? "eager" : "lazy"} decoding="async" style={{ objectFit: article.fit }} onError={() => setFailedHash(article.coverHash)} /> : <span className="article-cover-type" aria-hidden={!preview}>
      <span className="article-cover-category">{article.folderName || "未分组"}</span>
      <span className={`article-cover-title${title.length > 30 ? " is-long" : ""}`}>{title}</span>
      <span className="article-cover-imprint">织页</span>
    </span>}
  </span>;
}
