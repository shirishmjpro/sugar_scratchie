import { Callout, Flex } from "@radix-ui/themes";
import { DesignerMode } from "./designerMode";
import { ProjectBar } from "./ProjectBar";
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
    projects,
    activeProjectId,
    selectProject,
    createProject,
  } = useVideoFlowState();

  return (
    <VideoFlowShell
      active="designer"
      error={error}
      subtitle="Pick or create a project, then edit the flow map and prompts."
      title="Design flow"
    >
      <Flex direction="column" gap="4">
        <ProjectBar
          activeProjectId={activeProjectId}
          pipelineLength={flow.pipeline.length}
          projects={projects}
          onCreateProject={createProject}
          onError={setError}
          onSelectProject={selectProject}
        />
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
          When you are happy with the flow, click <strong>Save flow</strong>, then open{" "}
          <a href="/dashboard/video-flow/run">Run flow</a> to generate clips for{" "}
          {activeProjectId ? <strong>{activeProjectId}</strong> : "your project"}.
        </Callout.Text>
      </Callout.Root>
      </Flex>
    </VideoFlowShell>
  );
}
