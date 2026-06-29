// consensus-dump — line-oriented spot-check output for the labeling discipline.
import type { LabeledInstance } from "./consensus-instances.js";

export function formatInstanceDump(instances: LabeledInstance[]): string {
  return instances
    .map((i) => {
      const target = i.resolved ? `#${i.citedNum} -> #${i.governingNum}` : `ANOMALY #${i.citedNum} (unresolved)`;
      return `rev ${i.revid} ${i.timestamp} @${i.user} | ${target} | ${i.comment}`;
    })
    .join("\n");
}
