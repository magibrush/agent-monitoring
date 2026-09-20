import { useState } from "react";
import { api, json } from "./api";
type Preview = {
  revision: number;
  sampled: number;
  capped: boolean;
  counts: Record<string, number>;
  items: {
    event_id: number;
    evaluation_id: string | null;
    previous: string | null;
    proposed: string;
    reason: string;
    session: string;
  }[];
};
const labels: Record<string, string> = {
  allow: "Approve automatically",
  review: "Ask me",
  deny: "Block",
  judge: "Send to judge",
  none: "No custom match",
  unavailable: "Cannot replay",
};
export function PolicyRequestPreview({
  incidentId,
  revision,
  hasDraft,
  editing,
}: {
  incidentId: string;
  revision: number;
  hasDraft: boolean;
  editing: boolean;
}) {
  const [result, setResult] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = result?.revision === revision ? result : null;
  async function test() {
    setBusy(true);
    setError("");
    try {
      setResult(
        await api<Preview>(
          `/safety/incidents/${incidentId}/preview`,
          json("POST", { revision }),
        ),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel attention-policy-context">
      <div>
        <strong>Check the requests that brought you here</strong>
        <p>
          {editing
            ? "Save your changes, then see how the draft handles these requests."
            : hasDraft
              ? "Compare the saved draft with the affected requests before applying it."
              : "Save a draft to compare it with the affected requests."}
        </p>
      </div>
      <button
        className="secondary"
        disabled={!hasDraft || editing || busy}
        onClick={() => void test()}
      >
        {busy ? "Checking…" : "Test affected requests"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {current && !editing && (
        <div className="attention-preview" role="status">
          <p>
            {current.sampled} saved requests
            {current.capped ? " (latest 500)" : ""}:{" "}
            {Object.entries(current.counts)
              .filter(([, n]) => n)
              .map(([key, n]) => `${n} ${labels[key].toLowerCase()}`)
              .join(" · ") || "none available"}
            .
          </p>
          <p className="safety-muted">
            Built-in protections still apply. No custom match uses the normal
            assessment path. This comparison does not run the judge or change
            live decisions.
          </p>
          <details>
            <summary>Request-by-request comparison</summary>
            {current.items.map((item) => (
              <div
                className="attention-activity"
                key={`${item.event_id}-${item.evaluation_id}`}
              >
                <strong>
                  Request {item.event_id} · {item.session}
                </strong>
                <p>
                  {labels[item.previous || ""] || "No recorded recommendation"}{" "}
                  → {labels[item.proposed]}
                </p>
                <small>{item.reason}</small>
              </div>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}
