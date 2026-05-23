/**
 * Shared "Coming soon" body for tabs that haven't been migrated yet.
 * Once a tab's real component lands, this import is replaced in tabs.ts.
 */
interface PlaceholderProps {
  label: string;
  note?: string;
}

export default function Placeholder({ label, note }: PlaceholderProps) {
  return (
    <div className="right-rail-placeholder">
      <div className="right-rail-placeholder__label">{label}</div>
      {note && <div className="right-rail-placeholder__note">{note}</div>}
    </div>
  );
}
