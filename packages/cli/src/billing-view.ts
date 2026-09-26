import type { BalanceState } from "./billing.js";
import type { InsightRow } from "./insights.js";

export function balanceRows(state: BalanceState): InsightRow[] {
  if (state.kind === "unsupported") return [{ label: "Account balance", value: "Not supported for this endpoint", detail: "Automatic account balance is available for the official Infron endpoint. Local recorded usage is shown below.", tone: "muted" }];
  if (state.kind === "signed-out") return [{ label: "Infron balance", value: "Sign in with /login", detail: "Uses the same Infron API key as your model requests.", tone: "muted" }];
  if (state.kind === "idle") return [{ label: "Infron balance", value: "Not checked yet", detail: "Press r to fetch the account balance.", tone: "muted" }];
  const snapshot = state.kind === "ready" ? state : state.previous;
  const amount = snapshot?.credits.toLocaleString("en-US", { maximumFractionDigits: 8 });
  const checked = snapshot ? new Date(snapshot.checkedAt).toLocaleString("en-US", { hour12: false }) : undefined;
  const rows: InsightRow[] = [{
    label: "Infron balance",
    value: snapshot ? `${amount} credits${state.kind === "ready" ? "" : " (last known)"}` : state.kind === "loading" ? "Checking…" : "Could not refresh",
    detail: "Account-wide remaining credit, separate from local recorded task costs. Uses your existing Infron API key.",
    tone: state.kind === "error" || (snapshot && snapshot.credits < 0) ? "warn" : "normal",
  }];
  if (checked) rows.push({ label: "Balance checked", value: checked, detail: "Time of the last successful balance query; press r to refresh.", tone: "muted" });
  if (state.kind === "loading") rows.push({ label: "Balance status", value: "Refreshing…", detail: "Tasks can continue while the balance is fetched.", tone: "muted" });
  if (state.kind === "error") rows.push({ label: "Balance status", value: state.message, detail: "The last known balance, if shown, is stale. Press r to retry; a balance error does not block model requests.", tone: "warn" });
  return rows;
}
