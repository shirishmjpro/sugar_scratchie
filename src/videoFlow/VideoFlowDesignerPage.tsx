import { Callout, Flex } from "@radix-ui/themes";
import { DesignerMode } from "./designerMode";
import { VideoFlowShell } from "./VideoFlowShell";
import { useVideoFlowState } from "./useVideoFlowState";

export function VideoFlowDesignerPage() {
  const {
    flow,
    flowJsonText,
    setFlowJsonText,
    error,
    setError,
    applyFlowDefinition,
    activeProjectId,
  } = useVideoFlowState();

  return (
    <VideoFlowShell
      active="designer"
      error={error}
      subtitle="Edit the flow map and default prompts for the pipeline."
      title="Design flow"
    >
      <Flex direction="column" gap="4">
        <DesignerMode
          activeProjectId={activeProjectId}
          flow={flow}
          flowJsonText={flowJsonText}
          onApplyFlow={(next) => {
            applyFlowDefinition(next);
            setError("");
          }}
          onError={setError}
          onFlowJsonTextChange={setFlowJsonText}
        />
        <Callout.Root color="blue">
          <Callout.Text>
            When you are happy with the flow, click <strong>Save flow</strong>, then open a motion
            card from <a href="/dashboard/models">Models</a> to run it
            {activeProjectId ? (
              <>
                {" "}
                (current project: <strong>{activeProjectId}</strong>)
              </>
            ) : null}
            .
          </Callout.Text>
        </Callout.Root>
      </Flex>
    </VideoFlowShell>
  );
}
