import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Home,
  Import,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Container,
  Dialog,
  Flex,
  Grid,
  Heading,
  Select,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./shared/api";
import { suggestCardId } from "./shared/groupCards";
import {
  assignCardToModel,
  createModel,
  createMotionCardDraft,
  deleteModel,
  fetchModels,
  reorderModelCards,
  updateModel,
  uploadModelAvatar,
  type ModelInfo,
  type PhotoInfo,
} from "./shared/models";
import {
  labelFromProjectId,
  PROJECT_ID_PATTERN,
  slugifyProjectId,
  type VideoFlowProject,
} from "./videoFlow/projects";

type CardInfo = {
  id: string;
  label: string;
  model_id?: string | null;
  sort_order?: number;
  photos?: PhotoInfo[];
  /** True when this row is a Video Flow draft that has not been published as a card yet. */
  draft?: boolean;
};

const iconProps = { size: 16, strokeWidth: 2 } as const;

function playCardHref(modelId: string, cardId: string): string {
  return `/?model=${encodeURIComponent(modelId)}&card=${encodeURIComponent(cardId)}`;
}

function playAllHref(modelId: string): string {
  return `/?model=${encodeURIComponent(modelId)}`;
}

function editCardHref(cardId: string): string {
  return `/dashboard/video-flow/run?card=${encodeURIComponent(cardId)}`;
}

function sortModelCards(cards: CardInfo[]): CardInfo[] {
  return [...cards].sort((a, b) => {
    // Published cards keep sort_order; drafts sort after them by id.
    if (Boolean(a.draft) !== Boolean(b.draft)) return a.draft ? 1 : -1;
    const orderA = a.sort_order ?? 0;
    const orderB = b.sort_order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

function draftCardsFromFlows(flows: VideoFlowProject[], publishedIds: Set<string>): CardInfo[] {
  const drafts: CardInfo[] = [];
  for (const flow of flows) {
    if (publishedIds.has(flow.card_id)) continue;
    const modelId = flow.draft?.model_id?.trim();
    if (!modelId) continue;
    drafts.push({
      id: flow.card_id,
      label: flow.draft?.card_label?.trim() || labelFromProjectId(flow.card_id),
      model_id: modelId,
      draft: true,
      photos: [],
    });
  }
  return drafts;
}

export function ModelsPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [cards, setCards] = useState<CardInfo[]>([]);
  const [draftCards, setDraftCards] = useState<CardInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newModelId, setNewModelId] = useState("");
  const [newModelLabel, setNewModelLabel] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingLabel, setEditingLabel] = useState("");
  const [creatingCardFor, setCreatingCardFor] = useState("");
  const [newCardId, setNewCardId] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [createModelOpen, setCreateModelOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarTargetId, setAvatarTargetId] = useState("");

  async function refresh() {
    const [nextModels, assets, flowData] = await Promise.all([
      fetchModels(),
      api<{ cards: CardInfo[] }>("/api/cards"),
      api<{ flows: VideoFlowProject[] }>("/api/video-flow").catch(() => ({ flows: [] as VideoFlowProject[] })),
    ]);
    const published = assets.cards;
    setModels(nextModels);
    setCards(published);
    setDraftCards(draftCardsFromFlows(flowData.flows, new Set(published.map((card) => card.id))));
  }

  useEffect(() => {
    refresh().catch((caught) => setError(String(caught)));
  }, []);

  const allKnownCardIds = useMemo(
    () => [...cards.map((card) => card.id), ...draftCards.map((card) => card.id)],
    [cards, draftCards],
  );

  const cardsByModel = useMemo(() => {
    const map = new Map<string, CardInfo[]>();
    for (const card of [...cards, ...draftCards]) {
      if (!card.model_id) continue;
      const bucket = map.get(card.model_id) ?? [];
      bucket.push(card);
      map.set(card.model_id, bucket);
    }
    for (const [modelId, bucket] of map) {
      map.set(modelId, sortModelCards(bucket));
    }
    return map;
  }, [cards, draftCards]);

  const importableCards = useMemo(
    () => cards.filter((card) => card.id !== "original"),
    [cards],
  );

  const unassignedCards = useMemo(
    () =>
      sortModelCards(
        cards.filter((card) => card.id !== "original" && !card.model_id),
      ),
    [cards],
  );

  const modelsWithCards = useMemo(
    () => models.filter((model) => (cardsByModel.get(model.id) ?? []).length > 0),
    [models, cardsByModel],
  );

  const modelsWithoutCards = useMemo(
    () => models.filter((model) => (cardsByModel.get(model.id) ?? []).length === 0),
    [models, cardsByModel],
  );

  async function handleCreateModel() {
    setBusy(true);
    setError("");
    try {
      await createModel(newModelId.trim(), newModelLabel.trim() || newModelId.trim());
      setNewModelId("");
      setNewModelLabel("");
      setCreateModelOpen(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleRenameModel(modelId: string) {
    setBusy(true);
    setError("");
    try {
      await updateModel(modelId, editingLabel.trim());
      setEditingId("");
      setEditingLabel("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteModel(modelId: string) {
    if (!window.confirm(`Delete model “${modelId}”?`)) return;
    setBusy(true);
    setError("");
    try {
      await deleteModel(modelId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleAssignCard(cardId: string, modelId: string) {
    setBusy(true);
    setError("");
    try {
      await assignCardToModel(cardId, modelId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleMoveCard(modelId: string, cardId: string, direction: -1 | 1) {
    const modelCards = (cardsByModel.get(modelId) ?? []).filter((card) => !card.draft);
    const index = modelCards.findIndex((card) => card.id === cardId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= modelCards.length) return;
    const nextIds = modelCards.map((card) => card.id);
    const [moved] = nextIds.splice(index, 1);
    nextIds.splice(nextIndex, 0, moved!);
    setBusy(true);
    setError("");
    try {
      await reorderModelCards(modelId, nextIds);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function handleAvatarUpload(modelId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      await uploadModelAvatar(modelId, file);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function openCreateCard(modelId: string) {
    const suggested = suggestCardId(modelId, allKnownCardIds);
    setCreatingCardFor(modelId);
    setNewCardId(suggested);
    setNewCardLabel(labelFromProjectId(suggested));
    setError("");
  }

  function closeCreateCard() {
    setCreatingCardFor("");
    setNewCardId("");
    setNewCardLabel("");
  }

  async function handleCreateCard(modelId: string) {
    const id = slugifyProjectId(newCardId);
    if (!PROJECT_ID_PATTERN.test(id)) {
      setError("Card id must be lowercase letters, numbers, and underscores.");
      return;
    }
    if (allKnownCardIds.includes(id)) {
      setError(`Card “${id}” already exists.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createMotionCardDraft(id, newCardLabel.trim() || labelFromProjectId(id), modelId);
      closeCreateCard();
      window.location.href = editCardHref(id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-root">
      <Container size="4">
        <Flex direction="column" gap="4" py="6">
          <Flex align="center" justify="between" wrap="wrap" gap="3">
            <Box>
              <Text className="eyebrow" size="2">
                Sugar Scratchie
              </Text>
              <Heading size="7">Models</Heading>
              <Text color="gray" size="2">
                A model is a girl/persona. Each model owns motion cards and their PhotoScratch photos.
              </Text>
            </Box>
            <Flex gap="2" wrap="wrap">
              <Button
                color="gray"
                variant="soft"
                onClick={() => refresh().catch((caught) => setError(String(caught)))}
              >
                <LoaderCircle {...iconProps} />
                Refresh
              </Button>
              <Button asChild variant="soft">
                <a href="/dashboard">
                  <ExternalLink {...iconProps} />
                  Dashboard
                </a>
              </Button>
              <Button asChild>
                <a href="/">
                  <Home {...iconProps} />
                  Home
                </a>
              </Button>
            </Flex>
          </Flex>

          {error ? (
            <Callout.Root color="red">
              <Callout.Icon>
                <AlertTriangle {...iconProps} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}

          <Card size="3" className="models-create-inline">
            <Heading size="4" mb="3">
              Create model
            </Heading>
            <CreateModelFields
              busy={busy}
              modelId={newModelId}
              modelLabel={newModelLabel}
              onModelIdChange={setNewModelId}
              onModelLabelChange={setNewModelLabel}
              onSubmit={() => void handleCreateModel()}
            />
          </Card>

          <Box className="models-create-mobile">
            <Dialog.Root open={createModelOpen} onOpenChange={setCreateModelOpen}>
              <Dialog.Trigger>
                <Button size="3" style={{ width: "100%" }} variant="soft">
                  <Plus {...iconProps} />
                  Create model
                </Button>
              </Dialog.Trigger>
              <Dialog.Content style={{ maxWidth: 420 }}>
                <Dialog.Title>Create model</Dialog.Title>
                <Dialog.Description size="2" mb="3">
                  Add a girl/persona. You can attach motion cards after.
                </Dialog.Description>
                <CreateModelFields
                  busy={busy}
                  modelId={newModelId}
                  modelLabel={newModelLabel}
                  stacked
                  onModelIdChange={setNewModelId}
                  onModelLabelChange={setNewModelLabel}
                  onSubmit={() => void handleCreateModel()}
                />
                <Flex gap="2" mt="3" justify="end">
                  <Dialog.Close>
                    <Button color="gray" disabled={busy} variant="soft">
                      Cancel
                    </Button>
                  </Dialog.Close>
                </Flex>
              </Dialog.Content>
            </Dialog.Root>
          </Box>

          {modelsWithoutCards.length > 0 ? (
            <Card size="3">
              <Heading size="4" mb="1">
                Girls with no motion cards
              </Heading>
              <Text color="gray" mb="3" size="2">
                These models exist but have nothing to play yet — import an unassigned card or create one.
              </Text>
              <Flex direction="column" gap="3">
                {modelsWithoutCards.map((model) => (
                  <Box
                    key={model.id}
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      background: "var(--orange-2)",
                      border: "1px solid var(--orange-6)",
                    }}
                  >
                    <Flex align="center" gap="3" wrap="wrap">
                      <Box
                        style={{
                          width: 48,
                          height: 48,
                          borderRadius: 10,
                          overflow: "hidden",
                          background: "var(--gray-3)",
                          flexShrink: 0,
                        }}
                      >
                        {model.avatar ? (
                          <img
                            alt=""
                            src={model.avatar}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <Flex align="center" height="100%" justify="center">
                            <UserRound {...iconProps} />
                          </Flex>
                        )}
                      </Box>
                      <Box style={{ flex: 1, minWidth: 140 }}>
                        <Flex align="center" gap="2" wrap="wrap">
                          <Text weight="bold">{model.label}</Text>
                          <Badge color="orange" variant="soft">
                            0 cards
                          </Badge>
                          <Badge color="plum" variant="soft">
                            {model.id}
                          </Badge>
                        </Flex>
                      </Box>
                      <Flex gap="2" wrap="wrap">
                        {unassignedCards.length > 0 ? (
                          <Select.Root
                            disabled={busy}
                            value=""
                            onValueChange={(value) => void handleAssignCard(value, model.id)}
                          >
                            <Select.Trigger placeholder="Import unassigned…" style={{ minWidth: 180 }} />
                            <Select.Content>
                              {unassignedCards.map((card) => (
                                <Select.Item key={card.id} value={card.id}>
                                  {card.label} ({card.id})
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                        ) : null}
                        {creatingCardFor === model.id ? null : (
                          <Button
                            disabled={busy}
                            size="2"
                            variant="soft"
                            onClick={() => openCreateCard(model.id)}
                          >
                            <Plus {...iconProps} />
                            New motion card
                          </Button>
                        )}
                        <Button
                          color="red"
                          disabled={busy}
                          size="2"
                          variant="soft"
                          onClick={() => void handleDeleteModel(model.id)}
                        >
                          <Trash2 {...iconProps} />
                          Delete
                        </Button>
                      </Flex>
                    </Flex>
                    {creatingCardFor === model.id ? (
                      <Box mt="3">
                        <CreateCardForm
                          busy={busy}
                          cardId={newCardId}
                          cardLabel={newCardLabel}
                          onCancel={closeCreateCard}
                          onCardIdChange={setNewCardId}
                          onCardLabelChange={setNewCardLabel}
                          onSubmit={() => void handleCreateCard(model.id)}
                        />
                      </Box>
                    ) : null}
                  </Box>
                ))}
              </Flex>
            </Card>
          ) : null}

          {unassignedCards.length > 0 ? (
            <Card size="3">
              <Heading size="4" mb="1">
                Unassigned motion cards
              </Heading>
              <Text color="gray" mb="3" size="2">
                Cards with no girl yet — assign one below.
              </Text>
              <Table.Root size="1" variant="surface">
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Motion card</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Assign to girl</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {unassignedCards.map((card) => (
                    <Table.Row key={card.id}>
                      <Table.Cell>
                        {card.label} <CodeInline>{card.id}</CodeInline>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="2" wrap="wrap">
                          <Select.Root
                            disabled={busy || models.length === 0}
                            value=""
                            onValueChange={(value) => void handleAssignCard(card.id, value)}
                          >
                            <Select.Trigger placeholder="Choose girl…" style={{ minWidth: 180 }} />
                            <Select.Content>
                              {models.map((model) => (
                                <Select.Item key={model.id} value={model.id}>
                                  {model.label}
                                  {(cardsByModel.get(model.id) ?? []).length === 0 ? " (empty)" : ""}
                                </Select.Item>
                              ))}
                            </Select.Content>
                          </Select.Root>
                          <Button asChild size="1" variant="soft">
                            <a href={editCardHref(card.id)} title={`Edit ${card.label} in Video Flow`}>
                              <Pencil {...iconProps} />
                              Edit
                            </a>
                          </Button>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Card>
          ) : null}

          {modelsWithCards.length > 0 ? (
            <Heading size="4">Girls with motion cards</Heading>
          ) : null}

          <Grid columns={{ initial: "1", lg: "2" }} gap="4">
            {modelsWithCards.map((model) => {
              const modelCards = cardsByModel.get(model.id) ?? [];
              const candidates = importableCards.filter((card) => card.model_id !== model.id);
              return (
                <Card key={model.id} size="3">
                  <Flex align="start" gap="3" mb="3">
                    <Box
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: 12,
                        overflow: "hidden",
                        background: "var(--gray-3)",
                        flexShrink: 0,
                      }}
                    >
                      {model.avatar ? (
                        <img alt="" src={model.avatar} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <Flex align="center" height="100%" justify="center">
                          <UserRound {...iconProps} />
                        </Flex>
                      )}
                    </Box>
                    <Box style={{ flex: 1 }}>
                      {editingId === model.id ? (
                        <Flex align="center" gap="2" wrap="wrap">
                          <TextField.Root
                            disabled={busy}
                            value={editingLabel}
                            onChange={(event) => setEditingLabel(event.currentTarget.value)}
                          />
                          <Button disabled={busy} size="1" onClick={() => void handleRenameModel(model.id)}>
                            Save
                          </Button>
                          <Button
                            disabled={busy}
                            size="1"
                            variant="soft"
                            onClick={() => {
                              setEditingId("");
                              setEditingLabel("");
                            }}
                          >
                            Cancel
                          </Button>
                        </Flex>
                      ) : (
                        <Flex align="center" gap="2" wrap="wrap">
                          <Heading size="4">{model.label}</Heading>
                          <Badge color="plum" variant="soft">
                            {model.id}
                          </Badge>
                        </Flex>
                      )}
                      <Text color="gray" mt="1" size="2">
                        {modelCards.filter((card) => !card.draft).length} published
                        {modelCards.some((card) => card.draft)
                          ? ` · ${modelCards.filter((card) => card.draft).length} draft`
                          : ""}
                      </Text>
                    </Box>
                  </Flex>

                  <Flex gap="2" mb="3" wrap="wrap">
                    {modelCards.some((card) => !card.draft) ? (
                      <Button asChild size="1">
                        <a href={playAllHref(model.id)}>
                          <Play {...iconProps} />
                          Play all
                        </a>
                      </Button>
                    ) : null}
                    {creatingCardFor === model.id ? null : (
                      <Button
                        disabled={busy}
                        size="1"
                        variant="soft"
                        onClick={() => openCreateCard(model.id)}
                      >
                        <Plus {...iconProps} />
                        New motion card
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      size="1"
                      variant="soft"
                      onClick={() => {
                        setEditingId(model.id);
                        setEditingLabel(model.label);
                      }}
                    >
                      Rename
                    </Button>
                    <Button
                      disabled={busy}
                      size="1"
                      variant="soft"
                      onClick={() => {
                        setAvatarTargetId(model.id);
                        avatarInputRef.current?.click();
                      }}
                    >
                      <Upload {...iconProps} />
                      Avatar
                    </Button>
                    <Button
                      color="red"
                      disabled={busy}
                      size="1"
                      variant="soft"
                      onClick={() => void handleDeleteModel(model.id)}
                    >
                      <Trash2 {...iconProps} />
                      Delete
                    </Button>
                  </Flex>

                  {creatingCardFor === model.id ? (
                    <Box mb="3">
                      <CreateCardForm
                        busy={busy}
                        cardId={newCardId}
                        cardLabel={newCardLabel}
                        onCancel={closeCreateCard}
                        onCardIdChange={setNewCardId}
                        onCardLabelChange={setNewCardLabel}
                        onSubmit={() => void handleCreateCard(model.id)}
                      />
                    </Box>
                  ) : null}

                  {modelCards.length > 0 ? (
                    <Table.Root size="1" variant="surface">
                      <Table.Header>
                        <Table.Row>
                          <Table.ColumnHeaderCell>Motion card</Table.ColumnHeaderCell>
                          <Table.ColumnHeaderCell>Photos</Table.ColumnHeaderCell>
                          <Table.ColumnHeaderCell />
                        </Table.Row>
                      </Table.Header>
                      <Table.Body>
                        {modelCards.map((card, index) => {
                          const publishedCards = modelCards.filter((entry) => !entry.draft);
                          const publishedIndex = publishedCards.findIndex((entry) => entry.id === card.id);
                          return (
                          <Table.Row key={card.id}>
                            <Table.Cell>
                              {index + 1}. {card.label} <CodeInline>{card.id}</CodeInline>
                              {card.draft ? (
                                <Badge color="amber" ml="2" variant="soft">
                                  draft
                                </Badge>
                              ) : null}
                            </Table.Cell>
                            <Table.Cell>{card.draft ? "—" : (card.photos?.length ?? 0)}</Table.Cell>
                            <Table.Cell align="right">
                              <Flex align="center" gap="1" justify="end">
                                {card.draft ? null : (
                                  <>
                                    <Button
                                      color="gray"
                                      disabled={busy || publishedIndex <= 0}
                                      size="1"
                                      title="Move up"
                                      variant="ghost"
                                      onClick={() => void handleMoveCard(model.id, card.id, -1)}
                                    >
                                      <ChevronUp {...iconProps} />
                                    </Button>
                                    <Button
                                      color="gray"
                                      disabled={
                                        busy ||
                                        publishedIndex < 0 ||
                                        publishedIndex >= publishedCards.length - 1
                                      }
                                      size="1"
                                      title="Move down"
                                      variant="ghost"
                                      onClick={() => void handleMoveCard(model.id, card.id, 1)}
                                    >
                                      <ChevronDown {...iconProps} />
                                    </Button>
                                    <Button asChild size="1" variant="soft">
                                      <a
                                        href={playCardHref(model.id, card.id)}
                                        title={`Play ${card.label}`}
                                      >
                                        <Play {...iconProps} />
                                        Play
                                      </a>
                                    </Button>
                                  </>
                                )}
                                <Button asChild size="1" variant="soft">
                                  <a
                                    href={editCardHref(card.id)}
                                    title={`Edit ${card.label} in Video Flow`}
                                  >
                                    <Pencil {...iconProps} />
                                    Edit
                                  </a>
                                </Button>
                                {card.draft ? null : (
                                  <Button
                                    color="gray"
                                    disabled={busy}
                                    size="1"
                                    title="Detach card from this model"
                                    variant="ghost"
                                    onClick={() => void handleAssignCard(card.id, "")}
                                  >
                                    <X {...iconProps} />
                                  </Button>
                                )}
                              </Flex>
                            </Table.Cell>
                          </Table.Row>
                          );
                        })}
                      </Table.Body>
                    </Table.Root>
                  ) : (
                    <Text color="gray" size="2">
                      No motion cards yet. Create one above or import an existing card below.
                    </Text>
                  )}

                  {candidates.length > 0 ? (
                    <Flex align="center" gap="2" mt="3" wrap="wrap">
                      <Import {...iconProps} />
                      <Select.Root
                        disabled={busy}
                        value=""
                        onValueChange={(value) => void handleAssignCard(value, model.id)}
                      >
                        <Select.Trigger
                          placeholder="Import an existing motion card…"
                          style={{ minWidth: 240 }}
                        />
                        <Select.Content>
                          {candidates
                            .slice()
                            .sort((a, b) => Number(Boolean(a.model_id)) - Number(Boolean(b.model_id)))
                            .map((card) => {
                              const owner = card.model_id
                                ? models.find((entry) => entry.id === card.model_id)?.label ?? card.model_id
                                : null;
                              return (
                                <Select.Item key={card.id} value={card.id}>
                                  {card.label} ({card.id}){owner ? ` — from ${owner}` : " — unassigned"}
                                </Select.Item>
                              );
                            })}
                        </Select.Content>
                      </Select.Root>
                    </Flex>
                  ) : null}
                </Card>
              );
            })}
          </Grid>

          {models.length === 0 ? (
            <Card size="3">
              <Text color="gray">No models yet. Create your first model above.</Text>
            </Card>
          ) : null}

          {models.length > 0 && modelsWithCards.length === 0 && modelsWithoutCards.length === 0 ? (
            <Card size="3">
              <Text color="gray">No girls to show.</Text>
            </Card>
          ) : null}
        </Flex>
      </Container>

      <input
        ref={avatarInputRef}
        accept="image/jpeg,image/png,image/webp"
        hidden
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file && avatarTargetId) void handleAvatarUpload(avatarTargetId, file);
        }}
      />
    </main>
  );
}

function CodeInline({ children }: { children: ReactNode }) {
  return (
    <Text as="span" color="gray" size="1">
      <code>{children}</code>
    </Text>
  );
}

function CreateModelFields({
  busy,
  modelId,
  modelLabel,
  stacked = false,
  onModelIdChange,
  onModelLabelChange,
  onSubmit,
}: {
  busy: boolean;
  modelId: string;
  modelLabel: string;
  stacked?: boolean;
  onModelIdChange: (value: string) => void;
  onModelLabelChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Grid columns={stacked ? "1" : { initial: "1", md: "3" }} gap="3">
      <label>
        <Text as="div" mb="1" size="2" weight="medium">
          Model id
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="janja"
          value={modelId}
          onChange={(event) => onModelIdChange(event.currentTarget.value)}
        />
      </label>
      <label>
        <Text as="div" mb="1" size="2" weight="medium">
          Display name
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="Janja"
          value={modelLabel}
          onChange={(event) => onModelLabelChange(event.currentTarget.value)}
        />
      </label>
      <Flex align={stacked ? "stretch" : "end"}>
        <Button
          disabled={busy || !modelId.trim()}
          style={stacked ? { width: "100%" } : undefined}
          onClick={onSubmit}
        >
          <UserRound {...iconProps} />
          Create model
        </Button>
      </Flex>
    </Grid>
  );
}

function CreateCardForm({
  busy,
  cardId,
  cardLabel,
  onCancel,
  onCardIdChange,
  onCardLabelChange,
  onSubmit,
}: {
  busy: boolean;
  cardId: string;
  cardLabel: string;
  onCancel: () => void;
  onCardIdChange: (value: string) => void;
  onCardLabelChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Flex
      align={{ initial: "stretch", md: "end" }}
      direction={{ initial: "column", md: "row" }}
      gap="2"
      wrap="wrap"
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--gray-2)",
        border: "1px solid var(--gray-5)",
      }}
    >
      <label style={{ flex: 1, minWidth: 140 }}>
        <Text as="div" mb="1" size="1" weight="medium">
          Card id
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="shine_5"
          value={cardId}
          onChange={(event) => onCardIdChange(event.currentTarget.value)}
        />
      </label>
      <label style={{ flex: 1, minWidth: 140 }}>
        <Text as="div" mb="1" size="1" weight="medium">
          Label
        </Text>
        <TextField.Root
          disabled={busy}
          placeholder="Shine 5"
          value={cardLabel}
          onChange={(event) => onCardLabelChange(event.currentTarget.value)}
        />
      </label>
      <Flex gap="2">
        <Button disabled={busy || !cardId.trim()} onClick={onSubmit}>
          <Plus {...iconProps} />
          Create & edit
        </Button>
        <Button color="gray" disabled={busy} variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </Flex>
    </Flex>
  );
}
