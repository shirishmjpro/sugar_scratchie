import { useEffect, useMemo, useState } from "react";

type CardInfo = {
  id: string;
  label: string;
  background: string;
  foreground: string;
  mesh: string;
  has_mesh: boolean;
};

type MeshInfo = {
  file: string;
  path: string;
  source?: string | null;
  tracker?: string | null;
  generator?: string | null;
  frames?: number | null;
  cols?: number | null;
  rows?: number | null;
  size_bytes: number;
  modified_at: number;
};

type JobInfo = {
  id: string;
  kind: string;
  command: string[];
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  created_at: number;
  started_at?: number | null;
  ended_at?: number | null;
  return_code?: number | null;
  logs: string[];
};

type AssetsResponse = {
  cards: CardInfo[];
  meshes: MeshInfo[];
};

const TRACKERS = ["bootstapir", "cotracker", "blend"] as const;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json() as Promise<T>;
}

function formatBytes(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

function statusLabel(status: JobInfo["status"]) {
  if (status === "succeeded") return "Done";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  return "Queued";
}

export function Dashboard() {
  const [assets, setAssets] = useState<AssetsResponse>({ cards: [], meshes: [] });
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [error, setError] = useState("");
  const [selectedCardId, setSelectedCardId] = useState("");
  const [tracker, setTracker] = useState<(typeof TRACKERS)[number]>("bootstapir");
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [compareTrackers, setCompareTrackers] = useState(false);
  const [grokPrompt, setGrokPrompt] = useState(
    "Replace only her dress with a fitted red satin dress. Keep the same person, face, hair, pose, motion, lighting and background.",
  );
  const [grokOut, setGrokOut] = useState(".tmp/grok-edit.mp4");
  const [enhancePrompt, setEnhancePrompt] = useState(true);
  const [resolution, setResolution] = useState("720p");
  const [sourceImage, setSourceImage] = useState("public/images/source.png");
  const [motionPrompt, setMotionPrompt] = useState(
    "Animate this still portrait into a short natural fashion video with subtle body movement and a steady camera.",
  );
  const [flowDressPrompt, setFlowDressPrompt] = useState(
    "Replace only her dress with a fitted emerald satin dress. Keep the same person, face, hair, pose, motion, lighting and background.",
  );
  const [flowBaseOut, setFlowBaseOut] = useState(".tmp/image-video-base.mp4");
  const [flowOut, setFlowOut] = useState(".tmp/image-dress-video.mp4");

  const selectedCard = useMemo(() => {
    return assets.cards.find((card) => card.id === selectedCardId) ?? assets.cards[0];
  }, [assets.cards, selectedCardId]);

  async function refreshAssets() {
    const data = await api<AssetsResponse>("/api/assets");
    setAssets(data);
    setSelectedCardId((current) => current || data.cards[0]?.id || "");
  }

  async function refreshJobs() {
    const data = await api<{ jobs: JobInfo[] }>("/api/jobs");
    setJobs(data.jobs);
  }

  useEffect(() => {
    refreshAssets().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
    refreshJobs().catch(() => undefined);
    const timer = window.setInterval(() => {
      refreshJobs().catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!selectedCard) return;
    setGrokOut(`.tmp/${selectedCard.id}-edit.mp4`);
  }, [selectedCard]);

  async function startMeshJob() {
    if (!selectedCard) return;
    setError("");
    try {
      await api<JobInfo>("/api/jobs/generate-mesh", {
        method: "POST",
        body: JSON.stringify({
          input_video: selectedCard.foreground,
          output_json: `public/mesh/${selectedCard.mesh}`,
          tracker,
          debug_overlay: debugOverlay,
          compare_trackers: compareTrackers,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function startGrokJob() {
    if (!selectedCard) return;
    setError("");
    try {
      await api<JobInfo>("/api/jobs/grok-edit", {
        method: "POST",
        body: JSON.stringify({
          video: selectedCard.foreground,
          prompt: grokPrompt,
          out: grokOut,
          enhance: enhancePrompt,
          resolution,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function startImageDressFlow() {
    setError("");
    try {
      await api<JobInfo>("/api/jobs/image-dress-flow", {
        method: "POST",
        body: JSON.stringify({
          image: sourceImage,
          motion_prompt: motionPrompt,
          dress_prompt: flowDressPrompt,
          base_video_out: flowBaseOut,
          out: flowOut,
          enhance_dress_prompt: enhancePrompt,
          resolution,
        }),
      });
      await refreshJobs();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function cancelJob(id: string) {
    await api<JobInfo>(`/api/jobs/${id}/cancel`, { method: "POST" });
    await refreshJobs();
  }

  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Operator Dashboard</p>
          <h1>Sugar Scratchie Tools</h1>
        </div>
        <a
          className="dashboard-link"
          href="/"
        >
          Open prototype
        </a>
      </header>

      {error ? <div className="dashboard-error">{error}</div> : null}

      <section className="dashboard-grid">
        <div className="tool-panel">
          <div className="panel-heading">
            <h2>Generate Mesh</h2>
            <span>{activeJobs.length} active</span>
          </div>
          <label>
            Card
            <select
              value={selectedCard?.id ?? ""}
              onChange={(event) => setSelectedCardId(event.currentTarget.value)}
            >
              {assets.cards.map((card) => (
                <option
                  key={card.id}
                  value={card.id}
                >
                  {card.label}
                </option>
              ))}
            </select>
          </label>
          <div className="asset-readout">
            <span>Input</span>
            <code>{selectedCard?.foreground ?? "No card selected"}</code>
            <span>Output</span>
            <code>{selectedCard ? `public/mesh/${selectedCard.mesh}` : "No card selected"}</code>
          </div>
          <label>
            Tracker
            <select
              value={tracker}
              onChange={(event) => setTracker(event.currentTarget.value as typeof tracker)}
            >
              {TRACKERS.map((entry) => (
                <option
                  key={entry}
                  value={entry}
                >
                  {entry}
                </option>
              ))}
            </select>
          </label>
          <div className="toggle-row">
            <label>
              <input
                checked={debugOverlay}
                onChange={(event) => setDebugOverlay(event.currentTarget.checked)}
                type="checkbox"
              />
              Debug overlays
            </label>
            <label>
              <input
                checked={compareTrackers}
                onChange={(event) => setCompareTrackers(event.currentTarget.checked)}
                type="checkbox"
              />
              Compare only
            </label>
          </div>
          <button
            type="button"
            onClick={startMeshJob}
          >
            Start mesh job
          </button>
        </div>

        <div className="tool-panel">
          <div className="panel-heading">
            <h2>Image To Dress Video</h2>
            <span>Chained flow</span>
          </div>
          <label>
            Source image path or URL
            <input
              value={sourceImage}
              onChange={(event) => setSourceImage(event.currentTarget.value)}
              type="text"
            />
          </label>
          <label>
            Motion prompt
            <textarea
              value={motionPrompt}
              onChange={(event) => setMotionPrompt(event.currentTarget.value)}
            />
          </label>
          <label>
            Dress edit prompt
            <textarea
              value={flowDressPrompt}
              onChange={(event) => setFlowDressPrompt(event.currentTarget.value)}
            />
          </label>
          <div className="inline-fields">
            <label>
              Base video output
              <input
                value={flowBaseOut}
                onChange={(event) => setFlowBaseOut(event.currentTarget.value)}
                type="text"
              />
            </label>
            <label>
              Final video output
              <input
                value={flowOut}
                onChange={(event) => setFlowOut(event.currentTarget.value)}
                type="text"
              />
            </label>
          </div>
          <button
            type="button"
            onClick={startImageDressFlow}
          >
            Start image flow
          </button>
        </div>

        <div className="tool-panel">
          <div className="panel-heading">
            <h2>Grok Dress Edit</h2>
            <span>Video edit</span>
          </div>
          <label>
            Source
            <select
              value={selectedCard?.id ?? ""}
              onChange={(event) => setSelectedCardId(event.currentTarget.value)}
            >
              {assets.cards.map((card) => (
                <option
                  key={card.id}
                  value={card.id}
                >
                  {card.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Prompt
            <textarea
              value={grokPrompt}
              onChange={(event) => setGrokPrompt(event.currentTarget.value)}
            />
          </label>
          <label>
            Output file
            <input
              value={grokOut}
              onChange={(event) => setGrokOut(event.currentTarget.value)}
              type="text"
            />
          </label>
          <div className="inline-fields">
            <label>
              Resolution
              <select
                value={resolution}
                onChange={(event) => setResolution(event.currentTarget.value)}
              >
                <option value="720p">720p</option>
                <option value="480p">480p</option>
                <option value="">Default</option>
              </select>
            </label>
            <label className="checkbox-field">
              <input
                checked={enhancePrompt}
                onChange={(event) => setEnhancePrompt(event.currentTarget.checked)}
                type="checkbox"
              />
              Enhance prompt
            </label>
          </div>
          <button
            type="button"
            onClick={startGrokJob}
          >
            Start edit job
          </button>
        </div>
      </section>

      <section className="dashboard-section">
        <div className="panel-heading">
          <h2>Assets</h2>
          <button
            className="secondary-button"
            type="button"
            onClick={() => refreshAssets().catch((caught) => setError(String(caught)))}
          >
            Refresh
          </button>
        </div>
        <div className="asset-table">
          {assets.cards.map((card) => (
            <div
              className="asset-row"
              key={card.id}
            >
              <strong>{card.label}</strong>
              <code>{card.foreground}</code>
              <span className={card.has_mesh ? "badge ok" : "badge"}>{card.has_mesh ? card.mesh : "Missing mesh"}</span>
            </div>
          ))}
        </div>
        <div className="mesh-list">
          {assets.meshes.map((mesh) => (
            <div
              className="mesh-item"
              key={mesh.file}
            >
              <strong>{mesh.file}</strong>
              <span>{mesh.tracker ?? "unknown tracker"}</span>
              <span>{mesh.frames ?? 0} frames</span>
              <span>{mesh.cols ?? "-"}x{mesh.rows ?? "-"}</span>
              <span>{formatBytes(mesh.size_bytes)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="dashboard-section">
        <div className="panel-heading">
          <h2>Jobs</h2>
          <button
            className="secondary-button"
            type="button"
            onClick={() => refreshJobs().catch(() => undefined)}
          >
            Refresh
          </button>
        </div>
        <div className="jobs-list">
          {jobs.length === 0 ? <p className="empty-state">No jobs yet.</p> : null}
          {jobs.map((job) => (
            <article
              className="job-card"
              key={job.id}
            >
              <div className="job-topline">
                <div>
                  <strong>{job.kind}</strong>
                  <code>{job.id}</code>
                </div>
                <span className={`badge ${job.status}`}>{statusLabel(job.status)}</span>
              </div>
              <pre>{job.logs.slice(-28).join("\n") || "Waiting for output..."}</pre>
              {job.status === "running" || job.status === "queued" ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => cancelJob(job.id)}
                >
                  Cancel
                </button>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
