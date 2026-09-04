import { DEFAULT_SCHEMA, Type } from "js-yaml";

// js-yaml's default timestamp type constructs JavaScript Dates before Daftari
// can validate the authored calendar value. JavaScript normalizes impossible
// dates (2026-02-30 -> 2026-03-02), which loses the evidence needed to report
// the bad value. Override only that implicit type: all other DEFAULT_SCHEMA
// behavior, including anchors/merge keys and explicit YAML types, stays intact.
const YAML_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::\d{2})?))?)?$/;

const authoredTimestamp = new Type("tag:yaml.org,2002:timestamp", {
  kind: "scalar",
  resolve: (value) => typeof value === "string" && YAML_TIMESTAMP_PATTERN.test(value),
  construct: (value) => value,
});

export const AUTHOR_PRESERVING_YAML_SCHEMA = DEFAULT_SCHEMA.extend({
  implicit: [authoredTimestamp],
});
