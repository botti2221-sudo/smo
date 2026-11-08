import { system } from "@minecraft/server";
import { getCharacter } from "./registry.js";
import { cardScale, getCard, MAX_CARDS } from "./cards.js";

// 画面下 (アクションバー) に一時的に出すお知らせ
export function notify(player, text, ticks = 30) {
  getState(player).notice = { text, until: system.currentTick + ticks };
}

// プレイヤーごとの戦闘状態
const states = new Map();

export function newProgress() {
  return {
    level: 1,
    xp: 0,
    points: 0, // 強化ポイント (レベルアップごとに +1)
    skillLv: { skill1: 1, skill2: 1, skill3: 1, ultimate: 1 }, // 各技 Lv1〜3
    statUp: 0, // ステータス強化を選んだ回数
  };
}

export function getState(player) {
  let s = states.get(player.id);
  if (!s) {
    s = {
      charId: player.getDynamicProperty("gk:char"),
      gauge: 0, // 必殺技ゲージ 0-100
      rushing: false,
      rushStart: 0,
      castingUntil: 0, // この tick まで他の技を使えない
      cooldowns: {}, // skillKey -> 使用可能になる tick
      notice: undefined, // { text, until }
      // 試合
      team: undefined, // "A" | "B" | undefined(未所属・観戦)
      ready: false,
      inMatch: false, // 試合に出撃中
      dead: false,
      respawnAt: 0,
      lastHurt: 0,
      cards: loadCards(player), // 装備中のカミアワセカード id
      titleBusyUntil: 0, // 通常のタイトル表示中は HUD 用タイトルを送らない
      hudSent: {},
      ...newProgress(),
    };
    states.set(player.id, s);
  }
  return s;
}

function loadCards(player) {
  try {
    const ids = JSON.parse(player.getDynamicProperty("gk:cards") ?? "[]");
    return ids.filter((id) => getCard(id)).slice(0, MAX_CARDS);
  } catch {
    return [];
  }
}

export function setCards(player, ids) {
  getState(player).cards = ids;
  player.setDynamicProperty("gk:cards", JSON.stringify(ids));
}

export function removeState(playerId) {
  states.delete(playerId);
}

export function getPlayerCharacter(entity) {
  if (entity.typeId !== "minecraft:player") return undefined;
  const s = getState(entity);
  return s.charId ? getCharacter(s.charId) : undefined;
}

export function setCharacter(player, id) {
  player.setDynamicProperty("gk:char", id);
  getState(player).charId = id;
}

export function addGauge(player, amount) {
  const s = getState(player);
  if (!s.charId) return;
  if (amount > 0) amount *= cardScale(s.cards, "gaugeScale");
  s.gauge = Math.min(100, Math.max(0, s.gauge + amount));
}
