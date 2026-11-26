/** @jsxImportSource react */
// The Paseo controls (client/controls.tsx) drawn with Orca's recipes, so the view files keep Paseo's
// structure while looking like Orca.
import { createContext, useContext, useState, type CSSProperties, type ReactNode } from "react";
import { projectColorIndex, projectInitial } from "../../paseo/client/project-icon";
import type { Tone } from "../../paseo/client/tone";
import { ChevronDown, ChevronRight, ChevronUp, CircleCheck, CircleHelp, Loader } from "./icons";

export type { Tone };
export const ProjectIconSources = createContext<ReadonlyMap<string, string>>(new Map());

export const space = { 0.5: 2, 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 } as const;
export const fontSize = { sm: 12, base: 14, content: 15, lg: 16 } as const;
export const row: CSSProperties = { display: "flex", flexDirection: "row", alignItems: "center", flexWrap: "wrap" };
export const column: CSSProperties = { display: "flex", flexDirection: "column" };

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost";

const variantClass: Record<ButtonVariant, string> = {
  default: "btn-primary", secondary: "btn-secondary", outline: "btn-outline", ghost: "btn-ghost",
};

export type ButtonProps = {
  label: string; accessibilityLabel?: string; onPress: () => void; selected?: boolean; disabled?: boolean; toggle?: boolean; expanded?: boolean;
  variant?: ButtonVariant; size?: "sm"; project?: string; projectId?: string; describedBy?: string;
};

export function Button({ label, accessibilityLabel, onPress, selected = false, disabled = false, toggle = false, expanded, variant = "outline", size, project, projectId, describedBy }: ButtonProps) {
  const className = ["btn", size === "sm" && "btn-sm", selected ? "btn-outline selected" : variantClass[variant]].filter(Boolean).join(" ");
  return <button type="button" className={className} role={toggle ? "checkbox" : undefined} aria-checked={toggle ? selected : undefined}
    aria-pressed={!toggle && selected ? true : undefined} aria-expanded={expanded} aria-label={accessibilityLabel ?? label} aria-describedby={describedBy} disabled={disabled} onClick={onPress}>
    {project && <ProjectIcon name={project} projectId={projectId} />}
    <span className="ellipsis">{label}</span>
  </button>;
}

// The one pill in Orca's vocabulary: it opens a session.
export function SessionChip({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel: string; onPress: () => void }) {
  return <button type="button" className="chip" aria-label={accessibilityLabel} onClick={onPress}>
    <span className="ellipsis">{label}</span><ChevronRight />
  </button>;
}

export type SegmentOption<T extends string> = { id: T; label: string; accessibilityLabel?: string };

export function SegmentedControl<T extends string>({ options, value, onChange, accessibilityLabel, disabled = false }: {
  options: readonly SegmentOption<T>[]; value: T; onChange: (id: T) => void; accessibilityLabel: string; disabled?: boolean;
}) {
  return <div role="radiogroup" aria-label={accessibilityLabel} className="tabs">
    {options.map(option => {
      const selected = option.id === value;
      return <button key={option.id} type="button" role="radio" aria-checked={selected} aria-label={option.accessibilityLabel ?? option.label}
        className="tab" disabled={disabled} onClick={() => { if (!selected) onChange(option.id); }}>{option.label}</button>;
    })}
  </div>;
}

const badgeClass: Record<Tone, string> = { muted: "badge-secondary", warning: "badge-warning", success: "badge-outline", danger: "badge-danger" };

export function StatusBadge({ label, tone = "muted" }: { label: string; tone?: Tone }) {
  return <span className={"badge " + badgeClass[tone]}>
    {tone === "success" && <span className="state-dot" style={{ background: "var(--success)" }} />}
    <span className="ellipsis">{label}</span>
  </span>;
}

// Orca's agent state glyphs: the orange question waits on you, a check is finished, red is urgent.
export function StatusDot({ tone, label }: { tone: Tone | "idle"; label?: string }) {
  const glyph = tone === "warning" ? <CircleHelp />
    : tone === "success" ? <CircleCheck />
    : <span className="state-dot" style={{ background: tone === "danger" ? "var(--destructive)" : tone === "muted" ? "var(--muted-fg)" : "var(--idle)" }} />;
  const color = tone === "warning" ? "var(--question)" : tone === "success" ? "var(--success)" : undefined;
  return <span className="state" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ color }}>{glyph}</span>;
}

export function RunningMark({ label }: { label?: string }) {
  return <span className="state" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}
    style={{ width: 12, height: 12, color: "var(--working)" }}>
    <Loader className="spin" />
  </span>;
}

const iconColors = ["var(--link)", "var(--success)", "var(--warning)", "var(--destructive)"];

export function ProjectIcon({ name, projectId }: { name: string; projectId?: string }) {
  const sources = useContext(ProjectIconSources);
  const uri = sources.get(projectId ? "id:" + projectId : "name:" + name);
  const [failed, setFailed] = useState<string>();
  if (uri && uri !== failed) return <img className="project-icon" alt="" aria-hidden="true" src={uri} onError={() => setFailed(uri)} />;
  const color = iconColors[projectColorIndex(name, iconColors.length)];
  return <span className="project-icon" aria-hidden="true" style={{ background: `color-mix(in oklab, ${color} 24%, transparent)` }}>{projectInitial(name)}</span>;
}

export function ProjectText({ projects, projectId, className, style, lines, children }: {
  projects: readonly string[]; projectId?: string; className?: string; style?: CSSProperties; lines?: 1; children: ReactNode;
}) {
  const text = <span className={[className, lines === 1 && "ellipsis"].filter(Boolean).join(" ")} style={{ ...style, flexShrink: 1, minWidth: 0 }}>{children}</span>;
  if (!projects.length) return text;
  return <span style={{ display: "flex", alignItems: "center", gap: space[1.5], flexShrink: 1, minWidth: 0 }}>
    {[...new Set(projects)].map(name => <ProjectIcon key={name} name={name} projectId={projectId} />)}
    {text}
  </span>;
}

export function Disclosure({ title, expanded, onPress, children }: { title: string; expanded: boolean; onPress: () => void; children: ReactNode }) {
  return <div className="surface" style={{ borderRadius: "var(--r-xl)" }}>
    <button type="button" className="disclosure-head" aria-expanded={expanded} onClick={onPress}>
      <span style={{ flexShrink: 1 }}>{title}</span>{expanded ? <ChevronUp /> : <ChevronDown />}
    </button>
    {expanded && <div style={{ ...column, gap: space[2], margin: `0 ${space[3]}px ${space[3]}px`, padding: space[3],
      borderLeft: "2px solid var(--border)", borderRadius: 6, background: "var(--bg)" }}>
      {children}
    </div>}
  </div>;
}

export function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return <div style={{ ...row, flexWrap: "nowrap", gap: space[2] }}>
    <span role="heading" aria-level={3} className="section-label">{children}</span>
    {count !== undefined && <span className="section-label" style={{ fontWeight: 500 }}>{count}</span>}
  </div>;
}

export function Disclose({ label, accessibilityLabel, expanded, onPress }: { label: string; accessibilityLabel?: string; expanded: boolean; onPress: () => void }) {
  return <button type="button" className="link-muted" aria-label={accessibilityLabel} aria-expanded={expanded} onClick={onPress}>{label}</button>;
}
