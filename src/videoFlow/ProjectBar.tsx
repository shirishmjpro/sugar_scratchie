import { FolderPlus, Plus } from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Card,
  Flex,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  labelFromProjectId,
  projectSummary,
  PROJECT_ID_PATTERN,
  slugifyProjectId,
  type VideoFlowProject,
} from "./projects";
import { Field, iconProps } from "./ui";

type ProjectBarProps = {
  projects: VideoFlowProject[];
  activeProjectId: string;
  pipelineLength: number;
  busy?: boolean;
  onSelectProject: (projectId: string) => Promise<void>;
  onCreateProject: (projectId: string, label: string) => Promise<void>;
  onError: (message: string) => void;
};

export function ProjectBar({
  projects,
  activeProjectId,
  pipelineLength,
  busy = false,
  onSelectProject,
  onCreateProject,
  onError,
}: ProjectBarProps) {
  const [creating, setCreating] = useState(false);
  const [newId, setNewId] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const activeProject = useMemo(
    () => projects.find((entry) => entry.card_id === activeProjectId),
    [projects, activeProjectId],
  );

  const selectValue = activeProjectId || "__none__";

  useEffect(() => {
    if (!creating) return;
    const slug = slugifyProjectId(newId);
    if (!newLabel.trim() && slug) {
      setNewLabel(labelFromProjectId(slug));
    }
  }, [creating, newId, newLabel]);

  function openCreateForm() {
    onError("");
    setCreating(true);
    setNewId("");
    setNewLabel("");
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    onError("");
    const id = slugifyProjectId(newId);
    if (!id) {
      onError("Enter a project id (letters, numbers, underscores).");
      return;
    }
    if (!PROJECT_ID_PATTERN.test(id)) {
      onError("Project id must use lowercase letters, numbers, and underscores only.");
      return;
    }
    if (projects.some((entry) => entry.card_id === id)) {
      onError(`Project “${id}” already exists — pick it from the list or choose another id.`);
      return;
    }
    setSubmitting(true);
    try {
      await onCreateProject(id, newLabel.trim() || labelFromProjectId(id));
      setCreating(false);
      setNewId("");
      setNewLabel("");
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="video-flow-project-bar" size="3">
      <Flex align={{ initial: "stretch", md: "center" }} direction={{ initial: "column", md: "row" }} gap="4" justify="between">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" gap="2" mb="2">
            <FolderPlus {...iconProps} />
            <Text size="2" weight="bold">
              Project
            </Text>
            {activeProject ? (
              <Badge color={activeProject.complete ? "green" : "blue"} variant="soft">
                {projectSummary(activeProject, pipelineLength)}
              </Badge>
            ) : activeProjectId ? (
              <Badge color="gray" variant="soft">
                New
              </Badge>
            ) : null}
          </Flex>
          <Flex align="center" gap="2" wrap="wrap">
            <Select.Root
              disabled={busy || submitting}
              value={selectValue}
              onValueChange={(value) => {
                if (value === "__none__") return;
                onSelectProject(value).catch((caught) =>
                  onError(caught instanceof Error ? caught.message : String(caught)),
                );
              }}
            >
              <Select.Trigger placeholder="Choose a project…" style={{ minWidth: 220 }} />
              <Select.Content>
                {projects.length === 0 ? (
                  <Select.Item disabled value="__none__">
                    No projects yet
                  </Select.Item>
                ) : null}
                {projects.map((project) => (
                  <Select.Item key={project.card_id} value={project.card_id}>
                    {project.draft?.card_label?.trim() || labelFromProjectId(project.card_id)} ({project.card_id})
                  </Select.Item>
                ))}
                {activeProjectId && !projects.some((entry) => entry.card_id === activeProjectId) ? (
                  <Select.Item value={activeProjectId}>
                    {labelFromProjectId(activeProjectId)} ({activeProjectId})
                  </Select.Item>
                ) : null}
              </Select.Content>
            </Select.Root>
            <Button disabled={busy || submitting || creating} type="button" variant="soft" onClick={openCreateForm}>
              <Plus {...iconProps} />
              New project
            </Button>
          </Flex>
          {activeProjectId ? (
            <Text color="gray" mt="2" size="1">
              Work folder: <code>.tmp/video-flow/{activeProjectId}/</code>
              {activeProject?.complete ? " · Card published under " : " · "}
              <code>public/cards/{activeProjectId}/</code>
            </Text>
          ) : (
            <Text color="gray" mt="2" size="2">
              Create a project to design prompts and run the pipeline for a specific card.
            </Text>
          )}
        </Box>
      </Flex>

      {creating ? (
        <form className="video-flow-project-create" onSubmit={(event) => void submitCreate(event)}>
          <Flex direction={{ initial: "column", md: "row" }} gap="3" mt="4">
            <Field label="Project id (folder name)">
              <TextField.Root
                disabled={submitting}
                placeholder="janja_2"
                value={newId}
                onChange={(event) => setNewId(event.currentTarget.value)}
              />
            </Field>
            <Field label="Display name">
              <TextField.Root
                disabled={submitting}
                placeholder="Janja 2"
                value={newLabel}
                onChange={(event) => setNewLabel(event.currentTarget.value)}
              />
            </Field>
          </Flex>
          <Flex gap="2" mt="3">
            <Button disabled={submitting} type="submit">
              Create project
            </Button>
            <Button
              disabled={submitting}
              type="button"
              variant="soft"
              onClick={() => {
                setCreating(false);
                onError("");
              }}
            >
              Cancel
            </Button>
          </Flex>
        </form>
      ) : null}
    </Card>
  );
}
