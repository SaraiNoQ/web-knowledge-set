import assert from "node:assert/strict";
import test from "node:test";
import { layoutNetwork3D } from "../src/graph-layout-3d.js";
import type { NetworkLayoutInput } from "../src/graph-layout-3d.js";

test("network layout uses three independent axes and pulls linked communities together", () => {
  const nodes = Array.from({ length: 24 }, (_, index) => ({ id: `node-${index}` }));
  const links: NetworkLayoutInput["links"] = [];
  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (Math.floor(left / 12) === Math.floor(right / 12)) links.push({ source: nodes[left]!.id, target: nodes[right]!.id, type: "semantic" });
    }
  }
  const input = { nodes, links };
  const original = JSON.stringify(input);
  const result = layoutNetwork3D(input);
  assert.equal(JSON.stringify(input), original);
  assert.deepEqual(layoutNetwork3D(input), result);
  const points = result.ids.map((_, index) => Array.from(result.positions.slice(index * 3, index * 3 + 3)));
  for (let axis = 0; axis < 3; axis += 1) {
    const values = points.map((point) => point[axis]!);
    assert.ok(Math.max(...values) - Math.min(...values) > 20);
  }
  const byId = new Map(result.ids.map((id, index) => [id, points[index]!]));
  const distance = (left: string, right: string) => Math.hypot(...byId.get(left)!.map((value, axis) => value - byId.get(right)![axis]!));
  const linked = links.reduce((sum, link) => sum + distance(link.source, link.target), 0) / links.length;
  const unrelated = nodes.slice(0, 12).reduce((sum, node, index) => sum + distance(node.id, nodes[index + 12]!.id), 0) / 12;
  assert.ok(linked < unrelated, "network relationships must affect spatial layout");
  const a = points[0]!, b = points[1]!, c = points[2]!, d = points[3]!;
  const u = b.map((value, axis) => value - a[axis]!);
  const v = c.map((value, axis) => value - a[axis]!);
  const w = d.map((value, axis) => value - a[axis]!);
  const volume = u[0]! * (v[1]! * w[2]! - v[2]! * w[1]!) - u[1]! * (v[0]! * w[2]! - v[2]! * w[0]!) + u[2]! * (v[0]! * w[1]! - v[1]! * w[0]!);
  assert.ok(Math.abs(volume) > 1, "the network must not lie on a plane");
});

test("network layout rejects invalid endpoints and cached coordinates", () => {
  assert.throws(() => layoutNetwork3D({ nodes: [{ id: "a" }, { id: "a" }], links: [] }));
  assert.throws(() => layoutNetwork3D({ nodes: [{ id: "a" }], links: [{ source: "a", target: "missing", type: "folder" }] }));
  assert.throws(() => layoutNetwork3D({ nodes: [{ id: "a", position: [0, 0, NaN] }], links: [] }));
});
