import { system } from "@minecraft/server";
import { getState } from "./state.js";

// HP ゲージの見た目 (sabaibaruRPG-RP の font/glyph_E2.png の私用領域グリフ。0〜10 の 11 段階)
// 塗りの元の色は緑 (低いと黄・赤)。§f ならそのままの色、§4 などを掛けると色が変わる
const C = (...codes) => String.fromCharCode(...codes);
const HP_GLYPHS = [
  C(0xe2b0, 0xe2b1, 0xe2a2, 0xe2a3, 0xe293, 0xe284, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe2a0, 0xe2a1, 0xe2a2, 0xe2a3, 0xe293, 0xe284, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe290, 0xe291, 0xe292, 0xe284, 0xe293, 0xe284, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe290, 0xe291, 0xe291, 0xe292, 0xe293, 0xe284, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe212, 0xe283, 0xe284, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe212, 0xe213, 0xe274, 0xe275, 0xe248, 0xe248, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe212, 0xe213, 0xe214, 0xe265, 0xe248, 0xe248, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe213, 0xe214, 0xe214, 0xe215, 0xe247, 0xe248, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe213, 0xe214, 0xe214, 0xe215, 0xe216, 0xe247, 0xe239),
  C(0xe210, 0xe211, 0xe212, 0xe213, 0xe214, 0xe214, 0xe215, 0xe216, 0xe216, 0xe229),
  C(0xe210, 0xe211, 0xe212, 0xe213, 0xe214, 0xe214, 0xe215, 0xe216, 0xe216, 0xe219),
];

// ゲージ文字列 (HUD 専用。classic フォントのラベルでのみ正しく表示される)
export function glyphHpBar(ratio) {
  const step = Math.max(0, Math.min(10, Math.ceil((Number.isFinite(ratio) ? ratio : 0) * 10)));
  return HP_GLYPHS[step];
}

// ---------- タイトルの共有 ----------
// タイトルは 1 本しかないので、HUD 用 (gkhud_*) と通常のタイトル (レベルアップ等) を調整する

export const HUD_PARTY = "gkhud_p:";
export const HUD_SELF = "gkhud_s:";

// 通常のタイトル。表示中は HUD 用タイトルを送らない
export function showTitle(player, title, subtitle = "", { fadeIn = 5, stay = 40, fadeOut = 10 } = {}) {
  try {
    getState(player).titleBusyUntil = system.currentTick + fadeIn + stay + fadeOut;
    player.onScreenDisplay.setTitle(title, { subtitle, fadeInDuration: fadeIn, stayDuration: stay, fadeOutDuration: fadeOut });
  } catch {}
}

// HUD 用の本文を送る (内容が変わった時だけ)。画面中央には出ず、ui/gk_hud.json が表示し続ける
export function sendHud(player, prefix, text) {
  const s = getState(player);
  if (system.currentTick < s.titleBusyUntil) return;
  if (s.hudSent[prefix] === text) return;
  s.hudSent[prefix] = text;
  try {
    // 短すぎると処理の遅い端末で UI が読み取る前に消えるので長め (画面には出ない)
    player.onScreenDisplay.setTitle(prefix + text, { fadeInDuration: 0, stayDuration: 100, fadeOutDuration: 0 });
  } catch {}
}

// 入り直し等で UI 側の表示が消えた時に送り直す
export function resetHud(player) {
  getState(player).hudSent = {};
}
