import { Database, LockKeyhole, MessageSquare } from "lucide-react";
import { providerLabel, type Connection } from "./api";
import { Provider } from "./ui";

const samples: Record<
  string,
  { description: string; sessions: { id: string; title: string }[] }
> = {
  codex: {
    description:
      "From a routine source read to a force push that needs a human decision.",
    sessions: [
      { id: "demo-read", title: "Explain the login flow" },
      { id: "demo-push", title: "Review a force push" },
    ],
  },
  codex_cli: {
    description:
      "A focused terminal session: validate a change and inspect the test result.",
    sessions: [{ id: "demo-tests", title: "Add a validation test" }],
  },
  claude_code: {
    description:
      "Follow a local data task and investigate an unexpected upload proposal.",
    sessions: [{ id: "demo-upload", title: "Count customer records locally" }],
  },
};

export function DemoConnections({ items }: { items: Connection[] }) {
  return (
    <section
      className="demo-connections"
      aria-label="Sample connections"
      data-tour="connections"
    >
      <div className="demo-connections-intro">
        <div>
          <h2>Three agents. One shared view.</h2>
        </div>
        <span className="demo-sample-label">
          <Database size={14} />
          Sample workspace
        </span>
      </div>
      <div className="demo-connection-grid">
        {items.map((item) => (
          <article
            key={item.id}
            className={`demo-connection-card ${item.provider}`}
          >
            <div className="demo-connection-heading">
              <Provider name={item.provider} />
            </div>
            <h3>{providerLabel(item.provider)}</h3>
            <p>{samples[item.provider]?.description}</p>
            <div className="demo-connection-count">
              <MessageSquare size={15} />
              <strong>{item.session_count ?? 0}</strong>sample{" "}
              {item.session_count === 1 ? "session" : "sessions"}
            </div>
            <div className="demo-session-links">
              {samples[item.provider]?.sessions.map((session) => (
                <div key={session.id}>
                  <span>{session.title}</span>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <div className="demo-connection-note">
        <LockKeyhole size={20} />
        <div>
          <strong>Connect your agent</strong>
          <p>
            Stop the demo and follow the repository's local setup guide.
          </p>
        </div>
      </div>
    </section>
  );
}
