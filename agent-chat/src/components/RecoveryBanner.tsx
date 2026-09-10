import type { RecoveryState } from "../session";
import type { WorkbenchRestoreReceipt } from "../../types";

// Agent Chat is packaged independently of the website's message catalogs.
const restoreMessages = {
  en: {
    title: "Native restart recovery",
    waiting: "Waiting for native restoration to finish.",
    none: "Native restoration finished. No recovery assessment was needed.",
    pending: "Recovery assessment is pending. Your input takes priority.",
    running: "Assessing unresolved recovery items. Your input cancels the assessment.",
    cancelling: "Waiting for cancellation to settle. Your turn has not started.",
    cancelled: "Recovery assessment cancelled for your input. Restore facts are retained.",
    completed: "Recovery assessment finished.",
    failed: "Recovery assessment could not finish. Restore facts are retained.",
    "native-unavailable": "Native restore facts are unavailable. No assessment was started.",
    "native-updates-unavailable": "Native restore updates are unavailable. Last verified restore facts are retained. No assessment was started.",
    "assessment-failed": "Recovery assessment could not finish. Restore facts are retained.",
    "cancel-failed": "Cancellation has not settled. Your turn has not started.",
    count: "Unresolved items at restore: ",
  },
  ja: {
    title: "起動時の復元",
    waiting: "アプリによる復元の完了を待っています。",
    none: "アプリによる復元が完了しました。復旧状況の評価は不要でした。",
    pending: "復旧状況の評価を待機中です。入力が優先されます。",
    running: "未解決の復旧項目を評価しています。入力すると評価がキャンセルされます。",
    cancelling: "キャンセルの完了を待っています。入力されたターンはまだ開始していません。",
    cancelled: "入力を優先して復旧状況の評価をキャンセルしました。復元情報は保持されています。",
    completed: "復旧状況の評価が完了しました。",
    failed: "復旧状況の評価を完了できませんでした。復元情報は保持されています。",
    "native-unavailable": "アプリの復元情報を取得できません。評価は開始していません。",
    "native-updates-unavailable": "アプリの復元情報の更新を取得できません。最後に確認できた復元情報は保持されています。評価は開始していません。",
    "assessment-failed": "復旧状況の評価を完了できませんでした。復元情報は保持されています。",
    "cancel-failed": "キャンセルが完了していません。入力されたターンはまだ開始していません。",
    count: "復元時の未解決項目数: ",
  },
};

export function WorkbenchRestoreBanner({
  receipt,
  locale = typeof navigator === "undefined" ? "en" : navigator.language,
}: { receipt: WorkbenchRestoreReceipt; locale?: string }) {
  const text = restoreMessages[locale.toLowerCase().startsWith("ja") ? "ja" : "en"];
  const message = text[receipt.error === "native-unavailable" && receipt.facts ? "native-updates-unavailable" : receipt.error ?? receipt.assessment];
  return (
    <div className="recovery-banner-wrap">
      <div className="recovery-banner" data-recovery-mode="native" data-recovery-assessment={receipt.assessment} role="status">
        <strong>{text.title}</strong>
        <span>{message} {receipt.unresolved.length > 0 ? `${text.count}${receipt.unresolved.length}` : ""}</span>
      </div>
    </div>
  );
}

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
