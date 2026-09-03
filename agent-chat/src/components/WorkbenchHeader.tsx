import type { WorkbenchExperience } from "../session";

export function WorkbenchHeader({
  experience,
  compact = false,
}: {
  experience: WorkbenchExperience;
  compact?: boolean;
}) {
  return (
    <header className={`workbench-header${compact ? " compact" : ""}`}>
      <div className="workbench-identity">
        <span className="workbench-product">{experience.productName}</span>
        <strong className="workbench-surface">{experience.surfaceName}</strong>
        {experience.contextLabel ? <span className="workbench-context">{experience.contextLabel}</span> : null}
      </div>
      <div className="workbench-authority" aria-label="Session control authority">
        <span className="authority-local">{experience.localAuthorityLabel}</span>
        <span className="authority-hub">
          <span>Remote sessions</span>
          <strong>{experience.hubAuthorityLabel}</strong>
        </span>
      </div>
    </header>
  );
}
