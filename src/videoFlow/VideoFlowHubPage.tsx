import { PenLine, Play, UserRound } from "lucide-react";
import { Box, Card, Flex, Heading, Text } from "@radix-ui/themes";
import { VideoFlowShell } from "./VideoFlowShell";
import { useVideoFlowState } from "./useVideoFlowState";
import { iconProps } from "./ui";

export function VideoFlowHubPage() {
  const { flow, activeProjectId } = useVideoFlowState();

  return (
    <VideoFlowShell
      active="hub"
      subtitle="Create motion cards on Models, then run the pipeline here."
      title="Overview"
    >
      <Flex direction="column" gap="4">
        <Text color="gray" size="3">
          Current flow: <strong>{flow.label}</strong> ({flow.pipeline.length} steps)
          {activeProjectId ? (
            <>
              {" "}
              · last card: <strong>{activeProjectId}</strong>
            </>
          ) : null}
        </Text>
        <div className="video-flow-hub-grid">
          <Card asChild className="video-flow-hub-card video-flow-hub-card--primary">
            <a href="/dashboard/models">
              <Flex direction="column" gap="3" p="2">
                <UserRound {...iconProps} size={28} />
                <Heading size="5">Models</Heading>
                <Text color="gray" size="2">
                  Create girls and motion cards, then click Edit to open the pipeline.
                </Text>
              </Flex>
            </a>
          </Card>
          <Card asChild className="video-flow-hub-card">
            <a
              href={
                activeProjectId
                  ? `/dashboard/video-flow/run?card=${encodeURIComponent(activeProjectId)}`
                  : "/dashboard/video-flow/run"
              }
            >
              <Flex direction="column" gap="3" p="2">
                <Play {...iconProps} size={28} />
                <Heading size="5">Run flow</Heading>
                <Text color="gray" size="2">
                  Step-by-step clips, approvals, mesh, and delivery for one card.
                </Text>
              </Flex>
            </a>
          </Card>
          <Card asChild className="video-flow-hub-card">
            <a href="/dashboard/video-flow/designer">
              <Flex direction="column" gap="3" p="2">
                <PenLine {...iconProps} size={28} />
                <Heading size="5">Design flow</Heading>
                <Text color="gray" size="2">
                  Optional: edit default prompts and pipeline settings for all cards.
                </Text>
              </Flex>
            </a>
          </Card>
        </div>
      </Flex>
    </VideoFlowShell>
  );
}
