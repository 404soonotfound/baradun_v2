import type { SiteDeployShaField } from "./generated/contract.js";

export type SiteDeployKnown<T> = Omit<
  Extract<SiteDeployShaField, { status: "known" }>,
  "value"
> & { value: T };
export type SiteDeployUnknown<T> = Omit<
  Extract<SiteDeployShaField, { status: "unknown" }>,
  "last"
> & { last?: SiteDeployKnown<T> };
export type SiteDeployField<T> = SiteDeployKnown<T> | SiteDeployUnknown<T>;
