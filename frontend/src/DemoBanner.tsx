import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Compass, RotateCcw, X } from "lucide-react";
import { api } from "./api";
import "./DemoTour.css";

const preference = "relay-guided-demo-finished";
const steps = [
  {
    target: '[data-tour="overview"]',
    title: "Your agents at a glance",
    text: "Track sessions, messages, and tool actions across your agents.",
    next: "Find a session",
  },
  {
    target: '[data-tour-session="demo-upload"]',
    title: "Open a session",
    text: "Click ‘Count customer records locally’ to open the conversation.",
    click: true,
  },
  {
    target: '[data-tour="conversation"]',
    title: "Read the intent, then the action",
    text: "The user asks for a local row count. The agent proposes a curl command that uploads the file. Scroll inside the highlighted conversation to inspect the request.",
    question: true,
    next: "Check the assessment",
  },
  {
    target: '[data-tour-nav="safety"]',
    title: "Investigate in Safety",
    text: "Click Safety to investigate the flagged upload.",
    click: true,
  },
  {
    target: '[data-tour-incident="demo-incident-upload"]',
    title: "Open the upload incident",
    text: "Click the incident for ‘Count customer records locally’.",
    click: true,
  },
  {
    target: '[data-tour="incident-analysis"]',
    title: "A decision backed by evidence",
    text: "The judge denied the upload because the user asked to keep the data local. The citations link to the request and command.",
    next: "Compare another incident",
    previewEvidence: true,
  },
  {
    target: '[data-tour-incident="demo-incident-push"]',
    title: "Compare a human review",
    text: "Click ‘Review a force push’ to see a request sent for human review.",
    click: true,
  },
  {
    target: '[data-tour="review-request"]',
    title: "An action that needs permission",
    text: "This force push would rewrite remote history. The user required approval, so the judge requested human review.",
    next: "See the review decision",
  },
  {
    target: '[data-tour="review-decision"]',
    title: "Human review was requested",
    text: "The judge requested review, the reviewer denied the request, and the hook blocked the command.",
    next: "See the connections",
  },
  {
    target: '[data-tour-nav="connections"]',
    title: "Visit Connections",
    text: "Click Connections to see the agents in this workspace.",
    click: true,
  },
  {
    target: '[data-tour="connections"]',
    title: "You're ready to explore",
    text: "Explore the app freely. Use Reset demo to restore the sample data.",
    next: "Finish and explore",
  },
];
type Bounds = {
  top: number;
  left: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  offscreen?: "above" | "below";
};

export function DemoBanner({ onStart }: { onStart: () => void }) {
  const [active, setActive] = useState(
    () => sessionStorage.getItem(preference) !== "yes",
  );
  const [step, setStep] = useState(0);
  const [answer, setAnswer] = useState<string | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [coachHeight, setCoachHeight] = useState(260);
  const [minimized, setMinimized] = useState(false);
  const [viewingEvidence, setViewingEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const coach = useRef<HTMLDivElement>(null);
  const start = useRef(onStart);
  start.current = onStart;
  const current = steps[step];
  useEffect(() => {
    if (active) start.current();
  }, []);
  useEffect(() => {
    if (!active || !coach.current) return;
    const observer = new ResizeObserver(() =>
      setCoachHeight(coach.current?.getBoundingClientRect().height ?? 260),
    );
    observer.observe(coach.current);
    return () => observer.disconnect();
  }, [active]);

  function finish() {
    sessionStorage.setItem(preference, "yes");
    setActive(false);
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>("[data-tour-restart]")?.focus(),
    );
  }
  function restart() {
    setMinimized(false);
    start.current();
    setStep(0);
    setAnswer(null);
    setBounds(null);
    setActive(true);
    sessionStorage.removeItem(preference);
  }
  function advance() {
    setMinimized(false);
    if (step === steps.length - 1) finish();
    else {
      setBounds(null);
      setStep((value) => value + 1);
    }
  }

  useEffect(() => {
    if (!active) return;
    let disposed = false,
      frame = 0;
    let found: HTMLElement | null = null;
    setMissing(false);
    const delayed = window.setTimeout(() => {
      if (!found) setMissing(true);
    }, 5000);
    const measure = () => {
      if (disposed) return;
      const element = (current.previewEvidence && document.querySelector<HTMLElement>("#incident-evidence-preview")) || document.querySelector<HTMLElement>(current.target);
      setViewingEvidence(element?.id === "incident-evidence-preview");
      // Tour steps can point into progressively disclosed evidence.
      let ancestor = element?.parentElement;
      while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open) ancestor.open = true;
        ancestor = ancestor.parentElement;
      }
      if (!element || !element.getClientRects().length) {
        target.current = null;
        setBounds(null);
        return;
      }
      if (element !== found) {
        found = element;
        target.current = element;
        setMissing(false);
        element.scrollIntoView({
          block: "center",
          inline: "nearest",
          behavior: "instant",
        });
        if (current.click || element.id === "incident-evidence-preview") element.focus({ preventScroll: true });
        else coach.current?.focus({ preventScroll: true });
      }
      const box = element.getBoundingClientRect();
      const left = Math.max(6, box.left - 6),
        top = Math.max(6, box.top - 6);
      const right = Math.min(innerWidth - 6, box.right + 6),
        bottom = Math.min(innerHeight - 6, box.bottom + 6);
      const offscreen = box.top >= innerHeight - 6 ? "below" : box.bottom <= 6 ? "above" : undefined;
      const next: Bounds = {
        left: Math.min(innerWidth - 6, left),
        top: offscreen === "below" ? innerHeight - 6 : offscreen === "above" ? 6 : top,
        width: Math.max(0, right - left),
        height: Math.max(0, bottom - top),
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        offscreen,
      };
      setBounds((previous) =>
        previous &&
        Object.keys(next).every(
          (key) => previous[key as keyof Bounds] === next[key as keyof Bounds],
        )
          ? previous
          : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.getElementById("root")!, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const clicked = (event: MouseEvent) => {
      if ((event.target as Element).closest('#incident-evidence-preview a[href]')) {
        finish();
        return;
      }
      if (current.click && target.current?.contains(event.target as Node)) {
        // Advance after the real application's click handler updates its state.
        window.setTimeout(() => {
          if (!disposed) advance();
        }, 0);
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
      if (event.key !== "Tab") return;
      const selector =
        'button:not(:disabled), a[href], input, select, summary, [tabindex="0"]';
      const items = [
        ...(target.current?.matches(selector) ? [target.current] : []),
        ...Array.from(
          target.current?.querySelectorAll<HTMLElement>(selector) ?? [],
        ),
        ...Array.from(
          coach.current?.querySelectorAll<HTMLElement>(selector) ?? [],
        ),
      ].filter((item) => item.getClientRects().length);
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement as HTMLElement);
      items[
        (index + (event.shiftKey ? -1 : 1) + items.length) % items.length
      ].focus();
    };
    document.addEventListener("click", clicked, true);
    document.addEventListener("keydown", keyboard, true);
    schedule();
    return () => {
      disposed = true;
      clearTimeout(delayed);
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("click", clicked, true);
      document.removeEventListener("keydown", keyboard, true);
      target.current = null;
    };
  }, [active, step]);

  async function reset() {
    setBusy(true);
    setError("");
    try {
      await api("/demo/reset", { method: "POST" });
      sessionStorage.removeItem(preference);
      window.location.hash = "";
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  const width = Math.min(350, innerWidth - 24),
    height = coachHeight;
  let top = 16,
    left = Math.max(12, (innerWidth - width) / 2);
  if (bounds?.offscreen) {
    top = bounds.offscreen === "below" ? Math.max(12, innerHeight - height - 12) : 12;
    left = Math.min(innerWidth - width - 12, Math.max(12, bounds.left));
  } else if (bounds) {
    const below = bounds.top + bounds.height + 14;
    if (below + height < innerHeight) {
      top = below;
      left = Math.min(innerWidth - width - 12, Math.max(12, bounds.left));
    } else if (bounds.left >= width + 28) {
      left = bounds.left - width - 14;
      top = Math.max(12, Math.min(innerHeight - height - 12, bounds.top));
    } else if (bounds.left + bounds.width + width + 28 < innerWidth) {
      left = bounds.left + bounds.width + 14;
      top = Math.max(12, Math.min(innerHeight - height - 12, bounds.top));
    } else if (bounds.top > height + 26) top = bounds.top - height - 14;
    else top = Math.max(12, innerHeight - height - 12);
  }
  if (minimized) {
    top = Math.max(12, innerHeight - height - 12);
    left = Math.max(12, (innerWidth - width) / 2);
  }
  return (
    <>
      <section className="demo-toolbar" aria-label="Synthetic demo">
        <div>
          <Compass size={17} />
          <strong>Demo</strong>
        </div>
        <div>
          <button className="text-button" data-tour-restart onClick={restart}>
            Restart guided tour
          </button>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void reset()}
          >
            <RotateCcw size={13} />
            {busy ? "Resetting…" : "Reset demo"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </section>
      {active &&
        createPortal(
          <div className="guided-tour-layer">
            {bounds && !bounds.offscreen ? (
              <>
                <div
                  className="tour-shade"
                  style={{ top: 0, left: 0, width: "100%", height: bounds.top }}
                />
                <div
                  className="tour-shade"
                  style={{
                    top: bounds.top,
                    left: 0,
                    width: bounds.left,
                    height: bounds.height,
                  }}
                />
                <div
                  className="tour-shade"
                  style={{
                    top: bounds.top,
                    left: bounds.left + bounds.width,
                    right: 0,
                    height: bounds.height,
                  }}
                />
                <div
                  className="tour-shade"
                  style={{
                    top: bounds.top + bounds.height,
                    left: 0,
                    right: 0,
                    bottom: 0,
                  }}
                />
                <div
                  className="tour-spotlight"
                  style={{
                    top: bounds.top,
                    left: bounds.left,
                    width: bounds.width,
                    height: bounds.height,
                  }}
                />
              </>
            ) : (
              <div className="tour-shade" style={{ inset: 0 }} />
            )}
            <div
              ref={coach}
              className={`tour-coach ${minimized ? "minimized" : ""}`}
              role="dialog"
              aria-label="Guided demo"
              aria-describedby={minimized ? undefined : "tour-description"}
              tabIndex={-1}
              style={{ top, left, width }}
            >
              <div className="tour-coach-top">
                <span>
                  Step {step + 1} of {steps.length}
                </span>
                {current.question && (
                  <button onClick={() => setMinimized(!minimized)}>
                    {minimized ? "Show guide" : "Read conversation"}
                  </button>
                )}
                {viewingEvidence && <button onClick={() => document.querySelector<HTMLButtonElement>('[aria-label="Close evidence preview"]')?.click()}>Back to explanation</button>}
                <button aria-label="Exit guided tour" onClick={finish}>
                  <X size={18} />
                </button>
              </div>
              <div hidden={minimized || viewingEvidence}>
                <h2>{current.title}</h2>
                <p id="tour-description">{current.text}</p>
                {bounds?.offscreen && (
                  <p className="tour-offscreen" role="status">
                    Highlight {bounds.offscreen === "below" ? "below ↓" : "above ↑"}
                    {" · "}<button className="tour-exit" onClick={() => target.current?.scrollIntoView({ block: "center", behavior: "instant" })}>Show highlight</button>
                  </p>
                )}
                {!bounds && (
                  <p role="status">
                    {missing
                      ? "This sample may have been dismissed. Reset demo to restore the walkthrough, or explore freely."
                      : "Finding the highlighted control…"}
                  </p>
                )}
                {current.question && (
                  <div className="tour-question">
                    <strong>Would you allow this upload?</strong>
                    <div>
                      <button
                        aria-pressed={answer === "allow"}
                        onClick={() => setAnswer("allow")}
                      >
                        Allow
                      </button>
                      <button
                        aria-pressed={answer === "deny"}
                        onClick={() => setAnswer("deny")}
                      >
                        Deny
                      </button>
                    </div>
                    {answer && (
                      <p role="status">
                        {answer === "deny"
                          ? "Exactly. "
                          : "Look at the user's constraint. "}
                        The upload violates the local-only request.
                      </p>
                    )}
                  </div>
                )}
                <div className="tour-coach-footer">
                  <button className="tour-exit" onClick={finish}>
                    Explore freely
                  </button>
                  {missing ? (
                    <button
                      className="tour-next"
                      disabled={busy}
                      onClick={() => void reset()}
                    >
                      {busy ? "Resetting…" : "Reset demo"}
                    </button>
                  ) : current.click ? (
                    <span className="tour-click-hint">
                      Click the highlighted control
                    </span>
                  ) : (
                    <button
                      className="tour-next"
                      disabled={!bounds || (current.question && !answer)}
                      onClick={advance}
                    >
                      {current.next}
                      <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
