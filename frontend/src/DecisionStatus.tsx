import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  Eye,
  ShieldX,
  XCircle,
} from "lucide-react";

const states: Record<string, { tone: string; icon: typeof CheckCircle2 }> = {
  allow: { tone: "positive", icon: CheckCircle2 },
  approve: { tone: "positive", icon: CheckCircle2 },
  pass: { tone: "positive", icon: CheckCircle2 },
  succeeded: { tone: "positive", icon: CheckCircle2 },
  completed: { tone: "positive", icon: CheckCircle2 },
  deny: { tone: "negative", icon: ShieldX },
  review: { tone: "review", icon: Clock3 },
  awaiting_review: { tone: "review", icon: Clock3 },
  error: { tone: "negative", icon: XCircle },
  failed: { tone: "negative", icon: XCircle },
  expired: { tone: "review", icon: Clock3 },
  shadow: { tone: "neutral", icon: Eye },
};

export function DecisionStatus({
  value,
  children,
}: {
  value?: string | null;
  children: React.ReactNode;
}) {
  const state = states[value ?? ""] ?? { tone: "neutral", icon: CircleHelp };
  return (
    <span className={`decision-status ${state.tone}`}>
      <state.icon size={14} aria-hidden="true" />
      {children}
    </span>
  );
}
