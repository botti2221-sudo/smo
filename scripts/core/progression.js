import { getState, newProgress } from "./state.js";
import { cardScale } from "./cards.js";

export const MAX_LEVEL = 15;
export const MAX_SKILL_LEVEL = 3;
const SKILL_KEYS = ["skill1", "skill2", "skill3", "ultimate"];

// 次のレベルまでの経験値
export const xpToNext = (level) => 100 + 50 * (level - 1);

// レベル・ステータス強化によるステータス倍率。HP はレベルで大きく伸びる (Lv15 で +140%)
export const levelStatScale = (s) => 1 + 0.05 * (s.level - 1) + 0.05 * s.statUp;
export const levelHpScale = (s) => 1 + 0.1 * (s.level - 1) + 0.05 * s.statUp;

// 技レベルによる威力倍率・クールタイム倍率
export const skillPower = (s, key) => 1 + 0.3 * ((s.skillLv?.[key] ?? 1) - 1);
export const skillCooldownScale = (s, key) => 1 - 0.15 * ((s.skillLv?.[key] ?? 1) - 1);

let onLevelUp = () => {};
export function setLevelUpHandler(fn) {
  onLevelUp = fn;
}

// 経験値を加算。レベルアップした回数を返す
export function addXp(player, amount) {
  const s = getState(player);
  if (s.level >= MAX_LEVEL) return 0;
  s.xp += amount * cardScale(s.cards, "xpScale");
  let ups = 0;
  while (s.level < MAX_LEVEL && s.xp >= xpToNext(s.level)) {
    s.xp -= xpToNext(s.level);
    s.level++;
    s.points++;
    ups++;
  }
  if (s.level >= MAX_LEVEL) s.xp = 0;
  if (ups) onLevelUp(player, s);
  return ups;
}

export function upgradeSkill(player, key) {
  const s = getState(player);
  if (s.points <= 0 || !SKILL_KEYS.includes(key) || s.skillLv[key] >= MAX_SKILL_LEVEL) return false;
  s.skillLv[key]++;
  s.points--;
  return true;
}

export function upgradeStats(player) {
  const s = getState(player);
  if (s.points <= 0) return false;
  s.statUp++;
  s.points--;
  return true;
}

export function resetProgress(player) {
  Object.assign(getState(player), newProgress());
}
