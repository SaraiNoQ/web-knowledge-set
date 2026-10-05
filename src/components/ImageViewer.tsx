import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "./ui/Modal";
import { Button, IconButton } from "./ui/Controls";
import { WorkspaceIcon } from "./ui/WorkspaceIcon";

export function CachedImage({ src, alt = "", onError }: { src: string; alt?: string; onError: () => void }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return <span className="offline-image">
    <button type="button" className="image-viewer-trigger" aria-label={`查看图片：${alt || "正文图片"}`} disabled={!loaded} onClick={() => setOpen(true)}>
      <img src={src} alt={alt} loading="lazy" onLoad={() => setLoaded(true)} onError={onError} />
    </button>
    {open && <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} />}
  </span>;
}

function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(1);
  const [flipY, setFlipY] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const rotated = rotation % 180 !== 0;
  const fit = size.width && viewport.width ? Math.min(1, (viewport.width - 32) / (rotated ? size.height : size.width), (viewport.height - 32) / (rotated ? size.width : size.height)) : 1;
  const scale = Math.max(.01, fit) * zoom;
  const maxZoom = Math.max(8, 1 / Math.max(.01, fit));
  const filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); setZoom((value) => Math.max(.25, Math.min(maxZoom, value * (event.deltaY < 0 ? 1.15 : 1 / 1.15)))); };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => stage.removeEventListener("wheel", wheel);
  }, [maxZoom]);
  const reset = () => {
    setZoom(1); setRotation(0); setFlipX(1); setFlipY(1); setPan({ x: 0, y: 0 });
    setBrightness(100); setContrast(100); setError("");
  };
  const changeZoom = (value: number) => setZoom(Math.max(.25, Math.min(maxZoom, value)));
  const exportImage = async () => {
    const image = imageRef.current;
    if (!image?.naturalWidth || exporting) return;
    setError(""); setExporting(true);
    try {
      // ponytail: cap canvas memory at 32 megapixels; use tiled export if larger images need editing.
      if (size.width * size.height > 32_000_000 || Math.max(size.width, size.height) > 16384) throw new Error("图片过大，暂不支持导出编辑副本。仍可查看原图。");
      const canvas = document.createElement("canvas");
      canvas.width = rotated ? size.height : size.width;
      canvas.height = rotated ? size.width : size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法创建图片，请重试。");
      const canvasFilters = typeof context.filter === "string";
      if (canvasFilters) context.filter = filter;
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(rotation * Math.PI / 180);
      context.scale(flipX, flipY);
      context.drawImage(image, -size.width / 2, -size.height / 2);
      if (!canvasFilters && (brightness !== 100 || contrast !== 100)) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let index = 0; index < pixels.data.length; index += 4) {
          for (let channel = 0; channel < 3; channel += 1) pixels.data[index + channel] = (Math.min(255, pixels.data[index + channel] * brightness / 100) - 127.5) * contrast / 100 + 127.5;
        }
        context.putImageData(pixels, 0, 0);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("图片导出失败，请重试。")), "image/png"));
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "zhiye-image-edited.png";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "图片导出失败，请重试。"); }
    finally { setExporting(false); }
  };
  return createPortal(<Modal open panel={false} className="image-viewer" title="图片查看器" onClose={onClose}>
    <header className="image-viewer-header"><div><strong>{alt || "正文图片"}</strong><small>{size.width ? `${size.width} × ${size.height} · 编辑后另存为 PNG，原图保留` : "正在加载图片…"}</small></div><IconButton label="关闭图片查看器" onClick={onClose}><WorkspaceIcon name="close" /></IconButton></header>
    <div className="image-viewer-toolbar" role="group" aria-label="图片工具">
      <IconButton label="缩小图片" disabled={zoom <= .25} onClick={() => changeZoom(zoom / 1.25)}><WorkspaceIcon name="zoomOut" /></IconButton>
      <output aria-label="图片缩放比例">{Math.round(scale * 100)}%</output>
      <IconButton label="放大图片" disabled={zoom >= maxZoom} onClick={() => changeZoom(zoom * 1.25)}><WorkspaceIcon name="zoomIn" /></IconButton>
      <Button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>适应窗口</Button>
      <Button onClick={() => { setZoom(1 / Math.max(.01, fit)); setPan({ x: 0, y: 0 }); }}>原始尺寸</Button>
      <IconButton label="向右旋转图片" onClick={() => { setRotation((rotation + 90) % 360); setPan({ x: 0, y: 0 }); }}><WorkspaceIcon name="rotate" /></IconButton>
      <IconButton label="水平翻转图片" aria-pressed={flipX === -1} onClick={() => setFlipX(-flipX)}><WorkspaceIcon name="flipHorizontal" /></IconButton>
      <IconButton label="垂直翻转图片" aria-pressed={flipY === -1} onClick={() => setFlipY(-flipY)}><WorkspaceIcon name="flipVertical" /></IconButton>
      <Button onClick={reset}>重置图片</Button>
      <Button disabled={!size.width || exporting} onClick={() => void exportImage()}>{exporting ? "正在导出…" : "导出 PNG 副本"}</Button>
    </div>
    <div ref={stageRef} className="image-viewer-stage" role="region" aria-label="图片画布" tabIndex={0}
      onKeyDown={(event) => {
        if (["+", "=", "-", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) event.preventDefault();
        if (event.key === "+" || event.key === "=") changeZoom(zoom * 1.25);
        if (event.key === "-") changeZoom(zoom / 1.25);
        if (event.key === "0") { setZoom(1); setPan({ x: 0, y: 0 }); }
        if (event.key.startsWith("Arrow")) setPan({ x: pan.x + (event.key === "ArrowLeft" ? -40 : event.key === "ArrowRight" ? 40 : 0), y: pan.y + (event.key === "ArrowUp" ? -40 : event.key === "ArrowDown" ? 40 : 0) });
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { x: event.clientX, y: event.clientY, originX: pan.x, originY: pan.y };
      }}
      onPointerMove={(event) => { const drag = dragRef.current; if (drag) setPan({ x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }); }}
      onPointerUp={() => { dragRef.current = null; }} onPointerCancel={() => { dragRef.current = null; }} onLostPointerCapture={() => { dragRef.current = null; }}>
      <img ref={imageRef} src={src} alt={alt || "正文图片"} draggable={false} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setError("图片无法读取，请关闭后重试。")} style={{ width: size.width || undefined, height: size.height || undefined, transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${scale * flipX}, ${scale * flipY})`, filter }} />
    </div>
    <footer className="image-viewer-footer"><label>亮度 <input type="range" min={0} max={200} value={brightness} onChange={(event) => setBrightness(event.currentTarget.valueAsNumber)} /> <output>{brightness}%</output></label><label>对比度 <input type="range" min={0} max={200} value={contrast} onChange={(event) => setContrast(event.currentTarget.valueAsNumber)} /> <output>{contrast}%</output></label><small>拖动平移 · 画布内 + / − 缩放 · Esc 关闭</small>{error && <p role="alert">{error}</p>}</footer>
  </Modal>, document.body);
}
