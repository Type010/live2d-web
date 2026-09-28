# waifu-web

一行接入的 Live2D 网页看板娘组件：Cubism 3/4/5（`.moc3`）模型、跨组表情任意叠加、
自建 WebGL2 渲染管线（官方 Live2D Cubism SDK for Web 5）。零运行时依赖，
**模型与代码解耦**——模型放站点自己的静态目录或任意支持 CORS 的源，由清单驱动。

## 如何接入

1. 把 `dist/` 下的运行时放到站点静态目录：

```
live2d/
├── models.json          # 模型清单（data-models 指向它）
├── waifu.js
├── vendor/
│   ├── engine.js
│   ├── live2dcubismcore.min.js
│   └── shaders/WebGL/*.glsl
└── <模型目录>/           # moc3 / 贴图 / 物理 / 动作 / 表情
```

2. 放好模型目录并编写 `models.json`（格式见下）。
3. 页面插入一行（head 或 body 末尾均可）：

```html
<script defer src="/live2d/waifu.js" data-models="/live2d/models.json"></script>
```

组件也可以直接从 CDN 引，省去第 1 步：

```html
<script defer src="https://cdn.jsdelivr.net/gh/<user>/waifu-web@vX.Y.Z/dist/waifu.js"
        data-models="/live2d/models.json"></script>
```

接入后自检：桌面端页面空闲后（约 2-15 秒，视模型体积）左下角出现模型；悬停弹出工具栏；
点击有反应与气泡；移动端（<768px）零请求；`window.__waifuError` 为空。

## 适配参数

**script 标签 `data-*` 属性：**

| 属性 | 说明 | 默认 |
|---|---|---|
| `data-models` | 模型清单 URL | —（必填） |
| `data-core` | Cubism 内核 URL | 同目录 `vendor/live2dcubismcore.min.js` |
| `data-vendor` | 运行时目录（内核 / 引擎 / 着色器） | 同目录 `vendor/` |
| `data-min-width` | 启用的最小屏宽 | `768` |
| `data-z-index` | 容器 z-index | `9999` |
| `data-lazy` | 懒加载；置 `false` 时空闲预取清单里所有模型进浏览器缓存 | `true` |

**models.json 字段：**

| 字段 | 说明 |
|---|---|
| `version` | 清单格式版本，当前 `1` |
| `default` | 默认加载的模型 `id` |
| `models[].id` / `name` | 模型标识（切换用）与显示名（切换时的"登场"气泡用 `name`） |
| `models[].model` | `model3.json` 路径，支持相对路径或完整远程 URL |
| `models[].content` | **必填**，可见内容包围盒 `{minX,minY,maxX,maxY}`（画布像素坐标），由仓库脚本离线解析 moc3 得到；缺失即拒绝加载 |
| `models[].pixelsPerUnit` / `canvas` | **必填**，moc3 自带的画布信息（`canvas: [宽,高]`），与 `content` 同一脚本输出 |
| `models[].scale` | 模型大小系数（可选，默认 1）：显示高度 = 组件基准高度（内置 350px）× 该值，各模型独立调 |
| `models[].hideDrawables` | 要隐藏的网格 id 名数组（可选），如 `["ArtMesh199"]`。部分 VTS 模型自带"地面/阴影/背景板"网格，浅色页面看不出、深色页面会显形成色板，列在这里即整条跳过绘制 |
| `models[].expressions[].name` | 表情标识（API 调用用） |
| `models[].expressions[].label` | 表情面板按钮文字 |
| `models[].expressions[].file` | exp3 路径（相对模型目录） |
| `models[].expressions[].group` | 参数冲突组：同组互斥；不填则自由叠加 |
| `models[].expressions[].temp` | `true` 时可被"点击反应"随机使用 |
| `models[].messages` | 气泡文案：`greeting` / `tap` / `sleepy` 三组数组 |

示例：

```json
{
  "version": 1,
  "default": "pink-devil",
  "models": [
    {
      "id": "pink-devil",
      "name": "小恶魔",
      "model": "/live2d/pink-devil/model3.json",
      "content": { "minX": -1, "minY": 496, "maxX": 2661, "maxY": 3801 },
      "pixelsPerUnit": 2455,
      "canvas": [2455, 3800],
      "scale": 1,
      "expressions": [
        { "name": "heart", "label": "比心", "file": "exp-heart.exp3.json", "group": "pose", "temp": true },
        { "name": "blush", "label": "脸红", "file": "exp-blush.exp3.json", "group": "mood", "temp": true },
        { "name": "glasses", "label": "眼镜", "file": "exp-glasses.exp3.json" }
      ],
      "messages": {
        "greeting": ["哼～快来逗我玩吧！"],
        "tap": ["呀！干嘛戳我～"],
        "sleepy": ["Zzz……好困……先睡会儿……"]
      }
    }
  ]
}
```

同 `group` 的表情互斥，不同 `group`（或不填）的可同时开启。

## 适配一个新模型

1. **整理目录**：拷出 `*.moc3`、贴图目录、`physics3.json`、`*.exp3.json`、`*.motion3.json`，
   全部改为 ASCII 文件名；剔除 psd / UI 图 / `vtube.json` 等冗余。
2. **补全 model3.json**（VTS 导出的是裸清单）：
   - `FileReferences.Expressions`：登记全部表情（`vtube.json` 的 `Hotkeys` 段列出了它们）；
   - `FileReferences.Motions`：`Idle`（待机循环，必需）；`TapBody`（打瞌睡动作，**可选**——
     **有这个组才有"打瞌睡"状态**，组内首个动作即睡觉动作。没有睡觉动作就别建这个组）；
   - `Groups`：`EyeBlink: ["ParamEyeLOpen","ParamEyeROpen"]`、`LipSync: ["ParamMouthOpenY"]`。
3. **扫描参数冲突定互斥组**（多个表情占用同一组参数 ID 的必须归入同一 `group`）：

```sh
for f in *.exp3.json; do echo "-- $f"; grep -o '"Id": *"[^"]*"' "$f" | sort -u | tr '\n' ' '; echo; done
```

4. **算 content**：跑仓库脚本离线解析 moc3（用官方 core，无需浏览器）：

```sh
npm run build                                    # 确保 dist/vendor/live2dcubismcore.min.js 就位
node scripts/calc-content-box.mjs <模型>.moc3
# → {"id":...,"content":{...},"canvas":[...],"pixelsPerUnit":...}
```

   把输出的 `content`、`pixelsPerUnit`、`canvas` **全部**写进清单条目（三者缺一即拒绝加载）。
   脚本会自动跳过不可见的全幅背景网格（会把包围盒撑到画布边缘导致定位偏移），
   被跳过的网格列在 `skippedInvisibleGrids` 中可核对。
5. **写 models.json 条目**，刷新页面即生效。

## 部署注意

- **CORS**：模型与清单与页面不同源时，托管方需返回 `Access-Control-Allow-Origin`，否则贴图会被 WebGL 拒绝。
- **缓存**：模型与表情文件内容不变，建议 `max-age=31536000, immutable`；清单由组件每次强制拉最新，无需特殊配置。
- **体积**：精细模型 20-40MB 属常态；移动端（<768px）自动跳过、零请求。
- **版权**：VTS 创意工坊模型的许可通常仅限 VTS 内使用，网页部署前确认授权。本仓库不收集任何模型文件。

## 调试与调参

参数都在 [`src/config.js`](src/config.js) 的 `DEFAULT_CONFIG` 里，**改完要重新构建**；
它们不开放 `data-*` 覆盖，也不要写进模型文件（都是通用行为，不按模型分支）。

| 参数 | 作用 | 默认 |
|---|---|---|
| `modelHeight` | 模型基准显示高度（px）。实际大小 = 该值 × 清单里的 `scale`，并受画布宽度与视口高度约束 | `350` |
| `maxFps` | 渲染帧率上限（`0` = 不限）。高刷屏上限制帧率能明显减轻宿主页面负担 | `60` |
| `maxDpr` | 画布像素比上限。截断过低会在高分屏上放大位图、画面发糊 | `3` |
| `height` | 初始画布高度（px），仅加载期间兜底，模型就绪后按 `content` 自动贴合 | `240` |
| `gaze.*` | 视线幅度与弹簧手感：`amplitude` 总倍率、各轴比例、`spanScale` 灵敏度、`spring.follow` / `inertia`、摆动与冲量 | 见源码 |
| `blink.*` | 眨眼：`enabled` / `interval`（秒，实际在 0~2 倍间随机）/ `duration` | `3.5` / `0.25` |
| `behaviors.*` | 开场白、空闲随机小表情、打瞌睡阈值（`sleepy.hiddenAfter` / `idleAfter`）、点击反应 | 见源码 |

排查用（浏览器控制台）：

```js
window.__waifuError        // 启动失败原因；为空表示正常。组件启动失败会写这里并静默退出
Waifu.debugBox()           // 用半透明紫色块标出模型矩形（contentBox），核对定位是否贴底贴左
Waifu.motion.debug()       // 视线权重、眨眼相位、睡眠状态机、弹簧刻度
Waifu.config               // 当前生效的完整配置（含 data-* 覆盖后的值）
Waifu.settings.get()       // 访客可调项（幅度 / 灵敏度 / 跟手 / 惯性 / 摆动 / 触碰反应 / 帧率上限）
```

`debugBox()` 是定位问题最直接的检查手段：紫色框应**恰好包住模型**——框偏大说明 `content` 不对，
模型溢出框说明显示尺寸或画布高度算错。

## 构建

```sh
npm install          # 仅 devDependency: esbuild
npm run build        # src/ -> dist/waifu.js + dist/vendor/engine.js
```

构建产物即接入所需的全部运行时文件。改渲染相关代码后必须重建**两个**产物
（引擎 chunk 需要 `--alias:@framework=...`，只重建主 bundle 会"改了没反应"）。
