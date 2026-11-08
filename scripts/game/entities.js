import { world } from "@minecraft/server";
import { setEntityStats } from "../core/stats.js";
import { dealDamage, enemiesNear, spawnParticle, playSound, NO_ATTACK_TAG } from "../core/combat.js";
import { TEAM_COLOR, TEAM_NAME } from "../core/team.js";
import { hpBar } from "../core/hpbar.js";
import { V, center } from "../core/vec.js";

export const GAME_TAG = "gk_game"; // 試合で出したエンティティ (試合終了時にまとめて消す)

export const ENTITY = {
  npc: "gk:npc",
  boss: "gk:boss",
  hakaishin: "gk:hakaishin",
  dragonball: "gk:dragonball",
};

// 倒した時の経験値
export const XP_REWARD = { npc: 25, boss: 200, hakaishin: 300 };

const STATS = {
  npc: { hp: 400, atkAll: 60, defAll: 20 },
  boss: { hp: 6000, atkAll: 150, atkStrike: 30, defAll: 80 },
  // 防御が非常に高く、通常攻撃では削りにくい → ゲキシンバーストで大ダメージ
  hakaishin: { hp: 20000, atkAll: 0, defAll: 300 }, // ドラゴンボール前
  hakaishinLane: { hp: 12000, atkAll: 0, defAll: 250 }, // 上・下レーン
};

export const overworld = () => world.getDimension("overworld");

export function kindOf(entity) {
  return Object.keys(ENTITY).find((k) => ENTITY[k] === entity.typeId);
}

const SLOT_NAME = { top: "上レーン", bottom: "下レーン" };

function baseName(kind, team, slot) {
  const c = TEAM_COLOR[team] ?? "§f";
  switch (kind) {
    case "npc":
      return "§2サイバイマン";
    case "boss":
      return "§6§l大猿";
    case "hakaishin":
      if (slot !== "core") return `${c}§l破壊神 §r${c}(${SLOT_NAME[slot] ?? ""})`;
      return `${c}§l${team === "A" ? "破壊神ビルス" : "破壊神シャンパ"}`;
    case "dragonball":
      return `${c}${TEAM_NAME[team]}のドラゴンボール`;
  }
  return "";
}

export const slotOf = (e) => e.getDynamicProperty("gk:slot");

// 出現に失敗 (チャンクが読み込まれていない等) したら undefined
export function trySpawn(kind, loc, team, slot) {
  try {
    const e = overworld().spawnEntity(ENTITY[kind], loc);
    e.addTag(GAME_TAG);
    e.setDynamicProperty("gk:home", JSON.stringify(loc));
    if (team) e.setDynamicProperty("gk:team", team);
    if (slot) e.setDynamicProperty("gk:slot", slot);
    const stats = kind === "hakaishin" && slot !== "core" ? STATS.hakaishinLane : STATS[kind];
    if (stats) setEntityStats(e, stats);
    if (kind === "dragonball") e.addTag(NO_ATTACK_TAG);
    e.nameTag = baseName(kind, team, slot);
    return e;
  } catch {
    return undefined;
  }
}

// 結界: 攻撃を受け付けない状態 (ドラゴンボール前の破壊神は、レーンの破壊神を 1 体倒すまで結界で守られる)
export function setShield(e, on) {
  if (!e?.isValid) return;
  if (on) e.addTag(NO_ATTACK_TAG);
  else e.removeTag(NO_ATTACK_TAG);
}

export function gameEntities(kind) {
  try {
    return overworld().getEntities(kind ? { tags: [GAME_TAG], type: ENTITY[kind] } : { tags: [GAME_TAG] });
  } catch {
    return [];
  }
}

export function removeGameEntities() {
  for (const e of gameEntities()) {
    try {
      e.remove();
    } catch {}
  }
}

function home(e) {
  try {
    return JSON.parse(e.getDynamicProperty("gk:home"));
  } catch {
    return undefined;
  }
}

// 出現地点から離れすぎたら戻す
function tether(e, maxDist) {
  const h = home(e);
  if (h && V.dist(e.location, h) > maxDist) e.teleport(h);
}

const nextAttack = new Map();

// 10 tick ごとに呼ぶ
export function tickGameEntities(now) {
  for (const e of gameEntities()) {
    if (!e.isValid) continue;
    const kind = kindOf(e);
    const team = e.getDynamicProperty("gk:team");
    const health = e.getComponent("minecraft:health");

    // 頭上に名前と HP バー
    if (kind !== "dragonball" && health) {
      const shield = e.hasTag(NO_ATTACK_TAG) ? "\n§7§l[結界] §r§7レーンの破壊神を倒すと解除" : "";
      const tag = `${baseName(kind, team, slotOf(e))}\n${hpBar(health.currentValue / health.effectiveMax, kind === "npc" ? 10 : 20)}${shield}`;
      if (e.nameTag !== tag) e.nameTag = tag;
    }

    const ready = now >= (nextAttack.get(e.id) ?? 0);
    try {
      if (kind === "hakaishin") {
        // 破壊神は攻撃しない。その場から動かず、突破されるのを待つ
        tether(e, 1);
        if (e.hasTag(NO_ATTACK_TAG) && now % 20 === 0) spawnParticle(e.dimension, "minecraft:totem_particle", center(e));
      } else if (kind === "boss") {
        tether(e, 14);
        // 3 秒ごとに周囲 6 ブロックへ地響き
        if (ready && enemiesNear(e, e.location, 6).length) {
          nextAttack.set(e.id, now + 60);
          spawnParticle(e.dimension, "minecraft:huge_explosion_emitter", e.location);
          playSound(e.dimension, "mob.ravager.roar", e.location);
          for (const t of enemiesNear(e, e.location, 6)) dealDamage(e, t, { power: 1.5, type: "strike", knockback: 1.5, lift: 0.5 });
        }
      } else if (kind === "npc") {
        tether(e, 25);
      } else if (kind === "dragonball") {
        tether(e, 0.5);
        if (now % 20 === 0) spawnParticle(e.dimension, "minecraft:totem_particle", center(e));
      }
    } catch {}
  }
}

export function forgetEntity(id) {
  nextAttack.delete(id);
}
