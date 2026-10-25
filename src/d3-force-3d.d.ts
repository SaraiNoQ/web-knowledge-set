declare module "d3-force-3d" {
  export interface SimulationNodeDatum { id: string; x?: number; y?: number; z?: number; }
  interface Simulation<Node extends SimulationNodeDatum> {
    stop(): this;
    force(name: string, force: unknown): this;
    alphaDecay(value: number): this;
    tick(iterations: number): this;
    nodes(): Node[];
  }
  interface LinkForce<Link> {
    id(accessor: (node: SimulationNodeDatum) => string): this;
    distance(value: number | ((link: Link) => number)): this;
    strength(value: number | ((link: Link) => number)): this;
  }
  export function forceSimulation<Node extends SimulationNodeDatum>(nodes: Node[], dimensions: number): Simulation<Node>;
  export function forceLink<Link>(links: Link[]): LinkForce<Link>;
  export function forceManyBody(): { strength(value: number): unknown };
  export function forceCenter(): unknown;
}
