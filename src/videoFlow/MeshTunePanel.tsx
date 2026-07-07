import { Button, Checkbox, Flex, Select, Text, TextField } from "@radix-ui/themes";
import {
  DEFAULT_MESH_TUNE,
  LEGACY_MESH_TUNE,
  type MeshSilhouetteSource,
  type MeshTuneSettings,
} from "./meshTune";
import { Field } from "./ui";

type MeshTunePanelProps = {
  value: MeshTuneSettings;
  onChange: (value: MeshTuneSettings) => void;
};

export function MeshTunePanel({ value, onChange }: MeshTunePanelProps) {
  function patch(partial: Partial<MeshTuneSettings>) {
    onChange({ ...value, ...partial });
  }

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" justify="between" wrap="wrap" gap="2">
        <Text size="2" weight="medium">
          Mesh quality tuning
        </Text>
        <Flex gap="2" wrap="wrap">
          <Button size="1" type="button" variant="soft" onClick={() => onChange({ ...DEFAULT_MESH_TUNE })}>
            Recommended
          </Button>
          <Button size="1" type="button" variant="soft" color="gray" onClick={() => onChange({ ...LEGACY_MESH_TUNE })}>
            Script defaults
          </Button>
        </Flex>
      </Flex>

      <Text color="gray" size="2">
        Use <strong>blend</strong> tracker with these settings on hard clips (lying pose, satin, Grok edits).
        Turn off loop closure for imperfect boomerangs. Sliders do nothing until you click{" "}
        <strong>Remake step</strong>, <strong>Generate compare</strong>, or <strong>Regenerate</strong>.
      </Text>

      <Field label="Silhouette source">
        <Select.Root
          value={value.silhouetteSource}
          onValueChange={(next) => patch({ silhouetteSource: next as MeshSilhouetteSource })}
        >
          <Select.Trigger />
          <Select.Content>
            <Select.Item value="person">Person segmentation (Grok / natural bg)</Select.Item>
            <Select.Item value="chroma">Green-screen chroma key</Select.Item>
          </Select.Content>
        </Select.Root>
      </Field>

      <label className="checkbox-label">
        <Checkbox checked={value.loopClose} onCheckedChange={(checked) => patch({ loopClose: checked === true })} />
        Loop closure (distribute start/end drift — off for Grok boomerangs)
      </label>

      <label className="checkbox-label">
        <Checkbox
          checked={value.perFrameMask}
          onCheckedChange={(checked) => patch({ perFrameMask: checked === true })}
        />
        Per-frame garment mask on drivers (slower, can help specular clips)
      </label>

      <Field label="Reference frame index (blank = auto)">
        <TextField.Root
          inputMode="numeric"
          placeholder="auto"
          value={value.refFrame === null ? "" : String(value.refFrame)}
          onChange={(event) => {
            const raw = event.currentTarget.value.trim();
            patch({ refFrame: raw === "" ? null : Math.max(0, Number.parseInt(raw, 10) || 0) });
          }}
        />
      </Field>

      <Field label={`Driver prune strictness (${value.pruneSpeedMadK.toFixed(1)})`}>
        <input
          type="range"
          min={2}
          max={10}
          step={0.5}
          value={value.pruneSpeedMadK}
          onChange={(event) => patch({ pruneSpeedMadK: Number(event.currentTarget.value) })}
        />
      </Field>

      <Field label={`Min driver visibility (${value.pruneMinMeanVis.toFixed(2)})`}>
        <input
          type="range"
          min={0.1}
          max={0.5}
          step={0.05}
          value={value.pruneMinMeanVis}
          onChange={(event) => patch({ pruneMinMeanVis: Number(event.currentTarget.value) })}
        />
      </Field>

      <Field label={`Field neighbors (${value.fieldNeighbors})`}>
        <input
          type="range"
          min={2}
          max={12}
          step={1}
          value={value.fieldNeighbors}
          onChange={(event) => patch({ fieldNeighbors: Number(event.currentTarget.value) })}
        />
      </Field>

      <Field label={`Field locality (${value.fieldPower.toFixed(1)})`}>
        <input
          type="range"
          min={1.5}
          max={3.5}
          step={0.1}
          value={value.fieldPower}
          onChange={(event) => patch({ fieldPower: Number(event.currentTarget.value) })}
        />
      </Field>
    </Flex>
  );
}
