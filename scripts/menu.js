import { ChestForm } from "./core/chestform.js";
import { getAllCharacters } from "./core/registry.js";
import { getState, getPlayerCharacter, addGauge, setCards } from "./core/state.js";
import { selectCharacter, unselectCharacter, statsText, kitText, ITEM_ICONS } from "./core/selection.js";
import { upgradeSkill, upgradeStats, addXp, xpToNext, MAX_SKILL_LEVEL, skillPower, skillCooldownScale } from "./core/progression.js";
import { CARDS, MAX_CARDS, getCard } from "./core/cards.js";
import { playSound, spawnParticle } from "./core/combat.js";
import { TEAMS, TEAM_NAME, TEAM_COLOR } from "./core/team.js";
import { V } from "./core/vec.js";
import { match, Phase, TEAM_MAX, teamMembers, setTeam, toggleReady, lobbyText, startBattle, joinBattle, resetToLobby } from "./game/match.js";
import { autoSetup, locationsText, missingLocations } from "./game/locations.js";

// チェストフォームのメニュー (27 マス = 3 段 × 9)。スロット番号: 段 × 9 + 列
const BACK_SLOT = 22;
const ICON = {
  back: "textures/items/arrow",
  info: "textures/items/nether_star",
  team: "textures/items/banner_pattern",
  char: "textures/items/totem",
  card: "textures/items/paper",
  ready: "textures/items/emerald",
  unready: "textures/items/redstone_dust",
  upgrade: "textures/items/experience_bottle",
  status: "textures/items/book_writable",
  kit: "textures/items/book_enchanted",
  admin: "textures/items/comparator",
  teamA: "textures/blocks/wool_colored_red",
  teamB: "textures/blocks/wool_colored_blue",
  spectate: "textures/blocks/glass",
  locked: "textures/blocks/barrier",
};

const click = (player) => playSound(player.dimension, "random.click", player.location, { pitch: 1.4 });
const lines = (text) => text.split("\n");
const back = (form, player, to = openMainMenu) => form.button(BACK_SLOT, "§f戻る", [], ICON.back, () => to(player));

export async function openMainMenu(player) {
  const s = getState(player);
  const ch = getPlayerCharacter(player);
  const inLobby = match.phase === Phase.LOBBY || match.phase === Phase.COUNTDOWN;
  const phaseText = { LOBBY: "ロビー", COUNTDOWN: "カウントダウン中", BATTLE: "試合中", END: "試合終了" }[match.phase];
  const form = new ChestForm(27).title("§lゲキシンスクアドラ");

  form.button(4, `§6§l${phaseText}`, lines(lobbyText()), ICON.info);
  if (inLobby || !s.inMatch) {
    form.button(10, "§lチーム選択", [s.team ? `${TEAM_COLOR[s.team]}${TEAM_NAME[s.team]}` : "§7未選択"], ICON.team, () => openTeamSelect(player));
    form.button(11, "§lキャラ選択", [ch ? `§f${ch.name} §7(${ch.role})` : "§7未選択"], ch ? ITEM_ICONS[ch.items.fist] : ICON.char, () => openCharacterSelect(player));
    form.button(12, "§l§eカミアワセカード", [`§7装備中 ${s.cards.length}/${MAX_CARDS}`, ...s.cards.map((id) => `§f・${getCard(id)?.name}`)], ICON.card, () => openCards(player));
  }
  if (inLobby) {
    form.button(13, s.ready ? "§c§l準備完了を取り消す" : "§a§l準備完了", [s.ready ? "§7押すと取り消し" : "§7チームとキャラを選んでから"], s.ready ? ICON.unready : ICON.ready, () => {
      toggleReady(player);
      playSound(player.dimension, getState(player).ready ? "random.levelup" : "random.click", player.location, { pitch: 1.6 });
    });
  } else if (match.phase === Phase.BATTLE && !s.inMatch) {
    form.button(13, "§a§l途中参加", ["§7チームとキャラを選んでから"], ICON.ready, () => joinBattle(player));
  }
  if (s.inMatch && ch) {
    form.button(14, `§l§d技の強化`, [s.points ? `§d§l強化ポイント ${s.points}` : "§7ポイントなし", `§bLv${s.level}`], ICON.upgrade, () => openUpgrade(player));
  }
  if (ch) {
    form.button(15, "§lステータス", lines(statsText(player)), ICON.status, () => openStatus(player));
    form.button(16, "§l技一覧", [`§f${ch.name} の技`], ICON.kit, () => openKit(player, ch));
  }
  form.button(BACK_SLOT, "§l試合・テスト設定", [missingLocations().length ? "§c未設定の地点あり" : "§a地点は設定済み"], ICON.admin, () => openAdmin(player));
  click(player);
  await form.fill().show(player);
}

// ---------- チーム ----------

async function openTeamSelect(player) {
  const form = new ChestForm(27).title("§lチーム選択");
  const slots = { A: 11, B: 15 };
  for (const t of TEAMS) {
    const ms = teamMembers(t);
    form.button(slots[t], `${TEAM_COLOR[t]}§l${TEAM_NAME[t]}`, [`§7${ms.length}/${TEAM_MAX}人`, ...ms.map((p) => `§f・${p.name}`)], t === "A" ? ICON.teamA : ICON.teamB, () => {
      setTeam(player, t);
      return openMainMenu(player);
    }, { stack: Math.max(1, ms.length) });
  }
  form.button(13, "§7観戦", ["§7チームに入らない"], ICON.spectate, () => {
    setTeam(player, undefined);
    return openMainMenu(player);
  });
  back(form, player);
  await form.fill().show(player);
}

// ---------- キャラ ----------

async function openCharacterSelect(player) {
  const form = new ChestForm(27).title("§lキャラ選択");
  const roleColor = { ダメージ: "§c", タンク: "§9", テクニカル: "§a" };
  getAllCharacters().forEach((c, i) => {
    form.button(11 + i * 2, `§l${c.name}`, [`${roleColor[c.role] ?? "§f"}${c.role}`, `§7HP ${c.base.hp} / 攻撃 ${c.base.atkAll} / 防御 ${c.base.defAll}`, "§e押して詳細を見る"], ITEM_ICONS[c.items.fist], () => openCharacterDetail(player, c));
  });
  back(form, player);
  await form.fill().show(player);
}

async function openCharacterDetail(player, ch) {
  const form = new ChestForm(27).title(`§l${ch.name} §r§8(${ch.role})`);
  form.button(4, `§6§l${ch.name}`, lines(statsText(player, ch)), ITEM_ICONS[ch.items.fist]);
  ["skill1", "skill2", "skill3", "ultimate"].forEach((k, i) => {
    const sk = ch.skills[k];
    const head = k === "ultimate" ? "§6必殺技" : `§b技${i + 1}`;
    form.button(10 + i, `${head} ${sk.name}`, [`§f${sk.desc}`, sk.cooldown ? `§7CT ${(sk.cooldown * (ch.cooldownScale ?? 1)) / 20}秒` : "§7必殺技ゲージ 100% で使用"], ITEM_ICONS[ch.items[k]]);
  });
  form.button(15, `§dパッシブ ${ch.passive.name}`, [`§f${ch.passive.desc}`], "textures/items/potion_bottle_heal");
  form.button(16, "§a§lこのキャラで戦う", ["§7押して決定"], ICON.ready, () => {
    selectCharacter(player, ch.id);
    playSound(player.dimension, "random.levelup", player.location, { pitch: 1.8 });
    return openMainMenu(player);
  });
  back(form, player, openCharacterSelect);
  await form.fill().show(player);
}

// ---------- カミアワセカード ----------

async function openCards(player) {
  const s = getState(player);
  const form = new ChestForm(27).title(`§l§eカミアワセカード §r§8(${s.cards.length}/${MAX_CARDS})`);
  CARDS.forEach((c, i) => {
    const on = s.cards.includes(c.id);
    form.button(i, `${on ? "§a§l[装備中] " : "§f"}${c.name}`, [`§e${c.desc}`, on ? "§7押すと外す" : s.cards.length >= MAX_CARDS ? `§c最大${MAX_CARDS}枚まで` : "§7押すと装備"], c.icon, () => {
      const cur = getState(player).cards;
      if (on) setCards(player, cur.filter((id) => id !== c.id));
      else if (cur.length < MAX_CARDS) {
        setCards(player, [...cur, c.id]);
        playSound(player.dimension, "random.orb", player.location, { pitch: 1.2 });
      } else player.sendMessage(`§cカードは最大${MAX_CARDS}枚までです`);
      return openCards(player);
    }, { stack: on ? 2 : 1 });
  });
  if (s.inMatch) form.button(18, "§7試合中はカードの変更が反映されます", [], ICON.info);
  back(form, player);
  await form.fill().show(player);
}

// ---------- レベルアップ強化 ----------

// 強化した時の演出
function upgradeFx(player) {
  const dim = player.dimension;
  playSound(dim, "random.anvil_use", player.location, { pitch: 1.4, volume: 0.6 });
  playSound(dim, "random.levelup", player.location, { pitch: 1.6 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    spawnParticle(dim, "minecraft:totem_particle", V.add(player.location, { x: Math.cos(a), y: 1, z: Math.sin(a) }));
  }
}

async function openUpgrade(player) {
  const s = getState(player);
  const ch = getPlayerCharacter(player);
  if (!ch) return;
  const form = new ChestForm(27).title(`§l§d技の強化 §r§8(ポイント ${s.points})`);
  form.button(4, `§bLv${s.level} §d強化ポイント ${s.points}`, [`§7XP ${Math.floor(s.xp)}/${xpToNext(s.level)}`, "§7レベルアップごとに 1 ポイント", `§7各技は最大 Lv${MAX_SKILL_LEVEL}`], ICON.upgrade, undefined, { stack: Math.max(1, s.points) });
  ["skill1", "skill2", "skill3", "ultimate"].forEach((k, i) => {
    const sk = ch.skills[k];
    const lv = s.skillLv[k];
    const maxed = lv >= MAX_SKILL_LEVEL;
    const next = maxed ? ["§6§lMAX"] : [`§dLv${lv} → Lv${lv + 1}`, `§f威力 x${skillPower(s, k).toFixed(1)} → x${(skillPower(s, k) + 0.3).toFixed(1)}`, k === "ultimate" ? "" : `§fクールタイム -15%`];
    const head = k === "ultimate" ? "§6必殺技" : `§b技${i + 1}`;
    form.button(10 + i, `${head} ${sk.name} §dLv${lv}`, next.filter(Boolean), ITEM_ICONS[ch.items[k]], () => {
      if (upgradeSkill(player, k)) {
        upgradeFx(player);
        player.sendMessage(`§a${sk.name} を §dLv${getState(player).skillLv[k]}§a に強化！`);
      } else player.sendMessage(maxed ? "§cこれ以上強化できません" : "§c強化ポイントがありません");
      return openUpgrade(player);
    }, { stack: lv });
  });
  form.button(15, `§lステータス強化 §7(${s.statUp}回)`, ["§fHP・攻撃・防御 +5%"], "textures/items/iron_chestplate", () => {
    if (upgradeStats(player)) {
      upgradeFx(player);
      player.sendMessage("§aステータスを強化！");
    } else player.sendMessage("§c強化ポイントがありません");
    return openUpgrade(player);
  }, { stack: Math.max(1, s.statUp) });
  back(form, player);
  await form.fill().show(player);
}

// ---------- ステータス・技一覧 ----------

async function openStatus(player) {
  const s = getState(player);
  const form = new ChestForm(27).title("§lステータス");
  const prog = s.inMatch ? [`§bLv${s.level} §7(XP ${Math.floor(s.xp)}/${xpToNext(s.level)})`, `§dステータス強化 ${s.statUp}回`] : ["§7試合外"];
  form.button(4, "§l現在のステータス", [...prog, "", ...lines(statsText(player))], ICON.status);
  form.button(13, "§eカミアワセカード", s.cards.length ? s.cards.map((id) => `§f${getCard(id).name}: §e${getCard(id).desc}`) : ["§7なし"], ICON.card);
  back(form, player);
  await form.fill().show(player);
}

async function openKit(player, ch) {
  const s = getState(player);
  const form = new ChestForm(27).title(`§l${ch.name} の技`);
  ["skill1", "skill2", "skill3", "ultimate"].forEach((k, i) => {
    const sk = ch.skills[k];
    const cd = sk.cooldown ? `§7CT ${((sk.cooldown * (ch.cooldownScale ?? 1) * skillCooldownScale(s, k)) / 20).toFixed(1)}秒` : "§7必殺技ゲージ 100% で使用";
    form.button(10 + i, `${k === "ultimate" ? "§6必殺技" : `§b技${i + 1}`} ${sk.name} §dLv${s.skillLv[k]}`, [`§f${sk.desc}`, cd], ITEM_ICONS[ch.items[k]], undefined, { stack: s.skillLv[k] });
  });
  form.button(15, `§dパッシブ ${ch.passive.name}`, [`§f${ch.passive.desc}`], "textures/items/potion_bottle_heal");
  form.button(16, "§e通常攻撃", ["§f左クリックで殴る", "§f左クリック長押しでラッシュ"], ITEM_ICONS[ch.items.fist]);
  back(form, player);
  await form.fill().show(player);
}

// ---------- 試合・テスト設定 ----------

async function openAdmin(player) {
  const form = new ChestForm(27).title("§l試合・テスト設定");
  if (match.phase === Phase.LOBBY || match.phase === Phase.COUNTDOWN) form.button(10, "§6§l強制開始 (テスト)", ["§7人数が足りなくても開始"], "textures/items/fireworks", () => startBattle(true));
  if (match.phase === Phase.BATTLE) form.button(10, "§c§l試合を終了してロビーへ", [], ICON.locked, () => resetToLobby());
  form.button(11, "§l地点を自動配置 (テスト用)", ["§7今いる場所 = ロビー", "§7向いている方向に 2 レーンのマップを配置"], "textures/items/map_filled", () => {
    autoSetup(player);
    player.sendMessage(`§a自動配置しました\n${locationsText()}`);
  });
  form.button(12, "§l地点一覧", lines(locationsText()).concat(["", "§7/scriptevent gk:setpos <名前>", "§7/scriptevent gk:addnpc"]), "textures/items/compass_item");
  form.button(14, "§e必殺技ゲージを満タン", [], "textures/items/nether_star", () => addGauge(player, 100));
  form.button(15, "§aHPを全回復", [], "textures/items/apple_golden", () => player.getComponent("minecraft:health").resetToMaxValue());
  form.button(16, "§b経験値 +200", [], "textures/items/experience_bottle", () => addXp(player, 200));
  form.button(20, "§cキャラ選択を解除", [], ICON.locked, () => unselectCharacter(player));
  back(form, player);
  await form.fill().show(player);
}

// 強化ポイントがある時はメニューアイテムから強化画面を直接開く (main.js)
export { openUpgrade };
