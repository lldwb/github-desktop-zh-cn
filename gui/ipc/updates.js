// gui/ipc/updates.js — 更新组：更新管控（往 GitHub Desktop 注入闸门）/ 工具自更新
// 与 CLI 的分工：更新管控与 CLI 菜单 6) 同一套语义（判定只有一处）；工具自更新在 GUI 侧是
// **下载安装包 + 启动安装向导**，不能像 CLI 那样替换自身——那是 SEA 产物的方式，见 installGuiUpdate。
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { app, shell } = require('electron');

const common = require('../../scripts/common.js');
const patch = require('../../scripts/cmd/patch.js');
const restore = require('../../scripts/cmd/restore.js');
const update = require('../../scripts/update.js');
const net = require('../../scripts/net.js');

module.exports = function createUpdateHandlers(ctx) {
  const { ask, confirmed, requireTarget, notifyBusy, withBusy } = ctx;

  // 下载并启动 GUI 安装包。抽出来是因为两处要用：用户主动点「检查更新」时问过之后装，
  // 以及启动时自动检查到新版、用户点提示里的「下载并安装」。
  // GUI 产物是**安装包**（不是 CLI 那种单文件可执行体），所以不能像 scripts/update.js 的
  // apply 那样替换自身——那是 SEA 产物的方式，在 Electron 打包态会直接抛错。
  // 返回 `{ notes, hasError }`：起不来 / 校验没过都不算成功，由调用方如实告诉用户（见下面的注释）。
  async function installGuiUpdate(info) {
    const dest = path.join(app.getPath('temp'), info.guiAsset.name);
    notifyBusy('toolUpdate', `正在下载 v${info.latest} …`);
    try {
      // accept 头与 scripts/update.js 的 apply 同一条兜底口径（见那里的 downloadUrl 注释）：
      // 直链不看这个头，带上无害；万一拿到的是 API 端点，少了它只会回一份元数据 JSON——
      // 那东西会被当成安装包启动，这里没有 CLI 那边的文件头护栏，只能靠这条头挡住。
      await net.download(info.guiAsset.url, dest, {
        headers: { accept: 'application/octet-stream' },
        onProgress: (got, total) => {
          const pct = total ? `${Math.round((got / total) * 100)}%` : `${(got / 1048576).toFixed(0)} MB`;
          notifyBusy('toolUpdate', `正在下载 v${info.latest} … ${pct}`);
        },
      });
      // 校验和比对（Release 里那份 SHA256SUMS）：GUI 侧没有 CLI 那道文件头护栏——安装包形态不齐
      //（dmg 的 koly 在文件末尾那 512 字节 trailer 里、deb 是 ar 归档、AppImage 是追加了 squashfs
      // 的 ELF），魔数表既难写又不强。校验和正好补上这一环，而且更强：它证明的是「同一份字节」，
      // 不止「文件头像某种格式」。没随附件发清单的来源（Gitee）自动跳过。
      await update.verifySha256(dest, info.guiAsset.name, info.sumsUrl, (msg) => notifyBusy('toolUpdate', msg));
    } catch (e) {
      // 下载失败与校验失败都收敛成一句可读的说明：**没有启动任何东西**，也就不该报成功
      return { notes: [`没能准备好安装包：${e.message}`, `（下载位置：${dest}）`], hasError: true };
    } finally {
      notifyBusy(null, null);
    }

    // macOS 的 .dmg 与 Linux 的 .deb 不能直接当可执行文件起，交给系统打开；
    // Windows 的 -setup.exe 与 Linux 的 .AppImage 直接 spawn。
    const direct = process.platform === 'win32' || dest.endsWith('.AppImage');
    const cmd = direct ? dest : process.platform === 'darwin' ? 'open' : 'xdg-open';
    // spawn 的失败有**两条**通道，得都接住：起不来（ENOENT）走**异步** error 事件；而「文件在、
    // 内容却不是有效可执行体」在 Windows 上是**同步抛**的（实测：内容为 JSON、或 MZ 头后接垃圾时
    // 抛 `spawn UNKNOWN`，空文件抛 `EFTYPE`）。只等 error 事件接不住后者——异常会冒出本函数，
    // 被调用方报成「检查工具版本失败」：归因错，还丢了「文件在哪」这条唯一能照做的补救信息。
    // 接住却不回报，则成了「提示已启动安装向导、屏幕上什么都没发生」——用户只会以为装上了。
    // 故两条通道收进同一个 spawnError，等结果出来再回话：起不来就说清「文件在哪、请手动打开」。
    let child = null;
    let spawnError = null;
    try {
      child = spawn(cmd, direct ? [] : [dest], { detached: true, stdio: 'ignore' });
    } catch (e) {
      spawnError = e; // 见上：目标存在但不是有效可执行体时走这条
    }
    if (child) {
      spawnError = await new Promise((resolve) => {
        child.on('error', resolve); // 常驻：起不来时如实回报，也不会冒到进程级
        child.once('spawn', () => resolve(null));
      });
      child.unref();
    }
    if (spawnError) {
      return {
        notes: [`安装包已下载到 ${dest}，但没能启动它：${spawnError.message}`, '请手动打开上面这个文件完成安装。'],
        hasError: true,
      };
    }

    return {
      notes: [`已下载 v${info.latest} 的安装包并启动安装向导。`, '按向导装完后请重新打开本工具。'],
      hasError: false,
    };
  }

  return {
    // 更新管控：三选一（与 CLI 菜单同一套语义，两边不各写一份判定）。
    // 确认框在主进程内弹——渲染进程无法伪造，这是 preload 只暴露「动作」不暴露参数的原因。
    updateControl: async () => {
      const t = requireTarget();
      if (t.error) return t.error;
      const { target, version } = t;

      const on = common.getPatchGroups(version).includes('updateControl');
      return confirmed({
        askOptions: {
          buttons: ['没有字典就不更新', '完全禁止更新', '恢复自动更新', '取消'],
          defaultId: 0,
          cancelId: 3,
          message: `更新管控（当前：${on ? '已开启' : '未开启'}）`,
          detail: '往 GitHub Desktop 注入一道闸，决定它能不能自动更新。\n\n'
            + '· 没有对应字典就不更新：工具的字典跟上新版本了才放行（推荐）\n'
            + '· 完全禁止更新：不看字典，一律不放行\n'
            + '· 恢复自动更新：撤掉这道闸，回到官方行为（汉化保留）',
        },
        // 取消落在第 4 个按钮上（前三个都是要做的事），故取消判定与其余处理器不同
        isCancel: (choice) => choice.response === 3,
        task: 'updateControl',
        phase: '正在设置更新管控 …',
        run: async (choice) => {
          if (choice.response === 2) {
            const r = await restore.run({
              explicitPath: target.explicitPath, version, groups: ['updateControl'], quiet: true,
            });
            const kept = r.kept.includes('i18n') ? '，汉化保留' : '（已回到官方原版）';
            return { ok: true, notes: [`已恢复自动更新：撤掉了更新管控${kept}。`], restarted: r.restarted };
          }
          const mode = choice.response === 1 ? 'off' : 'guard';
          const r = await patch.run({
            explicitPath: target.explicitPath, version, quiet: true, updateControl: mode,
          });
          const what = mode === 'off' ? '完全禁止自动更新' : '没有对应字典就不更新';
          return { ok: true, notes: [`已开启更新管控（${what}）。`], restarted: r.restarted };
        },
      });
    },

    // 工具自更新：GUI 产物是**安装包**，不能像 CLI 那样替换自身（见 installGuiUpdate 的注释）。
    // 这个处理器给启动时那条自动提示用——用户点「下载并安装」时进来，不再重复问一遍。
    toolUpdateInstall: async () => {
      const info = await update.check();
      if (!info.hasUpdate) return { ok: false, error: `当前已是最新版本（v${info.current}）。` };
      if (!info.guiAsset) {
        return {
          ok: false,
          error: `发现新版本 v${info.latest}，但没有本平台（${process.platform}-${process.arch}）的安装包。`,
          hint: `可到 ${info.releaseUrl} 手动下载。`,
        };
      }
      const r = await installGuiUpdate(info);
      // 起不来 / 校验没过都不算装上了：如实回 error，别让界面弹一句「已启动安装向导」
      return r.hasError ? { ok: false, error: r.notes.join(' ') } : { ok: true, notes: r.notes };
    },

    // 检查工具自身有无新版本——只做这一件事（字典不走这里，见 syncDict）。
    // GUI 产物是安装包，走「下载 + 启动安装向导」，不替换自身（见 installGuiUpdate）。
    // 这里是**用户主动**点的检查更新，弹确认框不唐突；启动时那条自动检查只推提示、不打断。
    checkToolUpdate: async () => {
      const notes = [];
      let hasError = false;
      try {
        const info = await update.check();
        if (!info.hasUpdate) {
          notes.push(`本工具已是最新版本（v${info.current}）。`);
        } else if (info.guiAsset) {
          const choice = await ask({
            buttons: ['下载并安装', '稍后', '打开下载页'],
            defaultId: 0,
            cancelId: 1,
            message: `发现新版本 v${info.latest}（当前 v${info.current}）`,
            detail: '将下载安装包并启动安装向导。装完后请重新打开本工具。',
          });
          if (choice.response === 0) {
            const r = await installGuiUpdate(info);
            notes.push(...r.notes);
            if (r.hasError) hasError = true; // 没装成就是没装成，别混在「已完成」里
          } else if (choice.response === 2) {
            shell.openExternal(info.releaseUrl);
            notes.push(`已打开下载页：${info.releaseUrl}`);
          } else {
            notes.push(`发现新版本 v${info.latest}，已跳过。`);
          }
        } else {
          notes.push(`发现新版本 v${info.latest}（当前 v${info.current}）：请到 ${info.releaseUrl} 下载安装包。`);
        }
      } catch (e) {
        notes.push(`检查工具版本失败：${e.message}`);
        hasError = true;
      }
      return { ok: true, notes, hasError };
    },
  };
};
