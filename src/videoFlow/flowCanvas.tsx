import { Badge } from "@radix-ui/themes";
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  type FlowNodeDef,
  type FlowNodeId,
  type FlowWireDef,
  type VideoFlowJson,
} from "./schema";

export type FlowNodeRuntime =
  | "idle"
  | "locked"
  | "ready"
  | "running"
  | "review"
  | "approved"
  | "failed";

export function flowNodeCenterRight(node: FlowNodeDef) {
  return { x: node.x + FLOW_NODE_WIDTH, y: node.y + FLOW_NODE_HEIGHT / 2 };
}

export function flowNodeCenterLeft(node: FlowNodeDef) {
  return { x: node.x, y: node.y + FLOW_NODE_HEIGHT / 2 };
}

export function flowWirePath(from: FlowNodeDef, to: FlowNodeDef) {
  const start = flowNodeCenterRight(from);
  const end = flowNodeCenterLeft(to);
  const dx = Math.max(48, (end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + dx} ${start.y}, ${end.x - dx} ${end.y}, ${end.x} ${end.y}`;
}

export function flowStepBadge(status: FlowNodeRuntime) {
  switch (status) {
    case "locked":
      return { label: "Locked", color: "gray" as const };
    case "ready":
      return { label: "Ready", color: "blue" as const };
    case "review":
      return { label: "Preview", color: "amber" as const };
    case "approved":
      return { label: "Done", color: "green" as const };
    case "running":
      return { label: "Running", color: "blue" as const };
    case "failed":
      return { label: "Failed", color: "red" as const };
    default:
      return { label: "Setup", color: "gray" as const };
  }
}

export function flowWirePathVertical(from: FlowNodeDef, to: FlowNodeDef) {
  const start = { x: from.x + FLOW_NODE_WIDTH / 2, y: from.y + FLOW_NODE_HEIGHT };
  const end = { x: to.x + FLOW_NODE_WIDTH / 2, y: to.y };
  const dy = Math.max(32, (end.y - start.y) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x} ${start.y + dy}, ${end.x} ${end.y - dy}, ${end.x} ${end.y}`;
}

type FlowCanvasProps = {
  flow: VideoFlowJson;
  nodeStates?: Partial<Record<FlowNodeId, FlowNodeRuntime>>;
  activeNode?: FlowNodeId;
  onNodeClick?: (nodeId: FlowNodeId) => void;
  readOnly?: boolean;
  wireLayout?: "horizontal" | "vertical";
};

export function FlowCanvas({
  flow,
  nodeStates,
  activeNode,
  onNodeClick,
  readOnly = false,
  wireLayout = "horizontal",
}: FlowCanvasProps) {
  const nodeById = Object.fromEntries(flow.nodes.map((node) => [node.id, node])) as Record<
    FlowNodeId,
    FlowNodeDef
  >;

  return (
    <div className="flow-board flow-board--canvas">
      <div
        className="flow-canvas"
        style={{
          width: flow.canvas.width,
          height: flow.canvas.height,
        }}
      >
        <svg
          aria-hidden="true"
          className="flow-wires"
          viewBox={`0 0 ${flow.canvas.width} ${flow.canvas.height}`}
        >
          {flow.wires.map((wire: FlowWireDef) => {
            const from = nodeById[wire.from];
            const to = nodeById[wire.to];
            if (!from || !to) return null;
            const path =
              wireLayout === "vertical"
                ? flowWirePathVertical(from, to)
                : flowWirePath(from, to);
            const fromStatus = nodeStates?.[wire.from];
            const active =
              fromStatus === "running" ||
              nodeStates?.[wire.to] === "running" ||
              fromStatus === "approved" ||
              fromStatus === "review";
            return (
              <path
                key={`${wire.from}-${wire.to}`}
                className={[
                  "flow-wire",
                  wire.dashed ? "flow-wire--dashed" : "",
                  active ? "flow-wire--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                d={path}
              />
            );
          })}
        </svg>

        {flow.nodes.map((node) => {
          const status = nodeStates?.[node.id] ?? (readOnly ? "idle" : "ready");
          const badge = flowStepBadge(status);
          const isActive = activeNode === node.id;
          const isOutput = node.id === "output";
          const Tag = readOnly || !onNodeClick ? "div" : "button";
          return (
            <Tag
              key={node.id}
              type={Tag === "button" ? "button" : undefined}
              className={[
                "flow-node",
                `flow-node--${node.kind}`,
                isActive ? "is-active" : "",
                status === "running" ? "is-running" : "",
                status === "approved" ? "is-approved" : "",
                status === "review" ? "is-review" : "",
                status === "failed" ? "is-failed" : "",
                status === "locked" ? "is-locked" : "",
                isOutput ? "is-output" : "",
                readOnly ? "is-readonly" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                left: node.x,
                top: node.y,
                width: FLOW_NODE_WIDTH,
                height: FLOW_NODE_HEIGHT,
              }}
              onClick={onNodeClick ? () => onNodeClick(node.id) : undefined}
            >
              <div className="flow-node-head">
                <span className="flow-node-kind">{node.kind}</span>
                <Badge color={badge.color} size="1">
                  {badge.label}
                </Badge>
              </div>
              <span className="flow-node-title">{node.title}</span>
              <span className="flow-node-subtitle">{node.subtitle}</span>
              <div className="flow-node-ports">
                {node.inputs.map((port) => (
                  <span
                    key={`${node.id}-in-${port.id}`}
                    className="flow-port flow-port--in"
                    title={port.label}
                  />
                ))}
                {node.outputs.map((port) => (
                  <span
                    key={`${node.id}-out-${port.id}`}
                    className="flow-port flow-port--out"
                    title={port.label}
                  />
                ))}
              </div>
            </Tag>
          );
        })}
      </div>
    </div>
  );
}
