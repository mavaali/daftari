export function requireDefined<T>(
  value: T | null | undefined,
  message = "Expected value to be defined",
): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}
