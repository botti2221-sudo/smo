import { ItemStack, ItemLockMode } from "@minecraft/server";
import { getCharacter } from "./registry.js";
import { getState, getPlayerCharacter, setCharacter } from "./state.js";
import { getStat, getBaseStats, clearModifiers, STAT_KEYS, STAT_NAMES } from "./stats.js";
import { skillCooldownScale } from "./progression.js";
import { cardScale } from "./cards.js";

// 技アイテム → アイコンのテクスチャ (RP の textures/item_texture.json と同じ)
export const ITEM_ICONS = {
  "gk:menu": "textures/items/book_normal",
  "gk:burst": "textures/items/end_crystal",
  "gk:goku_fist": "textures/items/blaze_powder",
  "gk:goku_skill1": "textures/items/fireball",
  "gk:goku_skill2": "textures/items/ender_pearl",
  "gk:goku_skill3": "textures/items/redstone_dust",
  "gk:goku_ultimate": "textures/items/nether_star",
  "gk:piccolo_fist": "textures/items/slimeball",
  "gk:piccolo_skill1": "textures/items/blaze_rod",
  "gk:piccolo_skill2": "textures/items/apple_golden",
  "gk:piccolo_skill3": "textures/items/fireball",
  "gk:piccolo_ultimate": "textures/items/nether_star",
  "gk:krillin_fist": "textures/items/gold_nugget",
  "gk:krillin_skill1": "textures/items/record_cat",
  "gk:krillin_skill2": "textures/items/glowstone_dust",
  "gk:krillin_skill3": "textures/items/seeds_wheat",
  "gk:krillin_ultimate": "textures/items/nether_star",
};

export const MENU_ITEM = "gk:menu";
export const BURST_ITEM = "gk:burst";
const MENU_SLOT = 8;
const BURST_SLOT = 5;
const HOTBAR = { fist: 0, skill1: 1, skill2: 2, skill3: 3, ultimate: 4 };

function lockedItem(typeId) {
  const item = new ItemStack(typeId, 1);
  item.lockMode = ItemLockMode.slot;
  item.keepOnDeath = true;
  return item;
}

export function resetCombatState(player) {
  const s = getState(player);
  s.gauge = 0;
  s.rushing = false;
  s.dashing = false;
  s.sprintTicks = 0;
  s.cooldowns = {};
  s.castingUntil = 0;
  clearModifiers(player.id);
}

// メニューアイテムを持っていなければ 9 番スロットに入れる
export function ensureMenuItem(player) {
  const inv = player.getComponent("minecraft:inventory").container;
  for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === MENU_ITEM) return;
  inv.setItem(MENU_SLOT, lockedItem(MENU_ITEM));
}

// キャラの技アイテム一式 (+ 試合中はゲキシンバースト) を配る
export function giveKit(player, inBattle = false) {
  const ch = getPlayerCharacter(player);
  if (!ch) return;
  const inv = player.getComponent("minecraft:inventory").container;
  for (const [key, slot] of Object.entries(HOTBAR)) inv.setItem(slot, lockedItem(ch.items[key]));
  if (inBattle) inv.setItem(BURST_SLOT, lockedItem(BURST_ITEM));
  else if (inv.getItem(BURST_SLOT)?.typeId === BURST_ITEM) inv.setItem(BURST_SLOT, undefined);
  ensureMenuItem(player);
}

export function selectCharacter(player, id) {
  const ch = getCharacter(id);
  if (!ch) return false;
  clearCharacterItems(player);
  setCharacter(player, id);
  resetCombatState(player);
  giveKit(player, getState(player).inMatch);
  player.getComponent("minecraft:health").resetToMaxValue();
  player.sendMessage(`§a${ch.name} (${ch.role}) を選択しました`);
  return true;
}

export function unselectCharacter(player) {
  clearCharacterItems(player);
  setCharacter(player, undefined);
  resetCombatState(player);
  // 頭上の HP バーを消して名前だけに戻す
  player.nameTag = player.name;
  getState(player).hpTag = undefined;
  player.sendMessage("§7キャラ選択を解除しました");
}

function clearCharacterItems(player) {
  const ch = getPlayerCharacter(player);
  if (!ch) return;
  const ids = new Set([...Object.values(ch.items), BURST_ITEM]);
  const inv = player.getComponent("minecraft:inventory").container;
  for (let i = 0; i < inv.size; i++) if (ids.has(inv.getItem(i)?.typeId)) inv.setItem(i, undefined);
}

export function statsText(entity, ch) {
  const base = ch?.base ?? getBaseStats(entity);
  return STAT_KEYS.map((k) => {
    const now = ch ? base[k] : Math.round(getStat(entity, k));
    const diff = ch ? "" : now === base[k] ? "" : now > base[k] ? " §a▲" : " §c▼";
    return `§f${STAT_NAMES[k]}: §e${now}${diff}${ch ? "" : ` §7(基礎 ${base[k]})`}`;
  }).join("\n");
}

export function kitText(ch, s) {
  const lv = (k) => (s ? ` §dLv${s.skillLv[k]}` : "");
  const cd = (k) => (ch.skills[k].cooldown * (ch.cooldownScale ?? 1) * (s ? skillCooldownScale(s, k) * cardScale(s.cards, "cdScale") : 1)) / 20;
  const lines = [`§7ロール: §f${ch.role}`, `§e通常攻撃: §f左クリックで殴る / 左クリック長押しでラッシュ`];
  ["skill1", "skill2", "skill3"].forEach((k, i) => {
    const sk = ch.skills[k];
    lines.push(`§b技${i + 1} ${sk.name}${lv(k)} §7(CT ${cd(k).toFixed(1)}秒)\n§f  ${sk.desc}`);
  });
  lines.push(`§6必殺技 ${ch.skills.ultimate.name}${lv("ultimate")}\n§f  ${ch.skills.ultimate.desc}`);
  lines.push(`§dパッシブ ${ch.passive.name}\n§f  ${ch.passive.desc}`);
  return lines.join("\n");
}
