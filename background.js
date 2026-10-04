/**
 * 悬浮便签 · 后台（MV3 service worker）
 *
 * 只做两件事：把「工具栏图标点击 / 快捷键」翻译成给当前标签页内容脚本的消息。
 * 页面在扩展安装前就已打开时，内容脚本还没注入——这里兜底注入一次再重发。
 */
const CONTENT_FILE = 'content.js'

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg)
    return true
  } catch {
    // 内容脚本未就绪（安装前已打开的页面）：注入后重试一次
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_FILE] })
      await chrome.tabs.sendMessage(tabId, msg)
      return true
    } catch {
      return false
    }
  }
}

async function dispatch(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) return
  await sendToTab(tab.id, msg)
}

chrome.action.onClicked.addListener(() => void dispatch({ type: 'toggle' }))

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-sticky') void dispatch({ type: 'toggle' })
  if (command === 'quick-add') void dispatch({ type: 'quick-add' })
})
