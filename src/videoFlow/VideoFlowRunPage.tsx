import { Callout, Card, Flex } from "@radix-ui/themes";
import { ProjectBar } from "./ProjectBar";
import { RunMode } from "./runMode";
import { VideoFlowShell } from "./VideoFlowShell";
import { useVideoFlowState } from "./useVideoFlowState";

export function VideoFlowRunPage() {
  const state = useVideoFlowState();
  const {
    flow,
    jobs,
    canUseGrok,
    health,
    enhancePrompt,
    image,
    setImage,
    backgroundMotionPrompt,
    setBackgroundMotionPrompt,
    dressPrompt,
    setDressPrompt,
    cardId,
    setCardId,
    cardLabel,
    setCardLabel,
    writeWebm,
    setWriteWebm,
    resolution,
    setResolution,
    tracker,
    setTracker,
    sourceMode,
    setSourceMode,
    sourcePrompt,
    setSourcePrompt,
    faceImage,
    setFaceImage,
    baseImage,
    setBaseImage,
    error,
    setError,
    refreshHealth,
    refreshJobs,
    refreshProjects,
    projects,
    activeProjectId,
    selectProject,
    createProject,
    applyVideoFlowDraft,
  } = state;

  return (
    <VideoFlowShell
      active="run"
      error={error}
      subtitle={`Running “${flow.label}” for project ${activeProjectId || "—"}.`}
      title="Run flow"
      onRefresh={() => {
        refreshHealth().catch((caught) => setError(String(caught)));
        refreshJobs().catch(() => undefined);
        refreshProjects().catch(() => undefined);
      }}
    >
      {health && !health.xai_key_loaded ? (
        <Callout.Root color="orange" mb="4">
          <Callout.Text>Add XAI_API_KEY to .env before running Grok steps.</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex direction="column" gap="4">
        <ProjectBar
        activeProjectId={activeProjectId}
        pipelineLength={flow.pipeline.length}
        projects={projects}
        onCreateProject={async (projectId, label) => {
          await createProject(projectId, label);
          await refreshProjects();
        }}
        onError={setError}
        onSelectProject={async (projectId) => {
          await selectProject(projectId);
          await refreshProjects();
        }}
      />
      <Card size="4">
        <RunMode
          flow={flow}
          jobs={jobs}
          canUseGrok={canUseGrok}
          enhancePrompt={enhancePrompt}
          image={image}
          backgroundMotionPrompt={backgroundMotionPrompt}
          dressPrompt={dressPrompt}
          cardId={cardId}
          cardLabel={cardLabel}
          writeWebm={writeWebm}
          resolution={resolution}
          tracker={tracker}
          sourceMode={sourceMode}
          sourcePrompt={sourcePrompt}
          faceImage={faceImage}
          baseImage={baseImage}
          onImageChange={setImage}
          onBackgroundMotionPromptChange={setBackgroundMotionPrompt}
          onDressPromptChange={setDressPrompt}
          onCardIdChange={setCardId}
          onCardLabelChange={setCardLabel}
          onWriteWebmChange={setWriteWebm}
          onTrackerChange={setTracker}
          onResolutionChange={setResolution}
          onSourceModeChange={setSourceMode}
          onSourcePromptChange={setSourcePrompt}
          onFaceImageChange={setFaceImage}
          onBaseImageChange={setBaseImage}
          onApplyDraft={applyVideoFlowDraft}
          onRefreshJobs={refreshJobs}
          onRefreshAssets={async () => undefined}
          onError={setError}
        />
      </Card>
      </Flex>
    </VideoFlowShell>
  );
}
