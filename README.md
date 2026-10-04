# 悬浮便签 · vibenote

在任意页面上随手记 bug / 想法 / 优化点，按站点（origin）保存，一键复制成给 AI 的清单——
不用开第二个窗口、不用分屏，边用边记。

## 特性

- **随手记**：`Alt+Shift+A` 展开并聚焦输入框，Enter 添加，Shift+Enter 换行
- **按站点分组**：`localhost:8080` 的笔记不会和别的站点混在一起；记录自动带上当时的页面路径
- **一键复制**：整份清单按「站点 + 页面路径」聚合，直接粘给 AI 就能改代码
- **拖动 + 吸边**：面板和收起后的胶囊都能拖，松手贴到屏幕边缘自动吸附，位置被记住
- **不打扰**：点面板外任意处 / 按 Esc 自动收起；点 📌 钉住后不再自动收起
- **不污染宿主页面**：Shadow DOM 隔离样式；便签内的键盘事件 `stopPropagation`，在被测应用有全局快捷键时打字不会误触
- **草稿不丢**：输入到一半去勾选 / 删除别的条目，草稿和光标位置都保留

## 安装

从源码加载（开发者模式）：

1. 打开 `chrome://extensions`，右上角开启「开发者模式」
2. 点「加载已解压的扩展程序」，选择本仓库目录
3. 快捷键：`Alt+Shift+S` 显示 / 隐藏，`Alt+Shift+A` 快速添加

## 文件结构

```
manifest.json      MV3 清单（权限、快捷键、内容脚本注册）
content.js         内容脚本：便签 UI + 拖拽 + 存储（主要逻辑都在这）
background.js      service worker：把图标点击 / 快捷键翻译成给内容脚本的消息
make-icons.py      生成图标（16/32/48/128 PNG，纯标准库，无第三方依赖）
test.html          本地验证页：不经扩展直接加载 content.js，验证交互
icons/             图标产物
```

## 开发

```bash
python3 make-icons.py          # 重新生成图标
```

改完 `content.js` 后，在 `chrome://extensions` 点扩展的刷新按钮，再刷新目标页面即可。

`test.html` 可以用任意静态服务器打开（例如 `python3 -m http.server`），
在没有装扩展的情况下验证便签交互——脱离扩展环境时会自动回退到 `localStorage`。

## 设计说明

- **存储**：优先 `chrome.storage.local`，脱离扩展环境（直接当脚本跑）时回退 `localStorage`
- **幂等注入**：内容脚本只注入一次；页面在扩展安装前就已打开时，由后台脚本兜底注入再重发消息
- **扩展上下文失效兜底**：MV3 下扩展重载 / 更新后，已注入的内容脚本不会消失，但再调 `chrome.*` 会抛
  `Extension context invalidated`。每次调用前先探测，并把调用本身也包住，兜掉「探测与调用之间正好失效」的竞态，
  避免在别人的产品页面上抛出 unhandled rejection
- **拖动性能**：拖动过程只改 `transform`（rAF 节流，不触发重排），松手才落 `left/top` 并吸边
