import { system } from "@minecraft/server";
import { getPlayerCharacter, getState } from "./state.js";
import { levelStatScale, levelHpScale } from "./progression.js";
import { cardStatBonus } from "./cards.js";

export const STAT_KEYS = ["hp", "atkAll", "atkStrike", "atkEnergy", "defAll", "defStrike", "defEnergy", "speed"];

export const STAT_NAMES = {
  hp: "HP",
  atkAll: "全攻撃力",
  atkStrike: "打撃攻撃力",
  atkEnergy: "エネルギー攻撃力",
  defAll: "全防御力",
  defStrike: "打撃防御力",
  defEnergy: "エネルギー防御力",
  speed: "移動速度",
};

// キャラ以外（モブなど）の基礎ステータス。HP は体力 1 = 50
function defaultBase(entity) {
  const max = entity.getComponent("minecraft:health")?.effectiveMax ?? 20;
  return { hp: max * 50, atkAll: 50, atkStrike: 0, atkEnergy: 0, defAll: 30, defStrike: 0, defEnergy: 0, speed: 100 };
}

// NPC・ボス等は dynamic property "gk:stats"(JSON) で個別に指定できる
const entityStatsCache = new Map();
function entityBase(entity) {
  let base = entityStatsCache.get(entity.id);
  if (base === undefined) {
    try {
      const raw = entity.getDynamicProperty("gk:stats");
      base = raw ? { ...defaultBase(entity), ...JSON.parse(raw) } : null;
    } catch {
      base = null;
    }
    entityStatsCache.set(entity.id, base);
  }
  return base ?? defaultBase(entity);
}

export function setEntityStats(entity, stats) {
  entity.setDynamicProperty("gk:stats", JSON.stringify(stats));
  entityStatsCache.delete(entity.id);
}

const LEVEL_SCALED = new Set(["atkAll", "atkStrike", "atkEnergy", "defAll", "defStrike", "defEnergy"]);

export function getBaseStats(entity) {
  const ch = getPlayerCharacter(entity);
  if (!ch) return entityBase(entity);
  // レベル・ステータス強化で HP/攻撃/防御が上がる (HP は特に大きく)
  const s = getState(entity);
  const scale = levelStatScale(s);
  const hpScale = levelHpScale(s);
  const base = {};
  for (const [k, v] of Object.entries(ch.base)) {
    base[k] = k === "hp" ? Math.round(v * hpScale) : LEVEL_SCALED.has(k) ? Math.round(v * scale) : v;
  }
  return base;
}

// バフ/デバフ: entityId -> [{ id, stat, pct, until }]
// pct > 0 ならステータスアップ、pct < 0 ならステータスダウン
const modifiers = new Map();

export function addModifier(entity, id, stat, pct, ticks) {
  let list = modifiers.get(entity.id);
  if (!list) modifiers.set(entity.id, (list = []));
  const mod = { id, stat, pct, until: system.currentTick + ticks };
  const i = list.findIndex((m) => m.id === id && m.stat === stat);
  if (i >= 0) list[i] = mod;
  else list.push(mod);
}

// addModifiers(target, "kaioken", { atkAll: 25, defAll: -10 }, 160)
export function addModifiers(entity, id, changes, ticks) {
  for (const [stat, pct] of Object.entries(changes)) addModifier(entity, id, stat, pct, ticks);
}

export function removeModifier(entity, id) {
  const list = modifiers.get(entity.id);
  if (list) modifiers.set(entity.id, list.filter((m) => m.id !== id));
}

export function getModifiers(entity) {
  const list = modifiers.get(entity.id);
  if (!list) return [];
  const now = system.currentTick;
  const alive = list.filter((m) => m.until > now);
  if (alive.length) modifiers.set(entity.id, alive);
  else modifiers.delete(entity.id);
  return alive;
}

export function hasModifier(entity, id) {
  return getModifiers(entity).some((m) => m.id === id);
}

export function clearModifiers(entityId) {
  modifiers.delete(entityId);
  entityStatsCache.delete(entityId);
}

export function getModifiedEntityIds() {
  return [...modifiers.keys()];
}

export function modifierLabel(mod) {
  return STAT_NAMES[mod.stat] + (mod.pct >= 0 ? "アップ" : "ダウン");
}

export function getStat(entity, stat) {
  const base = getBaseStats(entity)[stat] ?? 0;
  // カミアワセカードのボーナス (プレイヤーのみ・常時)
  let pct = getPlayerCharacter(entity) ? cardStatBonus(getState(entity).cards, stat) : 0;
  for (const m of getModifiers(entity)) if (m.stat === stat) pct += m.pct;
  return Math.max(0, base * (1 + pct / 100));
}
