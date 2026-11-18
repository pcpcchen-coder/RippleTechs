#!/usr/bin/env node
// 驗證離線工作台的計算核心（RippleModel）。
// 用法：node tools/verify_workbench.js [工作台 HTML 路徑]
// 從 HTML 取出第一段 <script>（計算模型），在 Node 中執行並比對手算值。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2] ||
  path.join(__dirname, '..', 'workbench', '電池Ripple_分析工作台_v1.2_離線單檔.html');
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

// 5. 1RC 阻抗在 ωτ = 1 時：Re = R0 + Rp/2，Im = −Rp/2
const tau = 0.001, f1 = 1 / (2 * Math.PI * tau);
const rc = M.calculate({ mode: 'rc', r0: 5, rp: 2, tau, f: f1 });
near('1RC Re{Z} (mΩ)', rc.re * 1000, 6);
near('1RC Im{Z} (mΩ)', rc.im * 1000, -1);

// 6. OCV 反查 SOC：線性曲線 2.5–3.65 V
const rows = M.parseOCV('0,2.5\n100,3.65');
const w = M.windowFor(rows, 2.5 + 0.115, 3.65 - 0.115);
near('SOC 電壓窗下界 (%)', w.min, 10);
near('SOC 電壓窗上界 (%)', w.max, 90);

console.log(fail ? `\n${fail} 項不符` : '\n全部通過');
process.exit(fail ? 1 : 0);
