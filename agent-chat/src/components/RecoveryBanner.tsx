import type { RecoveryState } from "../session";

export function RecoveryBanner({ recovery }: { recovery: RecoveryState }) {
  return (
    <div className="recovery-banner-wrap">
      <div className="recovery-banner" data-recovery-mode={recovery.mode} role="status">
        <strong>{recovery.title}</strong>
        <span>{recovery.message}</span>
      </div>
    </div>
  );
}
