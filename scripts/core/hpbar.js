// 頭上表示用の HP バー
export function hpBar(ratio, length = 20) {
  const filled = Math.max(0, Math.min(length, Math.ceil(ratio * length)));
  const color = ratio > 0.5 ? "§a" : ratio > 0.25 ? "§e" : "§c";
  return `${color}${"|".repeat(filled)}§8${"|".repeat(length - filled)}`;
}
