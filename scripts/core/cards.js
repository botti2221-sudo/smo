// カミアワセカード: 試合前に最大 MAX_CARDS 枚まで装備でき、試合中ずっと効果がある
// stats: ステータス % アップ / cdScale: 技のクールタイム倍率 / gaugeScale: 必殺技ゲージの溜まり倍率
// respawnScale: 復活時間倍率 / xpScale: 獲得経験値倍率
export const MAX_CARDS = 3;

export const CARDS = [
  { id: "power", name: "闘志のカード", icon: "textures/items/blaze_powder", desc: "全攻撃力 +10%", stats: { atkAll: 10 } },
  { id: "guard", name: "鉄壁のカード", icon: "textures/items/iron_ingot", desc: "全防御力 +12%", stats: { defAll: 12 } },
  { id: "vital", name: "生命のカード", icon: "textures/items/apple", desc: "最大HP +12%", stats: { hp: 12 } },
  { id: "swift", name: "疾風のカード", icon: "textures/items/feather", desc: "移動速度 +15%", stats: { speed: 15 } },
  { id: "strike", name: "格闘のカード", icon: "textures/items/iron_sword", desc: "打撃攻撃力 +20%", stats: { atkStrike: 20 } },
  { id: "energy", name: "気功のカード", icon: "textures/items/glowstone_dust", desc: "エネルギー攻撃力 +20%", stats: { atkEnergy: 20 } },
  { id: "training", name: "修行のカード", icon: "textures/items/clock_item", desc: "技のクールタイム -10%", cdScale: 0.9 },
  { id: "saiyan", name: "超サイヤ人のカード", icon: "textures/items/nether_star", desc: "必殺技ゲージの溜まり +25%", gaugeScale: 1.25 },
  { id: "senzu", name: "仙豆のカード", icon: "textures/items/seeds_wheat", desc: "復活までの時間 -30%", respawnScale: 0.7 },
  { id: "kaio", name: "界王様のカード", icon: "textures/items/experience_bottle", desc: "獲得経験値 +20%", xpScale: 1.2 },
];

const byId = new Map(CARDS.map((c) => [c.id, c]));
export const getCard = (id) => byId.get(id);

// 装備中カードのステータスボーナス合計 (%)
export function cardStatBonus(cardIds, stat) {
  let pct = 0;
  for (const id of cardIds ?? []) pct += byId.get(id)?.stats?.[stat] ?? 0;
  return pct;
}

// 装備中カードの倍率の積 (cdScale / gaugeScale / respawnScale / xpScale)
export function cardScale(cardIds, key) {
  let scale = 1;
  for (const id of cardIds ?? []) scale *= byId.get(id)?.[key] ?? 1;
  return scale;
}
