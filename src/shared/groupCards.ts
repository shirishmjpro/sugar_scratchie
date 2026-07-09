import type { ModelInfo } from "./models";

export type GroupedCardEntry = {
  id: string;
  label: string;
  model_id?: string;
  sort_order?: number;
};

export type CardGroup<T extends GroupedCardEntry> = {
  modelId: string | null;
  modelLabel: string;
  cards: T[];
};

export function groupCardsByModel<T extends GroupedCardEntry>(
  cards: T[],
  models: ModelInfo[],
): CardGroup<T>[] {
  const grouped = new Map<string | null, T[]>();

  for (const card of cards) {
    const modelId = card.model_id?.trim() || null;
    const bucket = grouped.get(modelId) ?? [];
    bucket.push(card);
    grouped.set(modelId, bucket);
  }

  const sortBucket = (bucket: T[]) =>
    [...bucket].sort((a, b) => {
      const orderA = a.sort_order ?? 0;
      const orderB = b.sort_order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      return a.id.localeCompare(b.id);
    });

  const groups: CardGroup<T>[] = [];

  for (const model of models) {
    const bucket = grouped.get(model.id);
    if (bucket && bucket.length > 0) {
      groups.push({
        modelId: model.id,
        modelLabel: model.label,
        cards: sortBucket(bucket),
      });
      grouped.delete(model.id);
    }
  }

  const other = grouped.get(null) ?? [];
  grouped.delete(null);
  const orphanBuckets = [...grouped.entries()].flatMap(([, bucket]) => bucket);
  const ungrouped = [...other, ...orphanBuckets];
  if (ungrouped.length > 0) {
    groups.push({
      modelId: null,
      modelLabel: "Other",
      cards: sortBucket(ungrouped),
    });
  }

  return groups;
}

export function suggestCardId(modelId: string, existingCardIds: string[]): string {
  const prefix = `${modelId}_`;
  let index = 1;
  while (existingCardIds.includes(`${prefix}${index}`)) {
    index += 1;
  }
  return `${prefix}${index}`;
}
