#!/usr/bin/env node
// 驗證離線工作台的計算核心（RippleModel）。
// 用法：node tools/verify_workbench.js [工作台 HTML 路徑]
// 從 HTML 取出第一段 <script>（計算模型），在 Node 中執行並比對手算值。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] ||
  path.join(__dirname, '..', 'workbench', '電池Ripple_分析工作台_v1.3_離線單檔.html');
const html = fs.readFileSync(file, 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const sandbox = { module: { exports: {} } };
vm.runInNewContext(script, sandbox);
const M = sandbox.module.exports;

let fail = 0;
function near(name, got, want, tol = 1e-6) {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got} (預期 ${want})`);
}

// 1. 39.03 A 原圖：5.38 App 正弦、|Z| = 40 mV / 5.38 A、20 K DC 溫升
const r = M.calculate({});
const iac = 5.38 / (2 * Math.SQRT2);
near('Iac,rms (A)', r.rms, iac);
near('額外發熱比例 Pac/Pdc', r.heatRatio, (iac / 39.03) ** 2);
near('額外發熱比例 = 0.237508%', r.heatRatio * 100, 0.237508, 1e-5);
near('模組 ripple 電壓 (mVpp)', r.vpp * 1000, 40);
near('ripple 溫升 (K) = 20 K × 發熱比例', r.riseAC, 20 * r.heatRatio);
near('Arrhenius 速率增量 = 0.225993%', r.ageIncrease * 100, 0.225993, 1e-5);

// 2. 75 A 案例
near('75 A 額外發熱比例 = 0.064321%', M.calculate({ idc: 75 }).heatRatio * 100, 0.064321, 1e-5);

// 3. 正弦漣波發熱倍率 = m²/2（純電阻）
for (const m of [0.1, 0.5, 1]) {
  const q = M.calculate({ wave: 'sine', definition: 'pp', ripple: 2 * 39.03 * m, f: 120 });
  near(`m = ${m} 額外發熱 = m²/2`, q.heatRatio, m * m / 2);
}

// 4. 波形 RMS 換算
near('三角波 Ipp → RMS', M.calculate({ wave: 'triangle', ripple: 0.4 }).rms, 0.4 / (2 * Math.sqrt(3)));
near('方波 Ipp → RMS', M.calculate({ wave: 'square', ripple: 1 }).rms, 0.5);

// 5. RC 阻抗在 ωτ = 1 時：Re = R0 + Rp/2，Im = −Rp/2（v1.3 起為 2RC，第二支路設為 0）
const tau = 0.001, f1 = 1 / (2 * Math.PI * tau);
const rc = M.calculate({ mode: 'rc', r0: 5, rp: 2, tau, rp2: 0, lser: 0, f: f1 });
near('1RC Re{Z} (mΩ)', rc.re * 1000, 6);
near('1RC Im{Z} (mΩ)', rc.im * 1000, -1);

// 6. OCV 反查 SOC：線性曲線 2.5–3.65 V
const rows = M.parseOCV('0,2.5\n100,3.65');
const w = M.windowFor(rows, 2.5 + 0.115, 3.65 - 0.115);
near('SOC 電壓窗下界 (%)', w.min, 10);
near('SOC 電壓窗上界 (%)', w.max, 90);

if (M.lowFrequency) {
  console.log('\n--- v1.3：2RC、充電側 SOC、100/120 Hz ---');
  // 7. 串聯電感：Im{Z} 增加 ωL
  const zl = M.calculate({ mode: 'rc', r0: 5, rp: 0, rp2: 0, lser: 100, f: 10000 });
  near('串聯 100 nH 在 10 kHz 的 Im{Z} (mΩ)', zl.im * 1000, 2 * Math.PI * 1e4 * 100e-9 * 1000);
  // 8. 充電側 SOC：下界固定為 0
  const wc = M.calculate({ socSide: 'charge', idc: 0, ripple: 0 }, rows);
  near('充電側 SOC 下界 (%)', wc.dcWindow.min, 0);
  near('充電側 SOC 上界 (%)', wc.dcWindow.max, 100);
  // 9. 純電阻時介面過電位為 0；拆分後 端電壓 = 歐姆 + 介面
  near('R₀ = R 時介面峰值', M.calculate({}).vpeakIntf, 0);
  const sp = M.calculate({ mode: 'rc', f: 120 });
  near('2RC 法拉第電流比例 = 1/|1+jωτ₁|', sp.faradaic, 1 / Math.hypot(1, 2 * Math.PI * 120 * 0.002));
  // 10. 緩衝能量 Epp = P(1−m)/(2π·fgrid)，README 100 W 例：60–100 V 電容下限
  for (const [grid, cWant] of [[50, 89.52465548919113], [60, 74.60387957432594]]) {
    const L = M.lowFrequency({ grid, idc: 1, vbat: 100, m: 0.1, apdLo: 60, apdHi: 100 });
    near(`${grid} Hz Epp (J)`, L.Epp, 90 / (2 * Math.PI * grid), 1e-5);
    near(`${grid} Hz APD 電容下限 (µF)`, L.cApd * 1e6, cWant, 1e-5);
  }
  // 11. 純電阻電池：發熱比 = ½m²(1+h4²)，微循環 ΔQpp = 2·Ipk/ω
  const pure = { r1: 0, r2: 0, lser: 0, r0: 7.434944 };
  near('純電阻 m=1 發熱比 = 50%', M.lowFrequency({ ...pure, m: 1 }).heatRatio, 0.5, 1e-5);
  near('純電阻 m=0.5、h4=20% 發熱比', M.lowFrequency({ ...pure, m: 0.5, h4: 0.2 }).heatRatio, 0.125 * 1.04, 1e-5);
  const lq = M.lowFrequency({ ...pure, m: 1 });
  near('ΔQpp (C) = 2·Ipk/(2π·100)', lq.Qpp, 2 * 39.03 / (2 * Math.PI * 100), 1e-5);
  near('純電阻時介面過電位峰值', lq.vInterfacePk, 0);
  near('純電阻端電壓峰值 = Ipk·R/Ns', lq.vTerminalPk, 39.03 * 7.434944e-3 / 16, 1e-5);
  // 12. 2RC 發熱 = ½(m·Idc)²·Re{Z(2f)}
  const l2 = M.lowFrequency({ m: 1 }), z100 = M.z2rc(100, 5e-3, 0, 1.2e-3, 0.002, 1.234944237918216e-3, 10).total[0];
  near('2RC m=1 額外發熱 (W)', l2.pac, 0.5 * 39.03 ** 2 * z100);
  // 13. BMS 取樣混疊
  near('100 Hz 以 10 Hz 取樣 → 0 Hz', M.aliasFreq(100, 10), 0);
  near('120 Hz 以 50 Hz 取樣 → 20 Hz', M.aliasFreq(120, 50), 20);
  near('100 Hz 以 1 kHz 取樣不混疊', M.lowFrequency({ fsBms: 1000 }).alias.aliased ? 1 : 0, 0);
}

console.log(fail ? `\n${fail} 項不符` : '\n全部通過');
process.exit(fail ? 1 : 0);
