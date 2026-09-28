/**
 * 舞台：渲染（官方 Cubism SDK 5，引擎 chunk 见 src/render/engine-entry.js）、模型装载、
 * 尺寸适配、拖拽、视线跟随、点击判定。
 * 只负责"渲染与交互"这一层，状态与行为分别由 composer / behaviors 承担。
 * 引擎 chunk 在 mount 时按需加载：内核必须先就位（框架在模块求值期会读 Live2DCubismCore）。
 */
import { loadScript } from './loader.js';

const CANVAS_W = 360; // 画布宽度（mount / 缩放约束 / 内容水平定位共用）
const TOP_PAD = 12; // 画布顶部余量：内容头顶上方保留的空白（气泡尖角伸入区）

export class Stage {
	constructor(config) {
		this.config = config;
		this.app = null;
		this.model = null;
		this.onTap = null; // () => void，点击模型本体（非拖拽）时回调
		this.onAnchor = null; // (box) => void，内容对齐后通知 UI
		this.onHover = null; // (onModel) => void，悬停模型/UI 上时通知（工具栏显隐用）
		this.onContextRestored = null; // () => void，GPU 上下文恢复后通知上层重载模型
		this.contentBox = null; // 最近一次定位算出的内容包围盒（画布内坐标，来自清单 content）
		this._drag = null;
		this._lastHoverCheck = 0;
		this._hovering = false; // 上一次悬停判定结果（用于识别"指针刚移上模型"）
		this._pointerX = 0; // 指针速度采样（冲量方向用）
		this._pointerY = 0;
		this._pointerT = 0;
		this._pointerVx = 0;
		this._pointerVy = 0;
		this._destroyed = false;
		this.root = null;
		this._handlers = {};
	}

	/** 创建容器与渲染器并加入 DOM（引擎 chunk 在此时按需加载） */
	async mount() {
		injectRootStyles();
		const root = document.createElement('div');
		root.id = 'waifu-web';
		root.style.zIndex = String(this.config.zIndex);
		document.body.appendChild(root);
		this.root = root;

		await loadScript(`${this.config.vendorUrl}engine.js`);
		if (!window.WaifuEngine || !window.WaifuEngine.createEngine) {
			throw new Error('[waifu] 渲染引擎（engine.js）加载失败');
		}
		this.engine = window.WaifuEngine.createEngine(this.config);
		this.engine.mount(root);
		// 浏览器回收 GPU 上下文后又恢复时，引擎会重建 GL 侧资源并回调这里，
		// 由上层重新装载当前模型（顶点缓冲等资源在渲染器内部）
		this.engine.onContextRestored = () => {
			this.onContextRestored && this.onContextRestored();
		};
		this.engine.resize(CANVAS_W, this.config.height);
		// 对齐完成前隐藏画布，避免模型先出现在假设位置再"跳"到正确位置
		this.engine.canvas.style.transition = 'opacity .35s ease';
		this.engine.canvas.style.opacity = '0';

		this.bindDrag();
		this.bindGaze();
		this.bindResize();
	}

	/** 水平移动容器，左/右边缘不超出网页可视范围 */
	moveTo(left) {
		const root = this.root;
		const maxLeft = window.innerWidth - root.offsetWidth;
		root.style.left = `${Math.min(Math.max(left, 0), Math.max(maxLeft, 0))}px`;
	}

	/**
	 * 拖拽与点击：画布 pointer-events:none。模型占据的矩形区域（内容包围盒）
	 * 内的事件在 window 捕获阶段拦截并阻断默认行为——该区域内只能操作模型，
	 * 点击/拖拽不会落到宿主页面；区域外完全穿透。
	 * 组件自身 UI（工具栏/面板）上的事件直接放行，不参与命中判定。
	 */
	bindDrag() {
		const root = this.root;
		const clearDrag = () => {
			this._drag = null;
		};
		this._handlers.down = (e) => {
			if (this.isOwnUI(e)) return;
			if (!e.isPrimary || e.button !== 0) return; // 只响应鼠标/触摸主键
			if (!this.hitTestClient(e.clientX, e.clientY)) return;
			// 阻止事件传播与浏览器默认行为（文本选择、原生拖拽、兼容鼠标事件）
			e.stopPropagation();
			e.preventDefault();
			this._drag = { startX: e.clientX, startLeft: root.offsetLeft, moved: false };
		};
		this._handlers.move = (e) => {
			if (!this._drag) return;
			e.stopPropagation(); // 拖拽期间不把移动事件传给页面（避免触发页面跟随特效）
			// 按键已释放（窗口外松开、触摸被手势接管等）时自愈，避免状态滞留
			if (e.buttons === 0) {
				clearDrag();
				return;
			}
			const dx = e.clientX - this._drag.startX;
			if (!this._drag.moved && Math.abs(dx) < 6) return;
			this._drag.moved = true;
			this.moveTo(this._drag.startLeft + dx);
		};
		this._handlers.up = (e) => {
			if (!this._drag) return;
			const wasDrag = this._drag.moved;
			const inside = this.hitTestClient(e.clientX, e.clientY);
			clearDrag();
			e.stopPropagation(); // 在模型上结束的按下/拖拽不落向下层页面
			if (!wasDrag && inside) {
				// 戳一下：头身带着头发裙摆晃一下（方向随机，免得每次都朝同一边）
				const tap = this.impulseScale('tapImpulse');
				if (tap) {
					this.impulseGaze((Math.random() * 2 - 1) * tap, (Math.random() - 0.5) * tap * 0.8);
				}
				if (this.onTap) this.onTap();
			}
		};
		// click 是独立事件：pointerdown/up 的 stopPropagation 不影响它，
		// 需单独拦截模型范围内触发的 click（否则会触发模型下方元素的默认行为，如链接跳转）
		this._handlers.click = (e) => {
			if (this.isOwnUI(e)) return;
			if (this.hitTestClient(e.clientX, e.clientY)) {
				e.stopPropagation();
				e.preventDefault();
			}
		};
		// 触摸被浏览器手势接管时（滚动/缩放）会收到 pointercancel，需清掉拖拽状态
		this._handlers.cancel = clearDrag;
		window.addEventListener('pointerdown', this._handlers.down, true);
		// move 也注册在捕获阶段：拖拽中需先于页面收到并拦截，页面才拿不到移动事件
		window.addEventListener('pointermove', this._handlers.move, true);
		window.addEventListener('pointerup', this._handlers.up, true);
		window.addEventListener('pointercancel', this._handlers.cancel, true);
		window.addEventListener('blur', this._handlers.cancel);
		window.addEventListener('click', this._handlers.click, true);
	}

	/** 装载模型；entry 为清单条目，重复调用即切换模型（旧模型销毁） */
	async loadModel(entry) {
		// content（可见内容包围盒）必须在清单中预置，否则无法定位，直接拒绝加载
		if (!entry.content) throw new Error(`[waifu] 清单缺少 content 预置数据: ${entry.id}`);
		// 模型地址相对清单解析：清单可用相对路径，也可写完整 URL
		const base = this.config.modelsUrl ? new URL(this.config.modelsUrl, location.href).href : location.href;
		const url = new URL(entry.model, base).href;

		// 按"清单预置的可见内容包围盒"决定显示尺寸与画布大小：
		// 显示大小 = 组件基准高度 × 模型条目 scale（各模型独立调大小）；
		// 画布高度 = 内容显示高 + 顶部余量。官方渲染器建立时会读取画布尺寸，所以先算尺寸再加载。
		const box = entry.content;
		const contentW = box.maxX - box.minX;
		const contentH = box.maxY - box.minY;
		const targetHeight = Math.min(this.config.modelHeight * (entry.scale || 1), window.innerHeight * 0.55);
		const k = Math.min(targetHeight / contentH, CANVAS_W / contentW);
		const canvasH = Math.ceil(contentH * k) + TOP_PAD;
		// 画布尺寸不在这里改：新模型的 view 在 engine.loadModel 末尾才切换，
		// 若这里先改高度，加载的几秒里旧模型会贴到新画布的底边（表现为"切换时模型移位"）。
		// resize 与 view 切换在同一段同步代码里完成，中间没有渲染帧，不会出现错配画面。

		// 清单需预置离线脚本产出的基准：content（设计像素包围盒）、canvas（画布像素尺寸）、pixelsPerUnit
		if (!entry.pixelsPerUnit || !entry.canvas) throw new Error(`[waifu] 清单缺少 pixelsPerUnit / canvas: ${entry.id}`);
		const cubismModel = await this.engine.loadModel(entry, {
			k, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY,
			canvasW: CANVAS_W, canvasH, ppu: entry.pixelsPerUnit, pxW: entry.canvas[0], pxH: entry.canvas[1],
		});
		// 加载期间组件已被销毁（关闭看板娘）：丢弃在途模型，避免泄漏
		if (this._destroyed) return null;
		this.engine.resize(CANVAS_W, canvasH); // 新模型已就绪，同帧换画布尺寸

		// 我们的仿射矩阵把内容左上/底边分别贴到画布左上/底边，故内容盒可直接解析得出
		this.contentBox = { minX: 0, maxX: contentW * k, minY: TOP_PAD, maxY: canvasH };
		this.engine.canvas.style.opacity = '1';
		this.onAnchor && this.onAnchor(this.contentBox);
		// 调试框若开着，切换模型后同步到新模型的矩形（元素存在即视为开启，无需额外状态）
		if (this.root && this.root.querySelector('.waifu-debug-box')) this.setDebugBox(true);

		// 对外可观测句柄：诊断页等处用 this.model 判断「模型是否已加载」（真正的引擎实例在 this.engine）
		this.model = { baseUrl: url, cubismModel };
		return { ...this.model, resolveParamId: (name) => this.engine.resolveParamId(name) };
	}

	/** 视线跟随 + 悬停判定（画布穿透后统一在 document 层处理） */
	bindGaze() {
		this._handlers.gaze = (e) => {
			// 视线用视口坐标（指针在页面任何位置都应产生合理偏移，不受画布小范围限制）；
			// 悬停判定仍用画布坐标（判断指针是否落在模型占据的矩形内）
			if (this.engine) this.engine.setGaze(e.clientX, e.clientY);
			this.trackPointerSpeed(e.clientX, e.clientY);
			// 指针速度喂给核心：驱动"反着鼠标移动方向"的身体摆动（鼠标在模型身上时更明显）
			if (this.engine) this.engine.setPointerSpeed(this._pointerVx, this._pointerVy);
			const now = Date.now();
			if (now - this._lastHoverCheck < 120) return;
			this._lastHoverCheck = now;
			const [px, py] = this.toCanvasXY(e.clientX, e.clientY);
			// 悬停在 UI（工具栏/气泡）上视同在模型上，避免工具栏被延时收起
			const onModel = this.isOwnUI(e) || this.inContentBox(px, py);
			if (this.engine) this.engine.setHover(onModel);
			// 指针刚移上模型：按移入方向给一次冲量——"被碰一下会晃"就来自这里，
			// 头身晃起来后头发/裙摆的物理链会跟着摆动，观感比单纯跟随灵动得多。
			// 强度 = 基础值 ×（0.6 + 0.4×指针速度）：慢慢挪进来也会晃，快速划过更明显
			if (onModel && this._hovering === false) {
				const imp = this.impulseScale('hoverImpulse');
				if (imp) {
					const dirX = this._pointerVx >= 0 ? 1 : -1;
					const dirY = this._pointerVy >= 0 ? 1 : -1;
					const speed = Math.min(1, Math.hypot(this._pointerVx, this._pointerVy));
					// 反向（惯性：指针往右带，模型先往左让一下再跟过去）
					const k = imp * (0.6 + 0.4 * speed);
					this.impulseGaze(-dirX * k, -dirY * k * 0.35);
				}
			}
			this._hovering = onModel;
			this.onHover && this.onHover(onModel);
		};
		document.addEventListener('pointermove', this._handlers.gaze);
	}

	/**
	 * 记录指针速度（平滑后归一到约 ±1）。
	 * 归一化基准取 700 px/s：真实鼠标快速划动约 700~1200 px/s，这样"明显在动"就能到 ±0.6~1，
	 * 而不是被大基数压到 0.05 那种看不出效果的量级。只累加状态、不读布局，可以每个 pointermove 调用。
	 */
	trackPointerSpeed(x, y) {
		const now = performance.now();
		if (this._pointerT) {
			const dt = Math.max(0.016, (now - this._pointerT) / 1000);
			const k = 0.45; // 指数平滑，避免单帧抖动被当成"快速移动"
			this._pointerVx += ((x - this._pointerX) / dt / 700 - this._pointerVx) * k;
			this._pointerVy += ((y - this._pointerY) / dt / 700 - this._pointerVy) * k;
			const clamp = (v) => Math.max(-1, Math.min(1, v));
			this._pointerVx = clamp(this._pointerVx);
			this._pointerVy = clamp(this._pointerVy);
		}
		this._pointerX = x;
		this._pointerY = y;
		this._pointerT = now;
	}

	/** 冲量强度（0 表示关闭；配置缺失时按 0 处理，不做任何动作） */
	impulseScale(key) {
		const gaze = this.config && this.config.gaze;
		const v = gaze ? gaze[key] : 0;
		return typeof v === 'number' && isFinite(v) ? Math.max(0, v) : 0;
	}

	/** 给视线施加冲量（打瞌睡时引擎内部会自动忽略） */
	impulseGaze(vx, vy) {
		if (this.engine) this.engine.impulseGaze(vx, vy);
	}

	/** 事件目标是否属于组件自身 UI（工具栏/面板/气泡/恢复按钮） */
	isOwnUI(e) {
		return !!(this.root && e.target instanceof Node && this.root.contains(e.target));
	}

	/** 客户端坐标 → 模型范围判定（内容包围盒矩形，模型占据区域内一律不穿透） */
	hitTestClient(cx, cy) {
		return this.inContentBox(...this.toCanvasXY(cx, cy));
	}

	/** 客户端坐标 → 画布内坐标（命中判定 / 悬停判定共用） */
	toCanvasXY(cx, cy) {
		const rect = this.engine.canvas.getBoundingClientRect();
		return [cx - rect.left, cy - rect.top];
	}

	bindResize() {
		this._handlers.resize = () => this.moveTo(this.root.offsetLeft);
		window.addEventListener('resize', this._handlers.resize);
	}

	/**
	 * 命中判定：模型占据的内容包围盒矩形（±8px 贴合视觉轮廓）。
	 * 矩形即"模型范围"——该范围内只能操作模型（点击/拖拽/悬停），
	 * 范围外画布完全穿透给宿主页面。
	 */
	inContentBox(px, py) {
		const box = this.contentBox;
		if (!box) return false;
		const m = 8;
		return px >= box.minX - m && px <= box.maxX + m && py >= box.minY - m && py <= box.maxY + m;
	}

	setMinimized(min) {
		this.root.classList.toggle('waifu-min', min);
	}

	/** 播放模型动作（对外 API / 行为引擎用，不暴露内部模型对象） */
	playMotion(group, index, priority) {
		if (this.engine) this.engine.playMotion(group, index, priority);
	}

	/** 参数全部复位到默认值（唤醒时清掉打瞌睡动作留下的姿态与表情残留） */
	resetParameters() {
		if (this.engine) this.engine.resetParameters();
	}

	/**
	 * 调试用：把模型占据的矩形（内容包围盒）画成半透明紫色块。
	 * 盖在画布之上（z-index:1），半透明所以不挡视线，但能看清矩形边界——
	 * 放在模型背后时边界会被模型本身遮住，反而看不出框到哪里。
	 * 开启/切换模型都会同步更新尺寸。返回当前 contentBox 数值，便于控制台核对。
	 */
	setDebugBox(on) {
		if (!this.root) return null;
		let el = this.root.querySelector('.waifu-debug-box');
		if (on === false) {
			if (el) el.remove();
			return null;
		}
		if (!el) {
			el = document.createElement('div');
			el.className = 'waifu-debug-box';
			el.style.cssText =
				'position:absolute;left:0;top:0;z-index:1;pointer-events:none;' +
				'background:rgba(160,32,240,.28);border:1px solid rgba(160,32,240,.85);box-sizing:border-box';
			this.root.appendChild(el);
		}
		const b = this.contentBox;
		if (b) {
			el.style.left = `${b.minX}px`;
			el.style.top = `${b.minY}px`;
			el.style.width = `${b.maxX - b.minX}px`;
			el.style.height = `${b.maxY - b.minY}px`;
		}
		return b;
	}

	destroy() {
		// 解绑 document/window 上的全局监听，避免关闭→恢复循环中的泄漏
		this._destroyed = true;
		document.removeEventListener('pointermove', this._handlers.gaze);
		window.removeEventListener('pointermove', this._handlers.move, true);
		window.removeEventListener('pointerdown', this._handlers.down, true);
		window.removeEventListener('pointerup', this._handlers.up, true);
		window.removeEventListener('pointercancel', this._handlers.cancel, true);
		window.removeEventListener('blur', this._handlers.cancel);
		window.removeEventListener('click', this._handlers.click, true);
		window.removeEventListener('resize', this._handlers.resize);
		this._handlers = {};
		if (this.engine) this.engine.destroy();
		this.engine = null;
		if (this.root) this.root.remove();
	}
}

function injectRootStyles() {
	if (document.getElementById('waifu-web-root-style')) return;
	const style = document.createElement('style');
	style.id = 'waifu-web-root-style';
	style.textContent = `
#waifu-web{position:fixed;left:0;bottom:0;user-select:none;-webkit-user-select:none;touch-action:none;pointer-events:none}
#waifu-web canvas{display:block;pointer-events:none}
#waifu-web.waifu-min canvas,#waifu-web.waifu-min .waifu-bubble,#waifu-web.waifu-min .waifu-toolbar,#waifu-web.waifu-min .waifu-panel{display:none}
#waifu-web .waifu-min-btn{display:none;position:absolute;left:0;bottom:0;width:44px;height:44px;border-radius:50%;border:2px solid #ffb6c1;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15);cursor:pointer;padding:0;color:#c58f9c;align-items:center;justify-content:center}
#waifu-web .waifu-min-btn svg{width:22px;height:22px;display:block}
#waifu-web.waifu-min .waifu-min-btn{display:flex;pointer-events:auto}
`;
	document.head.appendChild(style);
}
