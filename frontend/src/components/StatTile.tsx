export default function StatTile({
  label,
  value,
  sub,
  alarm,
}: {
  label: string;
  value: string;
  sub: string;
  alarm?: boolean;
}) {
  return (
    <div className={`tile${alarm ? " alarm" : ""}`}>
      <div className="k">{label}</div>
      <div className="v">{value}</div>
      <div className="s">{sub}</div>
    </div>
  );
}
