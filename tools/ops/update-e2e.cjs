// 发版第 7 步「真机验证更新链路」的驱动器：spawn 产物实跑一遍「检查更新 → 下载 → 替换 → 重启」
// 用法：node tools/ops/update-e2e.cjs <产物exe> <bundle.cjs> [最长分钟数]
//   <产物exe>   沙箱里伪装打包态的可执行文件（拷一份 node.exe 即可，沙箱步骤见 docs/agents/发版.md 第 7 步）
//   <bundle.cjs> 内嵌旧版本号的 bundle（伪装旧版使用者，做法见同处）
//   [最长分钟数] 整体超时，缺省 10 分钟；超时杀掉产物进程、退出码 1
// 驱动逻辑：轮询产物 stdout——见「请选择」发 5\n（检查更新），见「现在更新并重启」发 Y\n（确认），stdin 始终不 end。
// stdin 不能 end：doUpdate 先异步跑 dict-sync（联网、数秒），这期间 stdin 已 EOF 的话 readline 提前 close，
// confirm() 处会抛「readline was closed」——管道一次性喂输入必踩（详见发版.md 第 7 步）。
// 退出码：0 = 两个提示都已收到且产物退出码为 0；1 = 参数缺失 / spawn 失败 / 超时 / 产物异常退出。
'use strict';
const { spawn } = require('child_process');

const [exe, bundle, minutesArg] = process.argv.slice(2);
if (!exe || !bundle) {
  console.error('用法：node tools/ops/update-e2e.cjs <产物exe> <bundle.cjs> [最长分钟数]（缺省 10 分钟）');
  process.exit(1);
}
const timeoutMs = (Number(minutesArg) > 0 ? Number(minutesArg) : 10) * 60 * 1000;
const child = spawn(exe, [bundle], { stdio: ['pipe', 'pipe', 'inherit'] });
let sent5 = false;
let sentY = false;
let out = '';
const send = (s) => {
  try { child.stdin.write(s); } catch { /* stdin 已关闭 */ }
};
const timer = setTimeout(() => {
  console.error(`\n[DRIVER] 超时（${timeoutMs / 60000} 分钟）：菜单已发送=${sent5} 确认已发=${sentY}，杀掉产物进程`);
  child.kill();
  process.exit(1);
}, timeoutMs);
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
  const text = out.slice(-3000);
  if (!sent5 && text.includes('请选择')) {
    send('5\n');
    sent5 = true;
  }
  if (!sentY && text.includes('现在更新并重启')) {
    setTimeout(() => send('Y\n'), 800); // 略等确认文案渲染完，避免与 readline 抢输入
    sentY = true;
  }
});
child.on('exit', (code) => {
  clearTimeout(timer);
  const ok = code === 0 && sent5 && sentY;
  console.log(`\n[DRIVER] 退出码 ${code}，菜单已发送=${sent5} 确认已发=${sentY}${ok ? '' : '（判失败）'}`);
  process.exit(ok ? 0 : 1);
});
child.on('error', (e) => {
  clearTimeout(timer);
  console.error(`[DRIVER] spawn 失败：${e.message}`);
  process.exit(1);
});
