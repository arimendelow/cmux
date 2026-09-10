import { appContinuityNotice, type AppContinuity, type WorkbenchExperience } from "../session";

const EXTERNAL_STATUS_LABEL = {
  connected: "Connected",
  disconnected: "Disconnected",
  stopped: "Stopped",
  unavailable: "Unavailable",
  unknown: "Status unknown",
};

export function WorkbenchHeader({
  experience,
  continuity = null,
  compact = false,
}: {
  experience: WorkbenchExperience;
  continuity?: AppContinuity | null;
  compact?: boolean;
}) {
  const authority = experience.externalAuthority;
  const continuityNotice = appContinuityNotice(continuity);
  const statusLabel = EXTERNAL_STATUS_LABEL[authority.status];
  return (
    <header className={`workbench-header${compact ? " compact" : ""}`}>
      <div className="workbench-identity">
        <span className="workbench-product">{experience.productName}</span>
        <strong className="workbench-surface">{experience.surfaceName}</strong>
        <span className="workbench-scope" title="One Boss conversation shared by every window and workspace">
          App-wide
        </span>
        {continuityNotice ? <span className="workbench-continuity">{continuityNotice}</span> : null}
        {experience.contextLabel ? <span className="workbench-context">{experience.contextLabel}</span> : null}
      </div>
      <div className="workbench-authority" aria-label="Session control authority">
        <span className="authority-local">{experience.localAuthorityLabel}</span>
        <span className="authority-remote">
          <span className="authority-external">
            <span>Remote sessions:</span>
            <strong>{authority.label}</strong>
            <span className={`authority-external-status ${authority.status}`}>{statusLabel}</span>
          </span>
          {authority.openUrl ? (
            <a className="authority-external-link" href={authority.openUrl} target="_blank" rel="noreferrer">
              {authority.openLabel ?? "Open"}
            </a>
          ) : null}
        </span>
      </div>
    </header>
  );
}
