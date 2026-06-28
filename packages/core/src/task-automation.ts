/** Only `full`-automation tasks run without a human. partial/manual/unknown defer. */
export function shouldAutoAct(level: string | null | undefined): boolean {
  return (level ?? "").trim().toLowerCase() === "full";
}
