import { world, system, GameMode } from "@minecraft/server";
import { getState, getPlayerCharacter, notify } from "../core/state.js";
import { addXp, resetProgress, xpToNext, MAX_LEVEL } from "../core/progression.js";
import { addModifiers, getStat } from "../core/stats.js";
import { onDamage, dealTrueDamage, spawnParticle, playSound } from "../core/combat.js";
import { TEAMS, TEAM_NAME, TEAM_COLOR, otherTeam, getTeam } from "../core/team.js";
import { giveKit, resetCombatState } from "../core/selection.js";
import { showTitle } from "../core/display.js";
import { cardScale } from "../core/cards.js";
import { getLoc, getNpcPoints, missingLocations, LOCATION_NAMES, HAKAISHIN_SLOTS } from "./locations.js";
import { trySpawn, gameEntities, removeGameEntities, tickGameEntities, forgetEntity, kindOf, slotOf, setShield, overworld, XP_REWARD } from "./entities.js";
import { NO_ATTACK_TAG } from "../core/combat.js";
import { V, center } from "../core/vec.js";

export const Phase = { LOBBY: "LOBBY", COUNTDOWN: "COUNTDOWN", BATTLE: "BATTLE", END: "END" };
export const TEAM_MAX = 4;

const COUNTDOWN_TICKS = 200; // 10 秒
const RESPAWN_TICKS = 100; // 復活まで 5 秒 + レベル × 1 秒
const NPC_INTERVAL = 600; // 30 秒ごとに NPC 補充
const NPC_PER_POINT = 2;
const NPC_MAX = 10;
const BOSS_FIRST = 1200; // 開始 60 秒後にボス出現
const BOSS_RESPAWN = 3600; // 倒されてから 3 分後に再出現
const CAPTURE_TICKS = 60; // ドラゴンボールの近くに 3 秒いると獲得
const CAPTURE_RANGE = 2.5;
const BURST_RANGE = 20; // ゲキシンバーストは敵の破壊神から 20 ブロック以内で使える
const BURST_DAMAGE = 0.3; // 破壊神の最大 HP の 30%
const END_TICKS = 200; // 勝利演出 10 秒
const TICKING_AREA = "gk_arena";

const GM = {
  adventure: GameMode.Adventure ?? GameMode.adventure,
  spectator: GameMode.Spectator ?? GameMode.spectator,
};

// hakaishin: 上・下レーンとドラゴンボール前の 3 体 { id, dead }
const freshTeam = () => ({
  burst: 0,
  hakaishin: Object.fromEntries(HAKAISHIN_SLOTS.map((slot) => [slot, { id: undefined, dead: false }])),
  dragonballId: undefined,
  capture: 0,
});

// ドラゴンボール前の破壊神が倒されていれば、そのチームのドラゴンボールを奪える
const dragonballOpen = (team) => match.teams[team].hakaishin.core.dead;
const laneBroken = (team) => match.teams[team].hakaishin.top.dead || match.teams[team].hakaishin.bottom.dead;

export const match = {
  phase: Phase.LOBBY,
  countdownEnd: 0,
  startTick: 0,
  endTick: 0,
  winner: undefined,
  teams: { A: freshTeam(), B: freshTeam() },
  bossId: undefined,
  bossNext: 0,
  npcNext: 0,
  pending: [], // 出現待ち (チャンク未読込で失敗したものを再試行) { kind, loc, team }
};

const players = () => world.getAllPlayers();
export const teamMembers = (team) => players().filter((p) => getState(p).team === team);
const inMatchPlayers = () => players().filter((p) => getState(p).inMatch);

function setMode(player, mode) {
  try {
    player.setGameMode(mode);
  } catch {}
}

function title(player, text, sub = "", stay = 40) {
  showTitle(player, text, sub, { stay });
}

function broadcast(text) {
  world.sendMessage(text);
}

// ---------- ロビー ----------

export function sendToLobby(player) {
  const s = getState(player);
  s.inMatch = false;
  s.dead = false;
  // ロビー未設定 (マップ作成中) の時はゲームモードも位置も変えない
  const lobby = getLoc("lobby");
  if (!lobby) return;
  try {
    player.teleport(lobby, { dimension: overworld() });
    player.setSpawnPoint({ dimension: overworld(), ...lobby });
  } catch {}
  setMode(player, GM.adventure);
}

// チーム変更。成功したら true
export function setTeam(player, team) {
  const s = getState(player);
  if (team && team !== s.team && teamMembers(team).length >= TEAM_MAX) {
    player.sendMessage(`§c${TEAM_NAME[team]}は満員です (${TEAM_MAX}人)`);
    return false;
  }
  s.team = team;
  s.ready = false;
  player.sendMessage(team ? `${TEAM_COLOR[team]}${TEAM_NAME[team]}§fに参加しました` : "§7観戦にしました");
  return true;
}

export function toggleReady(player) {
  const s = getState(player);
  if (!s.team) return player.sendMessage("§cチームを選んでください");
  if (!getPlayerCharacter(player)) return player.sendMessage("§cキャラを選んでください");
  s.ready = !s.ready;
  player.sendMessage(s.ready ? "§a準備完了！" : "§7準備完了を取り消しました");
}

// チームに入っている全員がキャラ選択済み・準備完了なら開始できる (1 人でもテストプレイ可)
function allReady() {
  const entrants = players().filter((p) => getState(p).team);
  return entrants.length > 0 && entrants.every((p) => getState(p).ready && getPlayerCharacter(p));
}

export function lobbyText() {
  const lines = [];
  for (const t of TEAMS) {
    const ms = teamMembers(t);
    lines.push(`${TEAM_COLOR[t]}§l${TEAM_NAME[t]} §r§7(${ms.length}/${TEAM_MAX})`);
    for (const p of ms) {
      const s = getState(p);
      lines.push(`  §f${p.name} §7- ${getPlayerCharacter(p)?.name ?? "未選択"} ${s.ready ? "§a準備OK" : "§c未準備"}`);
    }
  }
  const spectators = players().filter((p) => !getState(p).team);
  if (spectators.length) lines.push(`§7観戦: ${spectators.map((p) => p.name).join(", ")}`);
  return lines.join("\n");
}

// ---------- 試合開始 ----------

function setupArena() {
  const g = world.gameRules;
  try {
    g.doImmediateRespawn = true;
    g.keepInventory = true;
  } catch {}
  // NPC やボスが遠くでも動くように、全地点を囲むティッキングエリアを作る
  const locs = Object.keys(LOCATION_NAMES).map(getLoc).concat(getNpcPoints()).filter(Boolean);
  const xs = locs.map((l) => l.x);
  const zs = locs.map((l) => l.z);
  const y = Math.floor(getLoc("baseA").y);
  try {
    overworld().runCommand(`tickingarea remove ${TICKING_AREA}`);
  } catch {}
  try {
    overworld().runCommand(
      `tickingarea add ${Math.floor(Math.min(...xs)) - 16} ${y} ${Math.floor(Math.min(...zs)) - 16} ${Math.ceil(Math.max(...xs)) + 16} ${y} ${Math.ceil(Math.max(...zs)) + 16} ${TICKING_AREA} true`,
    );
  } catch {}
}

function deploy(player) {
  const s = getState(player);
  const base = getLoc(`base${s.team}`);
  s.inMatch = true;
  s.dead = false;
  resetProgress(player);
  resetCombatState(player);
  setMode(player, GM.adventure);
  try {
    player.setSpawnPoint({ dimension: overworld(), ...base });
    player.teleport(base, { dimension: overworld() });
  } catch {}
  giveKit(player, true);
  player.getComponent("minecraft:health").resetToMaxValue();
}

function abortStart(reason) {
  broadcast(reason);
  match.phase = Phase.LOBBY;
  // 準備完了のままだとカウントダウンが繰り返されるので解除
  for (const p of players()) getState(p).ready = false;
}

export function startBattle(force = false) {
  const missing = missingLocations();
  if (missing.length) {
    return abortStart(`§c地点が未設定のため開始できません: ${missing.map((k) => LOCATION_NAMES[k]).join(", ")}\n§7/scriptevent gk:autosetup でテスト用に自動配置できます`);
  }
  const entrants = players().filter((p) => getState(p).team && getPlayerCharacter(p));
  if (!entrants.length) return abortStart("§cチームとキャラを選んだプレイヤーがいません");
  removeGameEntities();
  setupArena();
  const now = system.currentTick;
  Object.assign(match, {
    phase: Phase.BATTLE,
    startTick: now,
    winner: undefined,
    teams: { A: freshTeam(), B: freshTeam() },
    bossId: undefined,
    bossNext: now + BOSS_FIRST,
    npcNext: now + 100,
    pending: [],
  });
  for (const t of TEAMS) {
    for (const slot of HAKAISHIN_SLOTS) match.pending.push({ kind: "hakaishin", loc: getLoc(`hakaishin${t}_${slot}`), team: t, slot });
    match.pending.push({ kind: "dragonball", loc: getLoc(`dragonball${t}`), team: t });
  }
  for (const p of entrants) {
    deploy(p);
    title(p, "§6§lバトル開始！", `${TEAM_COLOR[getState(p).team]}${TEAM_NAME[getState(p).team]}§f - 敵陣のドラゴンボールを奪え！`, 60);
    playSound(p.dimension, "raid.horn", p.location);
  }
  broadcast(`§6=== バトル開始 === ${force ? "§7(強制開始)" : ""}`);
}

// 途中参加
export function joinBattle(player) {
  const s = getState(player);
  if (match.phase !== Phase.BATTLE) return player.sendMessage("§c試合中ではありません");
  if (!s.team || !getPlayerCharacter(player)) return player.sendMessage("§cチームとキャラを選んでください");
  deploy(player);
  broadcast(`${TEAM_COLOR[s.team]}${player.name}§f が途中参加しました`);
}

// ---------- 試合終了 ----------

function win(team) {
  match.phase = Phase.END;
  match.winner = team;
  match.endTick = system.currentTick + END_TICKS;
  broadcast(`${TEAM_COLOR[team]}§l${TEAM_NAME[team]}§r§6 がドラゴンボールを獲得！ 勝利！`);
  for (const p of players()) {
    const mine = getState(p).team === team;
    title(p, `${TEAM_COLOR[team]}§l${TEAM_NAME[team]} 勝利！`, mine ? "§6ドラゴンボールを獲得した！" : "§7ドラゴンボールを奪われた…", 120);
    playSound(p.dimension, mine ? "random.totem" : "mob.wither.death", p.location);
  }
}

export function resetToLobby() {
  removeGameEntities();
  try {
    overworld().runCommand(`tickingarea remove ${TICKING_AREA}`);
  } catch {}
  match.phase = Phase.LOBBY;
  match.pending = [];
  for (const p of players()) {
    const s = getState(p);
    s.ready = false;
    resetProgress(p);
    resetCombatState(p);
    sendToLobby(p);
    giveKit(p, false);
    try {
      p.getComponent("minecraft:health").resetToMaxValue();
    } catch {}
  }
  broadcast("§7ロビーに戻りました。チーム・キャラを選んで準備完了してください");
}

// ---------- ゲキシンバースト ----------

export function useBurst(player) {
  const s = getState(player);
  if (match.phase !== Phase.BATTLE || !s.inMatch || s.dead) return notify(player, "§c試合中のみ使えます");
  const team = s.team;
  const ts = match.teams[team];
  if (ts.burst < 100) return notify(player, `§cゲキシンゲージが足りません (${Math.floor(ts.burst)}%)`);
  // 範囲内で一番近い、攻撃できる (結界が無い) 敵の破壊神
  const enemy = otherTeam(team);
  const hk = Object.values(match.teams[enemy].hakaishin)
    .map((h) => !h.dead && h.id && world.getEntity(h.id))
    .filter((e) => e?.isValid && !e.hasTag(NO_ATTACK_TAG) && V.dist(e.location, player.location) <= BURST_RANGE)
    .sort((a, b) => V.dist(a.location, player.location) - V.dist(b.location, player.location))[0];
  if (!hk) return notify(player, `§c攻撃できる敵の破壊神の近く(${BURST_RANGE}ブロック以内)で使ってください`);

  ts.burst = 0;
  const c = center(hk);
  // 演出: 味方全員から破壊神へ光の柱 → 大爆発
  for (const m of teamMembers(team).filter((p) => getState(p).inMatch)) {
    title(m, "§6§lゲキシンバースト！", `§f${player.name} が発動`, 40);
    const from = center(m);
    const dir = V.norm(V.sub(c, from));
    const len = V.dist(from, c);
    for (let d = 0; d < len && d < 40; d += 1) spawnParticle(m.dimension, "minecraft:totem_particle", V.add(from, V.scale(dir, d)));
  }
  for (let i = 0; i < 4; i++) {
    system.runTimeout(() => {
      if (!hk.isValid) return;
      spawnParticle(hk.dimension, "minecraft:huge_explosion_emitter", V.add(c, { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() * 2 - 1 }));
      playSound(hk.dimension, "random.explode", c, { volume: 1.5 });
    }, i * 5);
  }
  dealTrueDamage(player, hk, getStat(hk, "hp") * BURST_DAMAGE);
}

// ゲキシンゲージ: 敵の破壊神に与えたダメージで溜まる
onDamage((source, target, dmg) => {
  if (target.typeId === "minecraft:player") getState(target).lastHurt = system.currentTick;
  if (match.phase !== Phase.BATTLE || source.typeId !== "minecraft:player") return;
  if (kindOf(target) !== "hakaishin") return;
  const team = getTeam(source);
  if (!team || team === getTeam(target)) return;
  const ts = match.teams[team];
  const before = ts.burst;
  ts.burst = Math.min(100, ts.burst + dmg / 25);
  if (before < 100 && ts.burst >= 100) {
    for (const m of teamMembers(team)) {
      title(m, "§6§lゲキシンゲージMAX！", "§f敵の破壊神の近くでバーストアイテムを使え！", 40);
      playSound(m.dimension, "beacon.activate", m.location);
    }
  }
});

// ---------- 撃破・経験値 ----------

function teamReward(team, xp, near, radius) {
  for (const m of teamMembers(team).filter((p) => getState(p).inMatch)) {
    if (near && V.dist(m.location, near) > radius) continue;
    addXp(m, xp);
    notify(m, `§b+${xp} XP`, 30);
  }
}

// 全員に音を鳴らす (それぞれの位置で鳴らすので遠くても聞こえる)
function soundAll(id, options) {
  for (const p of players()) playSound(p.dimension, id, p.location, options);
}

// 撃破演出: 倒した場所に派手なパーティクル、倒した本人に派手な音
function killFx(killer, pos, big) {
  const dim = killer.dimension;
  spawnParticle(dim, big ? "minecraft:huge_explosion_emitter" : "minecraft:large_explosion", pos);
  spawnParticle(dim, "minecraft:totem_particle", pos);
  for (let i = 0; i < 3; i++) {
    system.runTimeout(() => {
      spawnParticle(dim, "minecraft:totem_particle", V.add(pos, { x: Math.random() * 2 - 1, y: Math.random() * 2, z: Math.random() * 2 - 1 }));
    }, i * 3);
  }
  playSound(dim, "random.orb", killer.location, { pitch: 1.5 });
  playSound(dim, big ? "firework.large_blast" : "firework.blast", killer.location);
  system.runTimeout(() => playSound(dim, "firework.twinkle", killer.location), 6);
  if (big) playSound(dim, "random.anvil_land", killer.location, { pitch: 1.6, volume: 0.6 });
}

function onHakaishinDefeated(dead, deadTeam) {
  const slot = slotOf(dead);
  const ts = match.teams[deadTeam];
  if (ts.hakaishin[slot]) ts.hakaishin[slot].dead = true;
  const name = dead.nameTag.split("\n")[0];
  soundAll("mob.enderdragon.death", { volume: 0.6 });
  soundAll("raid.horn", { volume: 0.8 });

  if (slot === "core") {
    broadcast(`${TEAM_COLOR[deadTeam]}§l${name}§r§6 が倒された！ ${TEAM_NAME[deadTeam]}のドラゴンボールを奪えるようになった！`);
    for (const p of players()) title(p, `${TEAM_COLOR[deadTeam]}§l${name} 撃破！`, `§6${TEAM_NAME[deadTeam]}のドラゴンボールが無防備に！`, 50);
    return;
  }
  broadcast(`${TEAM_COLOR[deadTeam]}§l${name}§r§6 が倒された！`);
  // レーンの破壊神を 1 体倒すと、ドラゴンボール前の破壊神の結界が解ける
  const core = ts.hakaishin.core.id && world.getEntity(ts.hakaishin.core.id);
  if (core?.isValid && core.hasTag(NO_ATTACK_TAG)) {
    setShield(core, false);
    broadcast(`${TEAM_COLOR[deadTeam]}${TEAM_NAME[deadTeam]}§fのドラゴンボールを守る破壊神の§l結界が解けた！`);
    soundAll("random.glass", { pitch: 0.6 });
  }
}

export function onEntityDie(dead, damageSource) {
  const now = system.currentTick;
  forgetEntity(dead.id);
  const kind = dead.typeId === "minecraft:player" ? "player" : kindOf(dead);

  if (kind === "player") {
    const s = getState(dead);
    if (match.phase === Phase.BATTLE && s.inMatch) {
      s.dead = true;
      s.respawnAt = now + Math.round((RESPAWN_TICKS + s.level * 20) * cardScale(s.cards, "respawnScale"));
    }
  }
  if (match.phase !== Phase.BATTLE) return;

  if (kind === "boss") match.bossNext = now + BOSS_RESPAWN;
  const deadTeam = getTeam(dead);
  if (kind === "hakaishin" && deadTeam) onHakaishinDefeated(dead, deadTeam);

  const killer = damageSource?.damagingEntity;
  if (!killer?.isValid || killer.typeId !== "minecraft:player" || !getState(killer).inMatch) return;
  const kTeam = getState(killer).team;
  const pos = center(dead);
  switch (kind) {
    case "npc":
      addXp(killer, XP_REWARD.npc);
      notify(killer, `§a撃破！ §b+${XP_REWARD.npc} XP`, 25);
      killFx(killer, pos, false);
      break;
    case "boss":
      // チームで倒すと大きな報酬: 近くの味方全員に経験値 + 60 秒間 全攻撃力アップ
      broadcast(`${TEAM_COLOR[kTeam]}${TEAM_NAME[kTeam]}§6 がボス「大猿」を撃破！ 報酬: 経験値 + 全攻撃力アップ`);
      teamReward(kTeam, XP_REWARD.boss, dead.location, 40);
      for (const m of teamMembers(kTeam).filter((p) => getState(p).inMatch)) {
        addModifiers(m, "boss_reward", { atkAll: 15 }, 1200);
        title(m, "§6§lボス撃破！", "§f経験値 + 全攻撃力アップ(60秒)", 40);
      }
      killFx(killer, pos, true);
      soundAll("mob.ravager.death");
      break;
    case "hakaishin":
      teamReward(kTeam, XP_REWARD.hakaishin);
      killFx(killer, pos, true);
      break;
    case "player":
      if (getState(dead).team !== kTeam) {
        const xp = 100 + 10 * getState(dead).level;
        addXp(killer, xp);
        notify(killer, `§c§l${dead.name} を撃破！ §r§b+${xp} XP`, 40);
        killFx(killer, pos, true);
        broadcast(`${TEAM_COLOR[kTeam]}${killer.name} §7が ${TEAM_COLOR[getState(dead).team] ?? "§f"}${dead.name} §7を倒した`);
      }
      break;
  }
}

export function onPlayerSpawn(player, initialSpawn) {
  const s = getState(player);
  if (initialSpawn) {
    // 参加したらロビーへ (試合中ならメニューから途中参加できる)
    sendToLobby(player);
    giveKit(player, false);
    if (match.phase === Phase.BATTLE) player.sendMessage("§e試合中です。メニューからチーム・キャラを選んで途中参加できます");
    return;
  }
  if (match.phase === Phase.BATTLE && s.inMatch && s.dead) {
    // 復活待ち: 自陣の上空で観戦
    setMode(player, GM.spectator);
    const base = getLoc(`base${s.team}`);
    try {
      player.teleport(V.add(base, { x: 0, y: 8, z: 0 }), { dimension: overworld() });
    } catch {}
  }
}

function revive(player) {
  const s = getState(player);
  s.dead = false;
  resetCombatState(player);
  setMode(player, GM.adventure);
  try {
    player.teleport(getLoc(`base${s.team}`), { dimension: overworld() });
  } catch {}
  player.getComponent("minecraft:health").resetToMaxValue();
  title(player, "§a復活！", "", 20);
}

// ---------- 毎 tick ----------

function tickPending() {
  match.pending = match.pending.filter(({ kind, loc, team, slot }) => {
    const e = trySpawn(kind, loc, team, slot);
    if (!e) return true; // 失敗 → 次回また試す
    if (kind === "hakaishin") {
      match.teams[team].hakaishin[slot].id = e.id;
      // ドラゴンボール前の破壊神は、レーンの破壊神が倒されるまで結界で守られる
      if (slot === "core" && !laneBroken(team)) setShield(e, true);
    }
    if (kind === "dragonball") match.teams[team].dragonballId = e.id;
    if (kind === "boss") match.bossId = e.id;
    return false;
  });
}

function tickCapture(now) {
  for (const team of TEAMS) {
    const enemy = otherTeam(team);
    const ts = match.teams[team];
    const db = match.teams[enemy].dragonballId && world.getEntity(match.teams[enemy].dragonballId);
    if (!db?.isValid) continue;
    const near = teamMembers(team).filter((p) => {
      const s = getState(p);
      return s.inMatch && !s.dead && V.dist(p.location, db.location) <= CAPTURE_RANGE;
    });
    if (!near.length) {
      ts.capture = 0;
      continue;
    }
    if (!dragonballOpen(enemy)) {
      for (const p of near) notify(p, "§cドラゴンボールの前の破壊神を倒すまで奪えない！", 10);
      ts.capture = 0;
      continue;
    }
    ts.capture += 5;
    for (const p of near) notify(p, `§6ドラゴンボール獲得中… ${Math.min(100, Math.floor((ts.capture / CAPTURE_TICKS) * 100))}%`, 10);
    if (ts.capture >= CAPTURE_TICKS) return win(team);
  }
}

// main から 5 tick ごとに呼ぶ
export function tickMatch(now) {
  switch (match.phase) {
    case Phase.LOBBY:
      if (allReady()) {
        match.phase = Phase.COUNTDOWN;
        match.countdownEnd = now + COUNTDOWN_TICKS;
        broadcast("§e全員準備完了！ まもなくバトル開始");
      }
      break;

    case Phase.COUNTDOWN: {
      if (!allReady()) {
        match.phase = Phase.LOBBY;
        broadcast("§cカウントダウンを中止しました (準備完了が取り消された)");
        break;
      }
      const left = match.countdownEnd - now;
      if (left <= 0) return startBattle();
      if (left % 20 === 0) {
        for (const p of players()) {
          title(p, `§e${left / 20}`, "§fバトル開始まで", 15);
          playSound(p.dimension, "random.click", p.location);
        }
      }
      break;
    }

    case Phase.BATTLE: {
      tickPending();
      // 復活
      for (const p of inMatchPlayers()) {
        const s = getState(p);
        if (!s.dead) continue;
        const left = s.respawnAt - now;
        if (left <= 0) revive(p);
        else if (left % 20 < 5) title(p, "§c倒された…", `§f復活まで ${Math.ceil(left / 20)} 秒`, 25);
      }
      // NPC 補充
      if (now >= match.npcNext) {
        match.npcNext = now + NPC_INTERVAL;
        let count = gameEntities("npc").length;
        for (const pt of getNpcPoints()) {
          for (let i = 0; i < NPC_PER_POINT && count < NPC_MAX; i++, count++) {
            match.pending.push({ kind: "npc", loc: V.add(pt, { x: Math.random() * 4 - 2, y: 0, z: Math.random() * 4 - 2 }) });
          }
        }
      }
      // ボス
      const bossAlive = match.bossId && world.getEntity(match.bossId)?.isValid;
      if (!bossAlive && match.bossNext && now >= match.bossNext && !match.pending.some((q) => q.kind === "boss")) {
        match.bossNext = 0; // 倒されたら onEntityDie で再設定
        match.pending.push({ kind: "boss", loc: getLoc("boss") });
        broadcast("§6§lボス「大猿」が出現した！ §r§7チームで倒すと大きな報酬");
      }
      tickCapture(now);
      if (now % 10 === 0) tickGameEntities(now);
      // 時間経過でも少し経験値
      if (now % 20 === 0) for (const p of inMatchPlayers()) if (!getState(p).dead) addXp(p, 2);
      break;
    }

    case Phase.END:
      if (now >= match.endTick) resetToLobby();
      break;
  }
}

// HUD 用の 1 行
export function matchHudLine(player, now) {
  const s = getState(player);
  if (match.phase === Phase.COUNTDOWN) return `§eバトル開始まで ${Math.ceil((match.countdownEnd - now) / 20)} 秒`;
  if (match.phase === Phase.LOBBY) {
    const team = s.team ? `${TEAM_COLOR[s.team]}${TEAM_NAME[s.team]}` : "§7チーム未選択";
    return `§7[ロビー] ${team} §7| ${s.ready ? "§a準備完了" : "§c未準備"}`;
  }
  if (!s.inMatch) return "§7[観戦中] メニューから途中参加できます";
  const xp = s.level >= MAX_LEVEL ? "§6MAX" : `§7XP ${Math.floor(s.xp)}/${xpToNext(s.level)}`;
  // 破壊神の状態: 上・下・ドラゴンボール前 (○=健在 ×=撃破)
  const hk = (t) => `${TEAM_COLOR[t]}${t}破壊神${HAKAISHIN_SLOTS.map((slot) => (match.teams[t].hakaishin[slot].dead ? "§8×" : "§a○")).join("")}`;
  const points = s.points ? ` §d§l強化P${s.points}` : "";
  return `§bLv${s.level} ${xp}${points} §r| ${hk("A")} ${hk("B")} §r| §6ゲキシン ${Math.floor(match.teams[s.team]?.burst ?? 0)}%`;
}
