import type { WorkbenchExperience } from "../session";

export function WorkbenchHeader({
  experience,
  compact = false,
}: {
  experience: WorkbenchExperience;
  compact?: boolean;
}) {
  const hubStatus = experience.hubStatus ?? "unknown";
  const hubStatusLabel = {
    connected: "Hub connected",
    disconnected: "Hub disconnected",
    stopped: "Hub stopped",
    unavailable: "Hub unavailable",
    unknown: "Hub status unknown",
  }[hubStatus];
  return (
    <header className={`workbench-header${compact ? " compact" : ""}`}>
      <div className="workbench-identity">
        <span className="workbench-product">{experience.productName}</span>
        <strong className="workbench-surface">{experience.surfaceName}</strong>
        {experience.contextLabel ? <span className="workbench-context">{experience.contextLabel}</span> : null}
      </div>
      <div className="workbench-authority" aria-label="Session control authority">
        <span className="authority-local">{experience.localAuthorityLabel}</span>
        <span className="authority-remote">
          <span className="authority-hub">
            <span>Remote sessions:</span>
            <strong>{experience.hubAuthorityLabel}</strong>
            <span className={`authority-hub-status ${hubStatus}`}>{hubStatusLabel}</span>
          </span>
          <a className="authority-hub-link" href={experience.hubUrl} target="_blank" rel="noreferrer">Open Hub</a>
        </span>
      </div>
    </header>
  );
}
