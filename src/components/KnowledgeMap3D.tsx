import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Ref, RefObject } from "react";
import {
  BufferAttribute, BufferGeometry, CanvasTexture, Color,
  LineBasicMaterial, LineDashedMaterial, LineSegments,
  PerspectiveCamera, Plane, Points, PointsMaterial, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { MapLink, MapNode } from "./KnowledgeMap";
import type { NetworkLayoutInput } from "../graph-layout-3d";

type Point3 = [number, number, number];
type CameraView = { position: Point3; target: Point3 };
export interface Map3DState {
  positions: Map<string, Point3>;
  camera: CameraView | null;
  overview: CameraView | null;
  scope: string;
  layoutKey: string;
}
export interface Map3DHandle { fit(): void; }
interface Props {
  ref: Ref<Map3DHandle>;
  data: { nodes: MapNode[]; links: MapLink[] };
  state: RefObject<Map3DState>;
  width: number;
  height: number;
  active: boolean;
  paused: boolean;
  dark: boolean;
  selectedId: string | null;
  scope: string;
  onSelect: (node: MapNode) => void;
  onUnavailable: () => void;
}
type NodeBatch = Points<BufferGeometry, PointsMaterial>;
type NodeInstance = { node: MapNode; mesh: NodeBatch; index: number; point: Point3 };
type EdgeEnd = { attribute: BufferAttribute; vertex: number };
type Runtime = {
  rebuild(): void;
  appearance(): void;
  resize(): void;
  visibility(): void;
  fit(): void;
  view(): CameraView;
  restore(view: CameraView): void;
};

function endpoint(value: string | MapNode) { return typeof value === "string" ? value : value.id; }

export default function KnowledgeMap3D(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const runtime = useRef<Runtime | null>(null);
  const layoutPending = useRef(true);
  const appliedLayout = useRef(false);
  const appliedData = useRef<Props["data"] | null>(null);
  const layoutSequence = useRef(0);
  const [layoutBusy, setLayoutBusy] = useState(true);
  useImperativeHandle(props.ref, () => ({ fit: () => runtime.current?.fit() }), []);

  useEffect(() => {
    const container = host.current!;
    const labelLayer = labels.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: false, powerPreference: "low-power" });
    } catch {
      latest.current.onUnavailable();
      return;
    }
    const fullPixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    renderer.setPixelRatio(latest.current.data.nodes.length > 400 ? Math.min(fullPixelRatio, 1) : fullPixelRatio);
    const canvas = renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("aria-label", "三维知识地图，也可通过资料列表选择资料");
    container.prepend(canvas);
    const scene = new Scene();
    const camera = new PerspectiveCamera(50, 1, 0.1, 100_000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.listenToKeyEvents(canvas);
    const cache = latest.current.state.current;
    const instances = new Map<string, NodeInstance>();
    const batches: NodeBatch[] = [];
    const lines: LineSegments[] = [];
    const edgeEnds = new Map<string, EdgeEnd[]>();
    const nodeLabels = new Map<string, HTMLSpanElement>();
    const color = new Color();
    const labelMeasure = document.createElement("canvas").getContext("2d");
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    const projected = new Vector3();
    const dragPlane = new Plane();
    const dragPoint = new Vector3();
    let frame = 0;
    let pickFrame = 0;
    let hovered: string | null = null;
    let down: { id: string; x: number; y: number; moved: boolean } | null = null;
    let oldHighlights = new Set<string>();
    let oldDark: boolean | undefined;
    const visible = () => latest.current.active && !document.hidden && !layoutPending.current;
    const enabled = () => visible() && !latest.current.paused;

    const requestRender = () => {
      if (frame || !visible()) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!latest.current.paused) controls.update();
        renderer.render(scene, camera);
        const occupied: Array<{ left: number; top: number; right: number; bottom: number }> = [];
        for (const [id, label] of nodeLabels) {
          const instance = instances.get(id)!;
          projected.fromArray(instance.point).project(camera);
          const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1;
          const left = (projected.x + 1) * latest.current.width / 2 + 10, top = (1 - projected.y) * latest.current.height / 2;
          const rect = { left, top, right: left + Number(label.dataset.labelWidth), bottom: top + 22 };
          const collision = occupied.some((other) => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top);
          label.hidden = !visible || collision;
          if (visible && !collision) { occupied.push(rect); label.style.transform = `translate(${left}px,${top}px)`; }
        }
      });
    };
    const view = (): CameraView => ({ position: camera.position.toArray(), target: controls.target.toArray() });
    const restore = (saved: CameraView) => {
      camera.position.fromArray(saved.position);
      controls.target.fromArray(saved.target);
      controls.update();
      requestRender();
    };
    const fit = () => {
      if (!instances.size) return;
      const center = new Vector3();
      for (const { point } of instances.values()) center.add(projected.fromArray(point));
      center.divideScalar(instances.size);
      let radius = 20;
      for (const { point } of instances.values()) radius = Math.max(radius, projected.fromArray(point).distanceTo(center) + 10);
      const angle = Math.min(camera.fov, camera.fov * camera.aspect) * Math.PI / 360;
      const distance = radius / Math.sin(angle) * 1.15;
      const direction = camera.position.clone().sub(controls.target).normalize();
      if (!direction.lengthSq()) direction.set(0, 0, 1);
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(direction, distance);
      controls.update();
      requestRender();
    };
    const updateMatrix = (instance: NodeInstance) => {
      const { node, mesh, index, point } = instance;
      const selected = node.id === latest.current.selectedId;
      color.set(selected || node.id === hovered ? (latest.current.dark ? "#f08a72" : "#b64b3b") : node.color);
      mesh.geometry.getAttribute("position").setXYZ(index, ...point);
      mesh.geometry.getAttribute("color").setXYZ(index, color.r, color.g, color.b);
      mesh.geometry.getAttribute("position").needsUpdate = true;
      mesh.geometry.getAttribute("color").needsUpdate = true;
    };
    const appearance = () => {
      const highlights = new Set([latest.current.selectedId, hovered].filter((id): id is string => Boolean(id)));
      const changed = oldDark !== latest.current.dark ? instances.keys() : new Set([...oldHighlights, ...highlights]);
      for (const id of changed) { const instance = instances.get(id); if (instance) updateMatrix(instance); }
      oldDark = latest.current.dark;
      oldHighlights = highlights;
      for (const line of lines) {
        const material = line.material as LineBasicMaterial;
        material.color.set(line.userData.type === "manual" ? (latest.current.dark ? "#f08a72" : "#b64b3b") : line.userData.type === "citation" ? (latest.current.dark ? "#8fb9df" : "#32678f") : line.userData.type === "tag" ? (latest.current.dark ? "#a9c39b" : "#537343") : line.userData.type === "lexical" ? (latest.current.dark ? "#d6ba87" : "#846832") : line.userData.semantic ? (latest.current.dark ? "#bba2d5" : "#675d85") : (latest.current.dark ? "#c5bdae" : "#6d6758"));
      }
      nodeLabels.clear();
      labelLayer.replaceChildren();
      const labelStyle = getComputedStyle(labelLayer);
      if (labelMeasure) labelMeasure.font = `${labelStyle.getPropertyValue("--font-caption") || "12px"} ${labelStyle.getPropertyValue("--font-sans") || "sans-serif"}`;
      const selected = latest.current.selectedId;
      const peers = latest.current.data.links.flatMap((edge) => endpoint(edge.source) === selected ? [endpoint(edge.target)] : endpoint(edge.target) === selected ? [endpoint(edge.source)] : []).slice(0, 8);
      const ids = new Set([...highlights, ...peers, ...latest.current.data.nodes.filter((node) => node.type === "folder").slice(0, 20).map(({ id }) => id)]);
      for (const id of ids) {
        const instance = instances.get(id);
        if (!instance) continue;
        const node = instance.node;
        const title = node.type === "folder" ? `${node.name} · ${node.count}` : node.title || "未命名资料";
        const label = document.createElement("span");
        label.hidden = true;
        label.textContent = title.length > 28 ? title.slice(0, 27) + "…" : title;
        label.dataset.labelWidth = String(Math.min(230, (labelMeasure?.measureText(label.textContent).width ?? Array.from(label.textContent).length * 12) + 8));
        labelLayer.append(label);
        nodeLabels.set(id, label);
      }
      requestRender();
    };
    const disposeGraph = () => {
      for (const mesh of batches) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.material.map?.dispose();
      }
      for (const line of lines) { scene.remove(line); line.geometry.dispose(); (line.material as LineBasicMaterial).dispose(); }
      batches.length = 0;
      lines.length = 0;
      instances.clear();
      edgeEnds.clear();
    };
    const rebuild = () => {
      down = null;
      hovered = null;
      controls.enabled = enabled();
      disposeGraph();
      const data = latest.current.data;
      const pixelRatio = data.nodes.length > 400 ? Math.min(fullPixelRatio, 1) : fullPixelRatio;
      if (renderer.getPixelRatio() !== pixelRatio) renderer.setPixelRatio(pixelRatio);
      for (const kind of ["folder", "article", "paper"] as const) {
        const nodes = data.nodes.filter((node) => node.type === "folder" ? kind === "folder" : node.kind === kind);
        if (!nodes.length) continue;
        const sprite = document.createElement("canvas");
        sprite.width = sprite.height = 16;
        const context = sprite.getContext("2d")!;
        context.fillStyle = context.strokeStyle = "white";
        if (kind === "article") { context.arc(8, 8, 7, 0, Math.PI * 2); context.fill(); }
        else if (kind === "folder") { context.lineWidth = 2; context.strokeRect(1, 1, 14, 14); }
        else context.fillRect(2, 2, 12, 12);
        const geometry = new BufferGeometry()
          .setAttribute("position", new BufferAttribute(new Float32Array(nodes.length * 3), 3))
          .setAttribute("color", new BufferAttribute(new Float32Array(nodes.length * 3), 3));
        const mesh = new Points(geometry, new PointsMaterial({ map: new CanvasTexture(sprite), vertexColors: true, size: kind === "folder" ? 10 : 6, sizeAttenuation: false, alphaTest: 0.5 }));
        nodes.forEach((node, index) => {
          const point = cache.positions.get(node.id);
          if (!point) throw new Error("Missing three-dimensional network layout");
          const instance = { node, mesh, index, point };
          instances.set(node.id, instance);
          updateMatrix(instance);
        });
        mesh.geometry.computeBoundingSphere();
        batches.push(mesh);
        scene.add(mesh);
      }
      for (const type of ["folder", "semantic", "manual", "tag", "citation", "lexical"] as const) {
        const semantic = type === "semantic";
        const edges = data.links.filter((edge) => edge.type === type);
        const positions: number[] = [];
        const ends: Array<{ id: string; vertex: number }> = [];
        for (const edge of edges) {
          const source = instances.get(endpoint(edge.source));
          const target = instances.get(endpoint(edge.target));
          if (!source || !target) continue;
          ends.push({ id: source.node.id, vertex: positions.length / 3 }, { id: target.node.id, vertex: positions.length / 3 + 1 });
          positions.push(...source.point, ...target.point);
        }
        if (!positions.length) continue;
        const attribute = new BufferAttribute(new Float32Array(positions), 3);
        const geometry = new BufferGeometry().setAttribute("position", attribute);
        const line = new LineSegments(geometry, semantic ? new LineDashedMaterial({ dashSize: 3, gapSize: 2, transparent: true, opacity: 0.6 }) : new LineBasicMaterial({ transparent: true, opacity: 0.4 }));
        line.userData.semantic = semantic;
        line.userData.type = type;
        if (semantic) line.computeLineDistances();
        line.frustumCulled = false;
        for (const end of ends) { const list = edgeEnds.get(end.id) ?? []; list.push({ attribute, vertex: end.vertex }); edgeEnds.set(end.id, list); }
        lines.push(line);
        scene.add(line);
      }
      oldDark = undefined;
      appearance();
      requestRender();
    };
    const resize = () => {
      if (!latest.current.active) return;
      const pixelRatio = renderer.getPixelRatio();
      if (canvas.width !== Math.floor(latest.current.width * pixelRatio) || canvas.height !== Math.floor(latest.current.height * pixelRatio)) {
        renderer.setSize(latest.current.width, latest.current.height, false);
      }
      camera.aspect = latest.current.width / latest.current.height;
      camera.updateProjectionMatrix();
      requestRender();
    };
    const visibility = () => {
      controls.enabled = enabled();
      if (!visible()) { cancelAnimationFrame(frame); cancelAnimationFrame(pickFrame); frame = 0; pickFrame = 0; }
      else { resize(); requestRender(); }
    };
    const cast = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      raycaster.params.Points.threshold = camera.position.distanceTo(controls.target) * Math.tan(camera.fov * Math.PI / 360) * 8 / latest.current.height;
      const hit = raycaster.intersectObjects(batches, false)[0];
      const index = hit?.index;
      return hit && index !== undefined ? [...instances.values()].find((instance) => instance.mesh === hit.object && instance.index === index) : undefined;
    };
    const pointerDown = (event: PointerEvent) => {
      if (!enabled() || event.button !== 0) return;
      const hit = cast(event);
      if (!hit) return;
      down = { id: hit.node.id, x: event.clientX, y: event.clientY, moved: false };
      controls.enabled = false;
      dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(projected), dragPoint.fromArray(hit.point));
      canvas.setPointerCapture(event.pointerId);
      event.stopImmediatePropagation();
    };
    const pointerMove = (event: PointerEvent) => {
      if (!enabled()) return;
      if (down) {
        if (Math.hypot(event.clientX - down.x, event.clientY - down.y) < 4 && !down.moved) return;
        cast(event);
        if (!raycaster.ray.intersectPlane(dragPlane, dragPoint)) return;
        down.moved = true;
        const instance = instances.get(down.id)!;
        dragPoint.toArray(instance.point);
        updateMatrix(instance);
        instance.mesh.geometry.computeBoundingSphere();
        for (const end of edgeEnds.get(down.id) ?? []) { end.attribute.setXYZ(end.vertex, ...instance.point); end.attribute.needsUpdate = true; }
        requestRender();
      } else if (!event.buttons && !pickFrame) {
        pickFrame = requestAnimationFrame(() => {
          pickFrame = 0;
          const id = cast(event)?.node.id ?? null;
          if (id !== hovered) { hovered = id; canvas.style.cursor = id ? "pointer" : "grab"; appearance(); }
        });
      }
    };
    const pointerUp = (event: PointerEvent) => {
      if (!down) return;
      const picked = down;
      down = null;
      controls.enabled = enabled();
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (picked.moved) {
        for (const line of lines.filter((line) => line.userData.semantic)) {
          const position = line.geometry.getAttribute("position");
          const distance = line.geometry.getAttribute("lineDistance");
          for (let vertex = 0; vertex < position.count; vertex += 2) {
            const length = projected.fromBufferAttribute(position, vertex).distanceTo(dragPoint.fromBufferAttribute(position, vertex + 1));
            const start = vertex ? distance.getX(vertex - 1) : 0;
            distance.setX(vertex, start);
            distance.setX(vertex + 1, start + length);
          }
          distance.needsUpdate = true;
        }
        requestRender();
      }
      if (event.type === "pointerup" && !picked.moved) latest.current.onSelect(instances.get(picked.id)!.node);
    };
    const pointerLeave = () => {
      cancelAnimationFrame(pickFrame);
      pickFrame = 0;
      if (!down && hovered) { hovered = null; canvas.style.cursor = "grab"; appearance(); }
    };
    const contextLost = (event: Event) => { event.preventDefault(); latest.current.onUnavailable(); };
    canvas.addEventListener("pointerdown", pointerDown, true);
    canvas.addEventListener("pointermove", pointerMove);
    canvas.addEventListener("pointerup", pointerUp);
    canvas.addEventListener("pointercancel", pointerUp);
    canvas.addEventListener("pointerleave", pointerLeave);
    canvas.addEventListener("webglcontextlost", contextLost);
    controls.addEventListener("change", requestRender);
    document.addEventListener("visibilitychange", visibility);
    runtime.current = { rebuild, appearance, resize, visibility, fit, view, restore };
    resize();
    if (cache.camera) restore(cache.camera);
    else camera.position.set(100, 70, 300);
    visibility();
    return () => {
      cache.camera = view();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(pickFrame);
      canvas.removeEventListener("pointerdown", pointerDown, true);
      canvas.removeEventListener("pointermove", pointerMove);
      canvas.removeEventListener("pointerup", pointerUp);
      canvas.removeEventListener("pointercancel", pointerUp);
      canvas.removeEventListener("pointerleave", pointerLeave);
      canvas.removeEventListener("webglcontextlost", contextLost);
      document.removeEventListener("visibilitychange", visibility);
      controls.removeEventListener("change", requestRender);
      controls.dispose();
      disposeGraph();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.width = canvas.height = 0;
      canvas.remove();
      labelLayer.replaceChildren();
      runtime.current = null;
    };
  }, []);

  useEffect(() => {
    if (!props.active || !runtime.current) return;
    const cache = props.state.current;
    const data = props.data;
    const links: NetworkLayoutInput["links"] = data.links.map((edge) => ({
      source: endpoint(edge.source), target: endpoint(edge.target), type: edge.type,
    }));
    const key = JSON.stringify([data.nodes.map(({ id }) => id).sort(), links.map((edge) => JSON.stringify(edge)).sort()]);
    const changed = cache.layoutKey !== key;
    const reusable = !changed && data.nodes.every(({ id }) => cache.positions.has(id));
    const scopeChanged = cache.scope !== props.scope;
    if (scopeChanged && cache.scope === "all") {
      if (appliedLayout.current) cache.overview = runtime.current.view();
      else if (cache.camera) cache.overview = cache.camera;
    }
    const restoreView = props.scope === "all" && scopeChanged ? cache.overview : null;
    const apply = () => {
      try {
        layoutPending.current = false;
        if (appliedData.current !== data || !reusable) runtime.current!.rebuild();
        if (restoreView) runtime.current!.restore(restoreView);
        else if (changed || (!appliedLayout.current && !cache.camera)) runtime.current!.fit();
        runtime.current!.visibility();
        cache.layoutKey = key;
        cache.scope = props.scope;
        appliedLayout.current = true;
        appliedData.current = data;
        setLayoutBusy(false);
      } catch { latest.current.onUnavailable(); }
    };
    if (reusable) { apply(); return; }
    layoutPending.current = true;
    setLayoutBusy(true);
    runtime.current.visibility();
    const requestId = ++layoutSequence.current;
    const worker = new Worker(new URL("../graph-layout-3d-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data: message }: MessageEvent<{ requestId: number; error?: boolean; ids: string[]; positions: Float32Array }>) => {
      if (message.requestId !== requestId || latest.current.data !== data || !latest.current.active) return;
      const expected = new Set(data.nodes.map(({ id }) => id));
      if (message.error || message.ids.length !== expected.size || message.positions.length !== expected.size * 3 ||
        new Set(message.ids).size !== expected.size || message.ids.some((id) => !expected.has(id)) || !message.positions.every(Number.isFinite)) {
        latest.current.onUnavailable();
        return;
      }
      message.ids.forEach((id, index) => cache.positions.set(id, [message.positions[index * 3]!, message.positions[index * 3 + 1]!, message.positions[index * 3 + 2]!]));
      apply();
      worker.terminate();
    };
    worker.onerror = () => latest.current.onUnavailable();
    worker.postMessage({ requestId, data: { nodes: data.nodes.map(({ id }) => ({ id, position: cache.positions.get(id) })), links } });
    return () => worker.terminate();
  }, [props.data, props.scope, props.active, props.state]);
  useEffect(() => { runtime.current?.appearance(); }, [props.selectedId, props.dark]);
  useEffect(() => { runtime.current?.resize(); }, [props.width, props.height]);
  useEffect(() => { runtime.current?.visibility(); }, [props.active, props.paused]);
  return <div className="map-3d" ref={host} aria-busy={layoutBusy}><div className="map-3d-labels" ref={labels} aria-hidden="true" />{layoutBusy && <p className="map-loading" role="status">正在布局三维网络…</p>}</div>;
}
