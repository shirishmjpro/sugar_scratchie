import type { FlowNodeId, FlowWireDef, VideoFlowJson } from "./schema";

const RUN_NODE_X = 48;
const RUN_NODE_START_Y = 32;
const RUN_NODE_GAP = 108;
const RUN_CANVAS_WIDTH = 360;

function runViewNodeOrder(flow: VideoFlowJson): FlowNodeId[] {
  const ordered: FlowNodeId[] = ["source"];
  for (const step of flow.pipeline) {
    const node = flow.nodes.find((entry) => entry.step === step);
    if (node) ordered.push(node.id);
  }
  if (flow.nodes.some((node) => node.id === "output")) {
    ordered.push("output");
  }
  return ordered;
}

function runViewWires(flow: VideoFlowJson): FlowWireDef[] {
  const ordered = runViewNodeOrder(flow);
  return ordered.slice(0, -1).map((from, index) => ({
    from,
    to: ordered[index + 1]!,
  }));
}

/** Stack nodes vertically for the run-page map (does not mutate stored flow JSON). */
export function layoutFlowForRunView(flow: VideoFlowJson): VideoFlowJson {
  const order = runViewNodeOrder(flow);
  const nodes = flow.nodes.map((node) => {
    const index = order.indexOf(node.id);
    if (index < 0) return node;
    return {
      ...node,
      x: RUN_NODE_X,
      y: RUN_NODE_START_Y + index * RUN_NODE_GAP,
    };
  });
  return {
    ...flow,
    canvas: {
      width: RUN_CANVAS_WIDTH,
      height: RUN_NODE_START_Y + order.length * RUN_NODE_GAP + 48,
    },
    nodes,
    wires: runViewWires(flow),
  };
}
