import { DEFAULT_SCHEMA, load as parseYaml, Type } from "js-yaml";

// js-yaml's default timestamp type constructs JavaScript Dates before Daftari
// can validate the authored calendar value. JavaScript normalizes impossible
// dates (2026-02-30 -> 2026-03-02), which loses the evidence needed to report
// the bad value. Preserve bare calendar dates as strings, but delegate full
// date-time timestamps to the original schema so previously valid documents
// keep their Date semantics. All other DEFAULT_SCHEMA behavior stays intact.
const YAML_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YAML_DATE_TIME_PATTERN =
  /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?$/;

const authoredTimestamp = new Type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: (value) =>
    typeof value === "string" &&
    (YAML_DATE_PATTERN.test(value) || YAML_DATE_TIME_PATTERN.test(value)),
  construct: (value) =>
    YAML_DATE_PATTERN.test(value) ? value : parseYaml(value, { schema: DEFAULT_SCHEMA }),
});

export const AUTHOR_PRESERVING_YAML_SCHEMA = DEFAULT_SCHEMA.extend({
  implicit: [authoredTimestamp],
});
