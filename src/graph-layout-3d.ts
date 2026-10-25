/// <reference path="./d3-force-3d.d.ts" />
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force-3d";

export interface NetworkLayoutInput {
  nodes: Array<{ id: string; position?: [number, number, number] }>;
  links: Array<{ source: string; target: string; type: "folder" | "semantic" | "manual" }>;
}

export function layoutNetwork3D(input: NetworkLayoutInput) {
  const ids = new Set(input.nodes.map(({ id }) => id));
  if (ids.size !== input.nodes.length || input.links.some((edge) => !ids.has(edge.source) || !ids.has(edge.target))) {
    throw new TypeError("Invalid network endpoints");
  }
  const nodes = [...input.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, position }) => {
    if (position && !position.every(Number.isFinite)) throw new TypeError("Invalid network position");
    return { id, x: position?.[0], y: position?.[1], z: position?.[2] };
  });
  const links = input.links.map((edge) => ({ ...edge }));
  const simulation = forceSimulation(nodes, 3).stop()
    .force("link", forceLink(links).id((node) => node.id)
      .distance((edge) => edge.type === "folder" ? 110 : 40)
      .strength((edge) => edge.type === "folder" ? 0.045 : 0.4))
    .force("charge", forceManyBody().strength(-45))
    .force("center", forceCenter())
    .alphaDecay(0.045);
  try { simulation.tick(120); } finally { simulation.stop(); }
  const positions = Float32Array.from(nodes.flatMap(({ x, y, z }) => [x!, y!, z!]));
  if (!positions.every(Number.isFinite)) throw new TypeError("Network layout is not finite");
  return { ids: nodes.map(({ id }) => id), positions };
}
