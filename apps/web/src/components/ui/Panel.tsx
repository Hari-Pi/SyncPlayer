import { cx } from "@/lib/ui/cx";

export function Panel({
  title,
  icon,
  action,
  children,
  className
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("panel", className)}>
      <div className="panel__header">
        <span className="panel__title">
          {icon}
          {title}
        </span>
        {action}
        <span className="panel__rail" />
      </div>
      {children}
    </section>
  );
}

export function Metric({ label, value, tone = "normal" }: { label: string; value: string; tone?: "normal" | "ok" | "warn" }) {
  return (
    <div className={cx("metric", `metric--${tone}`)}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
