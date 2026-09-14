export default function StatTile({
  label,
  value,
  sub,
  alarm,
  hint,
}: {
  label: string;
  value: string;
  sub: string;
  alarm?: boolean;
  hint?: string;
}) {
  return (
    <div className={`tile${alarm ? " alarm" : ""}`} title={hint}>
      <div className="k">{label}</div>
      <div className="v" title={value}>
        {value}
      </div>
      <div className="s" title={sub}>
        {sub}
      </div>
    </div>
  );
}
