/**
 * The app's Operator entrypoint as this Worker sees it (worker/src/index.ts, worker/src/operator.ts;
 * TEMPRA-278), over the OPERATOR service binding. Duplicated here, not imported, so this project
 * builds on its own. Every method takes the operator's email, which the app checks again.
 */

export interface People {
  waiting: { email: string; asked: string }[];
  signedUp: { email: string; handle: string | null; invited: string; created: string | null }[];
  notYet: { email: string; invited: string }[];
}

export interface Windows {
  day: number;
  week: number;
  month: number;
}

export interface ActivityCounts {
  accounts: number;
  libraries: number;
  people: Windows;
  agents: Windows;
}

export type Outcome =
  | "invited"
  | "already"
  | "dismissed"
  | "missing"
  | "bad_email"
  | "mail_failed"
  | "no_mail";

export interface OperatorService {
  people(operator: string): Promise<People>;
  invite(operator: string, email: string): Promise<Outcome>;
  decide(operator: string, email: string, decision: "invited" | "dismissed"): Promise<Outcome>;
  activity(operator: string): Promise<ActivityCounts>;
}
