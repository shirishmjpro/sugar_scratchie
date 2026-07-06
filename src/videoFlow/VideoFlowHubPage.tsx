import { Clapperboard, PenLine, Play } from "lucide-react";
import { Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { VideoFlowShell } from "./VideoFlowShell";
import { useVideoFlowState } from "./useVideoFlowState";
import { iconProps } from "./ui";

export function VideoFlowHubPage() {
  const { flow } = useVideoFlowState();

  return (
    <VideoFlowShell
      active="hub"
      subtitle="Design the pipeline on one page, execute it on another."
      title="Overview"
    >
      <Flex direction="column" gap="4">
        <Text color="gray" size="3">
          Current flow: <strong>{flow.label}</strong> ({flow.pipeline.length} steps,{" "}
          {flow.reviewSteps.length} manual approvals)
        </Text>
        <div className="video-flow-hub-grid">
          <Card asChild className="video-flow-hub-card">
            <a href="/dashboard/video-flow/designer">
              <Flex direction="column" gap="3" p="2">
                <PenLine {...iconProps} size={28} />
                <Heading size="5">Design flow</Heading>
                <Text color="gray" size="2">
                  Pick a project, click nodes to edit prompts — visual editor, JSON optional.
                </Text>
              </Flex>
            </a>
          </Card>
          <Card asChild className="video-flow-hub-card video-flow-hub-card--primary">
            <a href="/dashboard/video-flow/run">
              <Flex direction="column" gap="3" p="2">
                <Play {...iconProps} size={28} />
                <Heading size="5">Run flow</Heading>
                <Text color="gray" size="2">
                  Step-by-step execution with clip previews and approvals. No cramped node graph.
                </Text>
              </Flex>
            </a>
          </Card>
          <Card className="video-flow-hub-card">
            <Flex direction="column" gap="3" p="2">
              <Clapperboard {...iconProps} size={28} />
              <Heading size="5">Pipeline</Heading>
              <ol className="video-flow-pipeline-list">
                {flow.pipeline.map((step) => (
                  <li key={step}>
                    {flow.nodes.find((node) => node.step === step)?.title ?? step}
                    {flow.reviewSteps.includes(step) ? " · approve" : " · auto"}
                  </li>
                ))}
              </ol>
            </Flex>
          </Card>
        </div>
      </Flex>
    </VideoFlowShell>
  );
}
