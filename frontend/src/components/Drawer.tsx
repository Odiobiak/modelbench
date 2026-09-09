import type { ReactNode } from "react";

export default function Drawer({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
  width?: number;
}) {
  return (
    <>
      <div className={`scrim${open ? " open" : ""}`} onClick={onClose} />
      <div className={`drawer${open ? " open" : ""}`} style={width ? { width } : undefined}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        <div className="drawer-foot">{footer}</div>
      </div>
    </>
  );
}
