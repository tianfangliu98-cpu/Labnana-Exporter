/**
 * Service worker：消息中继 + 下载调度。
 *
 * 真正的重活都在离屏文档里做，这里只负责三件事：
 *  1. 保证离屏文档存在；
 *  2. 把内容脚本的导出请求转交过去，把进度转回来；
 *  3. 调 chrome.downloads 把生成的压缩包落盘。
 *
 * SW 随时可能被浏览器回收，所以这里不保存任何不可恢复的状态。
 */

const OFFSCREEN_URL = "offscreen.html";
const DEFAULT_SETTINGS = {
  saveAs: false,
  includeRefs: true,
};

let activeTabId = null;
let offscreenCreating = null;
/** downloadId -> 压缩包分卷号，用于下载完成后回收 blob。 */
const downloadParts = new Map();

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    if (contexts.length > 0) return;
  }
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "在本地抓取图片并打包为 zip，再交给下载管理器保存。",
    })
    .catch((err) => {
      // 已存在时 createDocument 会抛错，属于正常情况
      if (!String(err?.message || err).includes("Only a single offscreen")) throw err;
    })
    .finally(() => {
      offscreenCreating = null;
    });
  await offscreenCreating;
}

async function forwardToTab(message) {
  if (!activeTabId) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) activeTabId = tab.id;
  }
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, message);
  } catch {
    // 标签页已关闭，静默忽略
  }
}

/** 下载完成后释放 blob，避免整包一直挂在内存里。 */
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || delta.state.current !== "complete") return;
  const part = downloadParts.get(delta.id);
  if (!part) return;
  downloadParts.delete(delta.id);
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: "EXPORT_REVOKE", part });
  } catch {
    /* 离屏文档可能已关闭，blob 随上下文消失，无需处理 */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "PING") {
    respond({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }

  if (msg.type === "EXPORT_START") {
    activeTabId = sender.tab?.id ?? msg.tabId ?? activeTabId;
    (async () => {
      try {
        await ensureOffscreen();
        const result = await chrome.runtime.sendMessage({
          type: "EXPORT_JOB",
          job: {
            items: msg.items,
            headers: msg.headers,
            filenameBase: msg.filenameBase,
            includeRefs: msg.includeRefs,
            skipImages: msg.skipImages,
            naming: msg.naming,
          },
        });
        respond(result ?? { ok: true });
      } catch (err) {
        respond({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (msg.type === "EXPORT_PART_READY") {
    (async () => {
      const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
      try {
        const downloadId = await chrome.downloads.download({
          url: msg.url,
          filename: msg.filename,
          saveAs: !!settings.saveAs,
          conflictAction: "uniquify",
        });
        downloadParts.set(downloadId, msg.part);
        respond(downloadId);
      } catch (err) {
        respond(null);
        forwardToTab({
          type: "EXPORT_LOG",
          level: "error",
          message: `触发下载失败：${err?.message || err}`,
        });
      }
    })();
    return true;
  }

  if (
    msg.type === "EXPORT_PROGRESS" ||
    msg.type === "EXPORT_LOG" ||
    msg.type === "EXPORT_DONE" ||
    msg.type === "EXPORT_FAILED"
  ) {
    chrome.storage.local.set({ lastEvent: { ...msg, at: Date.now() } });
    forwardToTab(msg);
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...stored });
});
