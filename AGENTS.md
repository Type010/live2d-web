# AGENTS.md — waifu-web 适配指南

本文件面向 AI 编程代理与自动化工具：说明如何把 waifu-web 组件接入网站、如何适配新的 Live2D 模型。

## 组件速览

- 形态：IIFE 单文件 `dist/waifu.js`；运行时在 `dist/vendor/`，由组件按需注入——
  `live2dcubismcore.min.js`（官方内核，必须早于引擎加载）、`engine.js`（官方 Cubism SDK 5 框架 + 适配层，
  独立 chunk）、`shaders/WebGL/*.glsl`（官方 GLSL，运行时按文件 fetch）。图标是内联 SVG，随 bundle 走。
- 构建：`npm run build` 产出上述两个 js（引擎 chunk 需要 `--alias:@framework=./src/sdk/framework`，
  改了 `src/motion` 或 `src/render` 必须两个都重建，只重建主 bundle 会"改了没反应"）。
- 配套工具：`scripts/calc-content-box.mjs` 离线算 content（适配新模型必用）。
- 支持模型：Cubism 3/4/5（`.moc3`）；**不支持** Cubism 2（`.moc`）。

## 网站接入清单（按序执行）

1. 放置组件文件到站点静态目录（或直接引用 jsDelivr `https://cdn.jsdelivr.net/gh/<user>/waifu-web@vX.Y.Z/dist/waifu.js`）：
   `waifu.js`、`vendor/engine.js`、`vendor/live2dcubismcore.min.js`、`vendor/shaders/WebGL/*.glsl`。
2. 放置模型目录与 `models.json`（清单格式见下节）。
3. 页面插入（head 或 body 末尾均可）：

```html
<script defer src="/live2d/waifu.js" data-models="/live2d/models.json"></script>
```

4. `data-*` 参数：`data-models`（清单 URL，必填）、`data-core`、`data-vendor`、`data-min-width`（默认 768）、
   `data-z-index`（默认 9999）、`data-lazy`（默认 true；置 false 时空闲预取所有模型资源进浏览器缓存）。
5. 验证清单：
   - 桌面端页面加载空闲后（约 2-15 秒，视模型体积）左下角出现模型；
   - 悬停模型弹出工具栏；表情面板可叠加/取消；点击模型有反应与气泡；
   - 移动端视口（<768px）下无 `/live2d/` 资源请求；
   - `window.Waifu` API 存在（say / toggleExpression / setExpressions / switchModel / playMotion / sleep / wake）；
   - `window.__waifuError` 为空（启动失败时组件会把错误写到这里并静默退出）。

## models.json 规范

顶层：`version: 1`、`default: "<model id>"`、`models: [...]`。
每个模型条目：`id`、`name`（中文名，切换时的"登场"气泡用它）、`model`（model3.json 路径，支持完整远程 URL）、
`content`（**必填**，见下）、`pixelsPerUnit` / `canvas`（**必填**，见下）、`scale`（显示大小系数，默认 1）、
`expressions[]`、`messages`（greeting/tap/sleepy 文案数组）、`hideDrawables`（可选）。
懒加载不由清单控制：所有模型都是"切换时才加载"，需要预取时在接入 script 标签上写 `data-lazy="false"`。

**`content` / `pixelsPerUnit` / `canvas` 三项必填**（缺任一即拒绝加载）：
`content` 是画布像素坐标的可见内容包围盒 `{minX,minY,maxX,maxY}`，
`pixelsPerUnit` 与 `canvas`（`[宽,高]`）是 moc3 自带的画布信息，三者由同一个脚本离线解析 moc3 得到（见 SOP 第 4 步）。
模型内部的逻辑单位 = 设计像素 ÷ pixelsPerUnit 且原点在画布中心，运行时用它们把 `content` 换算到模型空间，
一次性平移定位（内容贴底贴左）并算出画布高度，组件不做事后测量。

**`scale`**：模型显示大小 = 组件内置基准高度（350px）× 该值，各模型独立调大小
（如 `pink-devil: 1`、`bath: 0.8`）；同时受画布宽度与视口高度约束。

**`hideDrawables`（可选）**：要隐藏的网格 id 名数组，如 `["ArtMesh199","ArtMesh200"]`。
部分 VTS 模型自带"地面/阴影/背景板"网格（贴图上是大片纯色，4 顶点矩形，绘制序靠前），
在浅色页面上看不出来、在深色页面上会显形成一块色板；列在这里即可让组件把它们整条剔除
（走官方 `CubismModel.setDrawableCulling()`，装载时设一次，比把不透明度写 0 更彻底——置 0 时
顶点变换/纹理采样/混合照样跑一遍，剔除则根本不进绘制管线）。

`expressions[]` 每项：`name`（英文标识，API 用）、`label`（**表情按钮**上的中文文字，不是模型名）、
`file`（exp3 路径，相对模型目录）、`group`（互斥组，见下）、`temp`（可被点击反应随机使用）。

**group 语义**：同 `group` 的表情互斥（模型参数结构决定，如多个手部动作共用同一组参数）；
不同 `group` 或无 `group` 的表情**任意叠加**（合成引擎支持真正的参数级叠加，含 Add / Overwrite / Multiply 语义）。

## 新模型适配 SOP（VTS 模型通用）

1. **整理目录**：拷出 `*.moc3`、贴图目录、`physics3.json`、`*.exp3.json`、`*.motion3.json`，
   全部改为 ASCII 文件名；剔除 psd / UI 图 / `vtube.json` / 上传配置等冗余。
2. **补全 model3.json**（VTS 导出的是裸清单）：
   - `FileReferences.Expressions`：登记全部表情；
   - `FileReferences.Motions`：`Idle`（待机循环，必需）；`TapBody`（**打瞌睡动作，可选**——
     **有这个组才有"打瞌睡"这个状态**，组内首个动作即睡觉动作。模型动作资源里没有睡觉动作时
     就不要建这个组，否则空闲超时会去播一个与睡觉无关的动作）；
   - `Groups`：`EyeBlink: ["ParamEyeLOpen","ParamEyeROpen"]`、`LipSync: ["ParamMouthOpenY"]`
     （绝大多数模型用标准参数 ID，可从 `vtube.json` 的 ParameterSettings 佐证）。
3. **参数冲突扫描**（确定互斥组）：

```sh
for f in *.exp3.json; do echo "-- $f"; grep -o '"Id": *"[^"]*"' "$f" | sort -u | tr '\n' ' '; echo; done
```

   多个表情占用同一组参数 ID → 必须归入同一 `group`（组内单选）；参数独立则可自由叠加。
4. **计算 content（可见内容包围盒）**：跑仓库自带脚本离线解析 moc3（加载官方 core，无需浏览器）：

```sh
npm run build                                    # 确保 dist/vendor/live2dcubismcore.min.js 就位
node scripts/calc-content-box.mjs <模型>.moc3
# → {"id":"<模型>","content":{...},"canvas":[...],"pixelsPerUnit":...}
```

   把输出的 `content`、`pixelsPerUnit`、`canvas` **全部**写进清单条目（三者缺一即拒绝加载）。
   脚本会自动跳过不可见的全幅背景网格
   （4 顶点却横跨大半画布、默认 opacity=0 的遮罩，会把包围盒撑到画布边缘导致定位偏移），
   被跳过的网格列在 `skippedInvisibleGrids` 中可核对。
5. **写 models.json 条目**：模型中文名 `name`、`content` / `pixelsPerUnit` / `canvas`、`scale`（大小）、
   每个表情的 `group`、`temp`（参与随机行为）、文案。
   **模型文件里不要放本组件的配置**——视线幅度、眨眼节奏都是通用行为，只在 `src/config.js` 里调。
6. **验证**：加载渲染 → 视线跟随（含头/身体三轴）→ 眨眼（隔几秒一次）→ 表情叠加/互斥 →
   打瞌睡触发与唤醒（睡着时眼睛保持闭着、视线暂停）→ 模型切换 → 最小化/关闭记忆。

## 部署注意

- **CORS**：模型与清单与页面不同源时，托管方需返回 `Access-Control-Allow-Origin`，
  否则贴图会被 WebGL 拒绝（表现为模型完全不上屏）。
- **缓存**：模型与表情文件内容不变，建议 `max-age=31536000, immutable`；清单由组件每次强制拉最新。
- **单文件上限**：Cloudflare Workers/Pages 静态资产 25MB，jsDelivr 20MB，超出请放对象存储（需 CORS）。
- **移动端**：视口 <768px 时组件零加载、零请求，不要指望它在手机上出现。
