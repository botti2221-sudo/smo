import { getState } from "./state.js";

export const TEAMS = ["A", "B"];
export const TEAM_NAME = { A: "チームA", B: "チームB" };
export const TEAM_COLOR = { A: "§c", B: "§9" };

export const otherTeam = (t) => (t === "A" ? "B" : "A");

// プレイヤーは状態から、NPC 等は dynamic property "gk:team" から
export function getTeam(entity) {
  try {
    if (entity.typeId === "minecraft:player") return getState(entity).team;
    return entity.getDynamicProperty("gk:team");
  } catch {
    return undefined;
  }
}

export function isAlly(a, b) {
  if (a.id === b.id) return true;
  const ta = getTeam(a);
  return !!ta && ta === getTeam(b);
}
