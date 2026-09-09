import type { BossState } from "../session";
import { bossBlockedMessage } from "../session";

/**
 * Blocked Boss recovery is a visible, non-destructive state: it names the exact
 * reason and every record the server refused to adopt, and it never offers a
 * "start a new one" escape hatch.
 */
export function BossStatusBanner({ boss }: { boss: BossState | null }) {
  if (!boss || boss.status !== "blocked") return null;
  return (
    <div className="recovery-banner-wrap">
      <div className="recovery-banner boss-blocked-banner" role="alert">
        <strong>{bossBlockedMessage(boss)}</strong>
        {boss.skipped.length ? (
          <ul className="boss-skipped">
            {boss.skipped.map((record) => (
              <li key={`${record.agent}/${record.id}`}>
                {record.agent}/{record.id}: {record.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <span>Workbench kept every candidate. Use the Boss repair contract to repoint it.</span>
      </div>
    </div>
  );
}
