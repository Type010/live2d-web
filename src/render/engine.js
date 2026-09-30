/**
 * 渲染引擎：官方 Cubism SDK for Web 5（CubismWebFramework 5-r.5）+ 官方示例适配层（LAppModel）。
 * 自管画布、WebGL2 上下文、贴图与帧循环。
 *
 * 定位方式：绕开 model3.json 的 Layout，把模型的模型矩阵置为单位矩阵，
 * 由我们自己的仿射矩阵把「清单预置的可见内容包围盒」直接映到画布（内容左上角贴画布左上、底边贴画布底边）。
 */
import { LAppGlManager } from '../sdk/samples/lappglmanager.ts';
import { LAppModel } from '../sdk/samples/lappmodel.ts';
import { LAppPal } from '../sdk/samples/lapppal.ts';
import { LAppTextureManager } from '../sdk/samples/lapptexturemanager.ts';
import { setShaderPath } from '../sdk/samples/lappdefine.ts';
import { CubismFramework } from '../sdk/framework/live2dcubismframework.ts';
import { CubismMatrix44 } from '../sdk/framework/math/cubismmatrix44.ts';
import { CubismShaderManager_WebGL } from '../sdk/framework/rendering/cubismshader_webgl.ts';
import { CubismWebGLOffscreenManager } from '../sdk/framework/rendering/cubismoffscreenmanager.ts';
import { createMotionDriver } from '../motion/index.js';

const TOP_PAD = 12; // 内容顶边与画布顶边的留白（px）：气泡尖角伸入区
let frameworkStarted = false;

export class Engine {
	constructor(config) {
		this.config = config;
		this.canvas = null;
		this.model = null;
		this.view = null; // { k, minX, minY, canvasW, canvasH }
		this.parameterOverride = null; // (cubismModel) => void，每帧覆盖参数（表情合成用）
		this._motionGroups = []; // 当前模型的动作组名（判断是否支持打瞌睡）
		this._ranges = null; // 姿态量程：装载模型时按模型自身参数范围算出来（见 _setupRanges）
		this._eyeIds = []; // EyeBlink 组的参数索引（核心模块接管眨眼时由我们写）
		this.motion = null; // 动画核心（src/motion）：姿态/眨眼/状态机，适配层只负责喂事件与写参数
		this.onRequest = null; // (request) => void，核心产出的一次性请求（播动作/复位/气泡/表情脉冲）
		this._raf = 0;
		this._waitTimer = 0; // 模型就绪轮询的计时器（destroy 时要清掉）
		this._aborted = false; // 组件已销毁：加载回调不再访问已释放的模型
		this._contextLost = false; // WebGL 上下文是否已被浏览器回收
		this.onContextRestored = null; // 上下文恢复后由上层重新装载模型
	}

	/** 建画布、初始化 WebGL2 与 SDK 框架；宿主已有 CUBISM 框架时不重复初始化 */
	mount(host) {
		this.canvas = document.createElement('canvas');
		this.canvas.style.width = '100%';
		this.canvas.style.height = '100%';
		host.appendChild(this.canvas);

		// 官方 LAppGlManager.initialize 取不到上下文时会 alert()（官方代码，不改），
		// 那会在宿主页弹窗、违反"静默降级"。先自己探测一次：同一 canvas 二次 getContext
		// 返回同一个上下文，这里能拿到就说明 initialize 必然成功，弹窗路径走不到。
		if (!this.canvas.getContext('webgl2')) throw new Error('[waifu] 当前环境不支持 WebGL2');
		this.glManager = new LAppGlManager();
		if (!this.glManager.initialize(this.canvas)) throw new Error('[waifu] 当前环境不支持 WebGL2');
		if (!frameworkStarted) {
			CubismFramework.startUp();
			CubismFramework.initialize();
			frameworkStarted = true;
		}
		setShaderPath(this.config.shaderPath);

		// 标签页长时间切到后台时，浏览器会回收 WebGL 上下文（显存紧张时尤甚）。
		// 不 preventDefault 浏览器就不会尝试恢复；不处理恢复，则画布上所有 GL 资源
		// （纹理/着色器程序/顶点缓冲）都已失效，画面会一直停在空白状态（浏览器还会在
		// 画布位置显示"上下文丢失"小图标），组件却毫无感知、照常跑帧循环。
		this._onCtxLost = (e) => {
			e.preventDefault(); // 告诉浏览器"允许恢复这个上下文"
			this._contextLost = true;
		};
		this._onCtxRestored = () => {
			this._contextLost = false;
			// 旧上下文的资源已全部作废：换一个干净的贴图管理器；
			// 着色器则要丢弃管理器的单例——它按 GL 上下文对象做键缓存，
			// 而恢复后上下文引用不变、里面的程序却已失效，继续复用就画不出任何东西。
			// deleteInstance 之后，重载模型时 renderer.startUp → setGlContext 会新建。
			this.textureManager = new LAppTextureManager();
			this.textureManager.setGlManager(this.glManager);
			try {
				CubismShaderManager_WebGL.deleteInstance();
			} catch (err) {
				console.warn('[waifu] 着色器管理器清理失败：', err);
			}
			// 离屏容器池同样按 GL 上下文缓存，且是常驻单例：旧上下文的对象已随丢失一起失效，
			// 但池里仍留着记录，不清理就会每恢复一次上下文多一份（显存与 JS 引用都收不回）。
			// removeContext 只释放这一个上下文，不影响单例本身；必须在重建任何 GL 资源之前调用，
			// 否则按旧名字 deleteTexture 可能误删刚分配的新对象。
			this._releaseOffscreenPool();
			// 顶点缓冲等资源在渲染器内部，交给上层重新装载模型来整体重建
			this.onContextRestored && this.onContextRestored();
		};
		this.canvas.addEventListener('webglcontextlost', this._onCtxLost, false);
		this.canvas.addEventListener('webglcontextrestored', this._onCtxRestored, false);

		this.textureManager = new LAppTextureManager();
		this.textureManager.setGlManager(this.glManager);

		const self = this;
		this._subdelegate = {
			getCanvas: () => self.canvas,
			getGlManager: () => self.glManager,
			getGl: () => self.glManager.getGl(),
			getTextureManager: () => self.textureManager,
			getFrameBuffer: () => null,
			createShader: () => null, // 官方示例用它绘制背景 sprite，我们没有背景层
			getLive2DManager: () => ({ getModel: () => self.model }),
		};

		// 先打一拍时间基准：LAppPal 的 lastFrame 初值为 0，首次 updateTime 会算出"Unix 时间戳"级别的 deltaTime
		LAppPal.updateTime();

		// 渲染帧率上限：模型有几百个 drawable，逐帧重绘会吃掉主线程（高刷屏尤其明显）。
		// 看板娘不需要 120/165fps，跳帧渲染等于把主线程还给宿主页面。
		this._minFrameGap = 1000 / (this.config.maxFps || 60);
		this._lastRender = 0;

		this._tick = () => {
			this._raf = requestAnimationFrame(this._tick);
			// 上下文丢失期间不做任何 GL 调用（都会静默失败），等 restored 再继续
			if (this._contextLost) return;
			if (!this.model || !this.model.isReady() || !this.view) return;
			const now = performance.now();
			if (now - this._lastRender < this._minFrameGap - 1) return;
			this._lastRender = now;
			const gl = this.glManager.getGl();
			LAppPal.updateTime();
			gl.clearColor(0, 0, 0, 0);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
			this.model.update();
			this.model.draw(this._mvp());
		};
		this._raf = requestAnimationFrame(this._tick);
	}

	/** 画布尺寸（设备像素）；必须在 loadModel 之前调用，模型渲染器建立时会读取它 */
	resize(canvasW, canvasH) {
		// 上限默认 3：模型贴图普遍 4K/8K，缩小到 350px 显示，dpr 截断会明显发糊；
		// 画布本身只有 360px 宽，即使 dpr3 的填充量也远小于 drawable 数量的开销
		const cap = this.config.maxDpr || 3;
		const dpr = Math.min(window.devicePixelRatio || 1, cap);
		this.canvas.width = Math.round(canvasW * dpr);
		this.canvas.height = Math.round(canvasH * dpr);
		this.canvas.style.width = canvasW + 'px';
		this.canvas.style.height = canvasH + 'px';
	}

	/**
	 * 装载模型。entry 为清单条目：{ model, content:{minX,minY,maxX,maxY}, scale }
	 * view 由 stage 依据清单的 content 与 scale 预先算好。
	 */
	async loadModel(entry, view) {
		// 模型地址相对清单解析（清单可用相对路径或完整 URL）
		const base = this.config.modelsUrl ? new URL(this.config.modelsUrl, location.href).href : location.href;
		const url = new URL(entry.model, base).href;
		const dir = url.replace(/[^/]*$/, '');
		const file = url.slice(dir.length);

		const model = new LAppModel();
		model.setSubdelegate(this._subdelegate);
		// 每帧驱动入口：核心模块算出归一化姿态 → 这里乘模型量程写进参数 → 最后让外部钩子（表情合成）覆盖。
		// 切换模型的瞬间旧模型的更新器还可能被调一次，这里认一下"是谁的钩子"，不往别的模型上写。
		model.parameterOverride = (core) => {
			if (this.model !== model) return;
			this._applyFrame(core);
		};
		model.loadAssets(dir, file);
		await this._waitReady(model);
		// 官方模型矩阵（模型单位 → 逻辑空间），排版由 _mvp() 每次按当前 view 现算
		const cm = model.getModel();

		// 清单可选 hideDrawables：走官方 CubismModel.setDrawableCulling()。
		// 官方渲染器在绘制前读它（cubismrenderer_webgl.ts 的 isCulling），为真则**整条网格跳过绘制**——
		// 比把不透明度写 0 更彻底：置 0 时顶点变换、纹理采样、混合照样跑一遍，只是结果看不见；
		// 剔除则根本不进绘制管线，省掉的是真实的 GPU 开销，不只是视觉。
		// 且 culling 是持久状态，装载时设一次即可，无需每帧写（也就没有"必须写在 update 之后"的时序约束）。
		//
		// 坑：只调 setDrawableCulling(i, true) 不够——getDrawableCulling() 只有在
		// isOverridden 为真时才读用户设的值，否则回落到模型自身的默认（按双面位取反）。
		// 必须先 setOverrideFlagForDrawableCullings(i, true)，否则设了也不生效（实测 culling 仍为 false）。
		// 名字只能从 handle 侧取（框架的 getId 以 core id 对象为键，与字符串 handle 不同源）
		const wanted = entry.hideDrawables || [];
		if (wanted.length) {
			for (let i = 0; i < cm.getDrawableCount(); i++) {
				const h = cm.getDrawableId(i);
				const name = h && typeof h.getString === 'function' ? h.getString() : null;
				if (name && wanted.indexOf(name) >= 0) {
					cm.setOverrideFlagForDrawableCullings(i, true);
					cm.setDrawableCulling(i, true);
				}
			}
		}

		// 记录该模型的动作组名：组件约定"有 TapBody 组才有打瞌睡状态"（旧模型加载到此为止，
		// 判断逻辑在 behaviors）。组名只能从官方 LAppModel 的 modelSetting 拿；取不到就视为没有，
		// 宁可这个模型不打瞌睡，也不要错播一个与睡觉无关的动作。
		this._motionGroups = [];
		try {
			const setting = model._modelSetting;
			if (setting && typeof setting.getMotionGroupCount === 'function') {
				for (let i = 0; i < setting.getMotionGroupCount(); i++) {
					this._motionGroups.push(setting.getMotionGroupName(i));
				}
			}
		} catch (err) {
			this._motionGroups = [];
		}

		// 旧模型到这里才释放：加载期间它仍在画面上，提前 release 会让画面消失。
		// 不释放则会漏掉一份 moc3 的 WASM 堆与该模型的渲染器缓冲——GC 收不回，
		// 每次切换模型都多一份，只有关掉页面才回收。
		if (this.model) this.model.release();
		// 排版参数与新模型同帧切换：加载期间旧模型继续按旧 view / 旧画布尺寸渲染，
		// 否则新模型的画布高度一早就生效，旧模型会被搬到错误位置（表现为"切换时模型移位"）
		this.view = view;
		this.model = model;

		// 眨眼参数索引：核心模块接管眨眼节奏时由我们写这两条参数（SDK 那套随之关掉）；
		// 模型没有 EyeBlink 组时这里为空，眨眼仍走 SDK（什么都不会动）
		this._eyeIds = [];
		try {
			const setting = model._modelSetting;
			const count =
				setting && typeof setting.getEyeBlinkParameterCount === 'function'
					? setting.getEyeBlinkParameterCount()
					: 0;
			for (let i = 0; i < count; i++) {
				const idx = cm.getParameterIndex(setting.getEyeBlinkParameterId(i));
				if (idx >= 0) this._eyeIds.push(idx);
			}
		} catch (err) {
			this._eyeIds = [];
		}

		// 动画核心：姿态/眨眼/状态机都在 src/motion 里；换模型只更新"能力"（有没有 TapBody 组等）
		const caps = {
			hasTapBody: this._motionGroups.indexOf('TapBody') >= 0,
			hasEyeBlink: this._eyeIds.length > 0,
		};
		if (!this.motion) this.motion = createMotionDriver(this.config, caps);
		else this.motion.setCapabilities(caps);
		this.motion.resetBlink();
		// 眨眼全权由核心负责（写 EyeBlink 组参数）：SDK 那套更新器的门控条件与无限循环的待机动作
		// 冲突，等于永不眨眼，已在 lappmodel 里不再注册。核心在"动作自己动眼睛"时会自动让位。
		this._setupRanges(this.config.gaze || {}, cm);
		return cm;
	}

	/**
	 * 姿态量程：全部由**模型自己的参数范围**算出来，再乘配置里的比例。
	 * 旧实现把 ±30°、±10°、±1 写死在代码里，等于只对"参数范围刚好这么宽"的模型合适；
	 * 现在换任何模型都不需要改代码：模型没有的参数自动跳过，范围多大由模型自己决定。
	 * 手感（弹簧、冲量、follow-through）在核心模块 src/motion/pose.js，这里只管量程。
	 */
	_setupRanges(cfg, cm) {
		if (!cfg || cfg.enabled === false) {
			this._ranges = null;
			return;
		}
		const idm = CubismFramework.getIdManager();
		// 幅度总倍率（设置面板的滑杆）：乘在各轴比例之上，不改变"比例来自模型自身范围"这条前提
		const gain =
			typeof cfg.amplitude === 'number' && isFinite(cfg.amplitude) ? Math.max(0, cfg.amplitude) : 1;
		const slot = (paramId, ratio) => {
			const index = cm.getParameterIndex(idm.getId(paramId));
			if (index < 0) return null; // 模型没有这个参数
			const lo = Math.abs(cm.getParameterMinimumValue(index));
			const hi = Math.abs(cm.getParameterMaximumValue(index));
			// 取较小的绝对值，正负两个方向都不会越界
			const amp = Math.min(lo, hi) * (ratio == null ? 1 : ratio) * gain;
			return amp > 0 ? { index, amp } : null;
		};
		this._ranges = {
			angleX: slot('ParamAngleX', cfg.head),
			angleY: slot('ParamAngleY', cfg.head),
			angleZ: slot('ParamAngleZ', cfg.tilt),
			bodyX: slot('ParamBodyAngleX', cfg.bodyX),
			bodyY: slot('ParamBodyAngleY', cfg.bodyY),
			bodyZ: slot('ParamBodyAngleZ', cfg.bodyZ),
			eyeX: slot('ParamEyeBallX', cfg.eyes),
			eyeY: slot('ParamEyeBallY', cfg.eyes),
		};
	}

	/**
	 * 每帧驱动（唯一的写参数入口）。
	 * 调用点在官方更新调度器的 Drag(400)（见 LAppModel 里的 WaifuLookUpdater），
	 * 物理是 600——视线写在物理之前，头发/裙摆/饰带才会跟着头身摆动。
	 * 这里是纯适配：核心给归一化姿态与决策，我们乘量程写参数、把请求转交给上层。
	 */
	_applyFrame(core) {
		if (this.motion && this._ranges) {
			const suppressed =
				typeof this.model.isMotionDrivingEyes === 'function' ? this.model.isMotionDrivingEyes() : false;
			const frame = this.motion.tick(LAppPal.getDeltaTime(), { eyesSuppressed: suppressed });
			if (frame.weight > 0) this._writePose(core, frame.pose);
			if (frame.eyeOpen != null) this._writeEyeOpen(core, frame.eyeOpen);
			if (frame.request && this.onRequest) this.onRequest(frame.request);
		}
		// 外部钩子（表情合成）在后：表情可以覆盖视线写下的参数
		if (this.parameterOverride) this.parameterOverride(core);
	}

	/** 归一化姿态 → 模型参数（各自乘自己的量程；模型没有的槽位为 null，跳过） */
	_writePose(core, p) {
		const a = this._ranges;
		const put = (slot, v) => {
			if (slot) core.setParameterValueByIndex(slot.index, v * slot.amp);
		};
		put(a.angleX, p.headX);
		put(a.angleY, p.headY);
		put(a.angleZ, p.headZ);
		put(a.bodyX, p.bodyX);
		put(a.bodyY, p.bodyY);
		put(a.bodyZ, p.bodyZ);
		put(a.eyeX, p.eyeX);
		put(a.eyeY, p.eyeY);
	}

	/** 眼睛张开度 → EyeBlink 组（左/右眼） */
	_writeEyeOpen(core, v) {
		for (let i = 0; i < this._eyeIds.length; i++) core.setParameterValueByIndex(this._eyeIds[i], v);
	}

	/** 给视线施加冲量（指针移入模型 / 点击模型）：归一化视线单位/秒 */
	impulseGaze(vx, vy) {
		if (this.motion) this.motion.impulse(vx, vy);
	}

	/** 帧率上限（0 = 不限制）：设置面板即时生效，不需要重建渲染器 */
	setMaxFps(fps) {
		const v = typeof fps === 'number' && isFinite(fps) ? fps : 60;
		this.config.maxFps = v;
		this._minFrameGap = v > 0 ? 1000 / v : 0;
	}

	/**
	 * 重新应用手感调参（设置面板用）：量程比例（含幅度总倍率）重新算，
	 * 弹簧/摆动/冲量倍率与眨眼、行为阈值交给核心重配。不重建模型、不中断当前动作。
	 */
	applyTuning() {
		if (!this.model) return;
		this._setupRanges(this.config.gaze || {}, this.model.getModel());
		if (this.motion) this.motion.configure(this.config);
	}

	/** 指针速度（归一化 -1..1）：驱动"反着鼠标方向"的身体摆动 */
	setPointerSpeed(vx, vy) {
		if (this.motion) this.motion.setPointerSpeed(vx, vy);
	}

	/** 指针是否在模型身上：在上面移动时摆动幅度更大 */
	setHover(on) {
		if (this.motion) this.motion.setHover(on);
	}

	/**
	 * 等模型资产全部就绪。超时只作为"彻底失败"的兜底：
	 * 精细模型动辄 20~40MB（贴图 4K/8K），慢网络下 30 秒很常见，
	 * 早先的 30 秒会在正常访问中误判失败并把看板娘直接丢弃。
	 */
	_waitReady(model) {
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const poll = () => {
				// 组件在加载途中被关闭：立刻停表，避免在已 release 的模型上继续取数据
				if (this._aborted) return reject(new Error('[waifu] 组件已关闭'));
				if (model.isReady()) return resolve();
				// 结构文件/模型主体确定取不到：立即失败，别让访客干等满超时
				if (typeof model.isFailed === 'function' && model.isFailed()) {
					return reject(new Error('[waifu] 模型文件加载失败'));
				}
				if (Date.now() - started > 120000) return reject(new Error('[waifu] 模型加载超时'));
				this._waitTimer = setTimeout(poll, 50);
			};
			poll();
		});
	}

	/**
	 * 视投影矩阵：沿用官方组合——模型矩阵（CubismModelMatrix，模型单位 → 逻辑空间）＋ 只做宽高比修正的投影。
	 * 注：不能自造 MVP 取代模型矩阵，框架的渲染管线不认（实测画不出任何像素）。
	 *
	 * 定位全部由模型矩阵承担：直接对 model._modelMatrix 用官方的 scale() / translateX() /
	 * translateY() 下指令，把「清单预置的内容包围盒」摆到目标框（左缘贴画布左缘、
	 * 顶边留 TOP_PAD、底边贴画布底边）。早先在 NDC 空间另解一层仿射叠上去，
	 * 等价于把同一件事算两遍——模型矩阵那份缩放效应会在求 sx/sy 的除法里被完全抵消。
	 */
	_mvp() {
		const { k, minX, minY, maxX, maxY, canvasW, canvasH, ppu, pxW, pxH } = this.view;
		const W = this.canvas.width, H = this.canvas.height;

		const P = new CubismMatrix44();
		if (W > H) P.scale(1, W / H);
		else P.scale(H / W, 1);
		// 投影只含缩放，取两个轴的缩放系数即可（矩阵只含缩放与平移，可逐轴变换）
		const ps = P.getArray();
		const psX = ps[0];
		const psY = ps[5];

		// 清单 content 是"画布左上为原点"的设计像素；模型顶点空间以画布中心为原点、y 向上（单位 = 像素 ÷ pixelsPerUnit）
		const toUx = (px) => (px - pxW / 2) / ppu;
		const toUy = (py) => (pxH / 2 - py) / ppu;
		const uMinX = toUx(minX), uMaxX = toUx(maxX), uMinY = toUy(minY), uMaxY = toUy(maxY);

		// 目标 NDC 矩形：内容左缘贴画布左缘、顶边留 TOP_PAD、底边贴画布底边
		const dX0 = -1;
		const dX1 = (2 * (maxX - minX) * k) / canvasW - 1;
		const dYbottom = 1 - (2 * (TOP_PAD + (maxY - minY) * k)) / canvasH;

		// 目标框换算回"投影之前的逻辑空间"（投影只是逐轴乘一个系数，除回去即可）。
		//
		// 排版直接写进 model._modelMatrix 本身，而不是另建一份矩阵再叠上去——
		// draw()（lappmodel.ts:1024）内部会再乘一次 model._modelMatrix，另建一份等于
		// 让模型矩阵自身的缩放（2/画布高）被乘两次：内容整体放大约 1.29 倍，
		// 表现为模型变大、上下被裁、调试框（contentBox）框不住模型。
		//
		// scale() 是**覆写**缩放分量（不是叠乘），所以模型矩阵原本的缩放在这里直接被
		// 替换掉，不需要额外补偿。
		const mm = this.model._modelMatrix;
		const wantW = (dX1 - dX0) / psX;
		const wantH = (((1 - (2 * TOP_PAD) / canvasH) - dYbottom)) / psY;
		const sX = wantW / (uMaxX - uMinX);
		const sY = wantH / (uMinY - uMaxY);

		// 用 scale() 而不是 setScale()——框架里只有 scale（直接覆写缩放分量，非叠加）。
		// 底边用 translateY 直接解出：官方 bottom() 贴的是**画布底边**（this._height），
		// 而我们要贴的是内容底边，两者差着画布四周的透明留白——正因如此，清单才必须预置
		// content（直接贴画布底边会偏几十像素）。
		mm.scale(sX, sY);
		mm.translateX(dX0 / psX - sX * uMinX);
		mm.translateY(dYbottom / psY - sY * uMaxY);

		// 排版已写进 model._modelMatrix（draw() 内部会乘它），这里只返回投影
		return P;
	}

	/**
	 * 把所有参数复位到 moc3 里的默认值，并立即保存为"上次状态"。
	 *
	 * Cubism 的动作只覆盖它自己用到的参数，其余参数会保持上一个动作的最后值。
	 * 打瞌睡动作写了一遍低头/闭眼/表情参数，醒来播待机时待机不控制这些参数，
	 * 它们就"冻"在睡姿上（实测醒来后 14 个参数残留，头角度与眼部表情都还在睡着）。
	 * 必须调 saveParameters()：update() 每帧开头会 loadParameters() 恢复上次保存值，
	 * 只写当前值会在下一帧被覆盖回去。
	 * 视线/姿态与合成表情不受影响——它们每帧都由核心模块与合成引擎重新写入。
	 */
	resetParameters() {
		if (!this.model) return;
		const cm = this.model.getModel();
		const count = cm.getParameterCount();
		for (let i = 0; i < count; i++) {
			cm.setParameterValueByIndex(i, cm.getParameterDefaultValue(i));
		}
		cm.saveParameters();
	}

	/**
	 * 指针位置 → 归一化视线目标，喂给动画核心。
	 * 原点取**模型内容顶边的中点**（模型的"头部"位置）：以页面中心为原点时，
	 * 指针正对模型头顶也已经算出"向下看"，完全不像在追指针。
	 * 量程（span）默认取模型显示尺寸的 0.55 倍、且不小于 200px——早期用"视口一半"当量程时，
	 * 指针要移出几百像素才到满量程，观感是"怎么动都不动"；现在小幅度移动就有明显反应，
	 * 具体倍数由 config.gaze.spanScale 调。
	 */
	setGaze(clientX, clientY) {
		if (!this.model || !this.view || !this.motion) return;
		const rect = this.canvas.getBoundingClientRect();
		const ox = rect.left + rect.width / 2; // 模型水平中心
		const oy = rect.top; // 模型顶部（画布顶边 = 内容顶边往上留 TOP_PAD）
		const scale = this.config.gaze && this.config.gaze.spanScale != null ? this.config.gaze.spanScale : 0.55;
		// 下限 120/140px：早期用 200/220 时，360px 宽的模型上"灵敏度"滑杆的下半段（0.3~0.55）
		// 会被下限吃掉、拖了没反应；把地板压低后整段滑杆都有实际区别，同时仍能防止极端抖
		const spanX = Math.max(rect.width * scale, 120);
		const spanY = Math.max(rect.height * scale, 140);
		const clamp = (v) => Math.max(-1, Math.min(1, v));
		this.motion.setPointer(clamp((clientX - ox) / spanX), clamp((oy - clientY) / spanY));
	}

	/**
	 * 参数名 → 框架的 CubismIdHandle。
	 * 官方框架的 getParameterIndex 只接受 handle（内部按引用比对），传字符串会取不到索引，
	 * 表情合成写入参数就会静默失效（表现为"点了表情没反应"，且不报错）。
	 */
	resolveParamId(name) {
		return CubismFramework.getIdManager().getId(name);
	}

	/** 播放动作（强制切换：先停当前动作，保证"打瞌睡→唤醒"这类状态切换一定生效） */
	playMotion(group, index, priority) {
		if (this.model) this.model.startMotionForce(group, index, priority);
	}

	destroy() {
		this._aborted = true;
		if (this._waitTimer) clearTimeout(this._waitTimer);
		this._waitTimer = 0;
		if (this._raf) cancelAnimationFrame(this._raf);
		this._raf = 0;
		if (this.canvas) {
			if (this._onCtxLost) this.canvas.removeEventListener('webglcontextlost', this._onCtxLost, false);
			if (this._onCtxRestored) this.canvas.removeEventListener('webglcontextrestored', this._onCtxRestored, false);
		}
		this._onCtxLost = null;
		this._onCtxRestored = null;
		this.onContextRestored = null;
		if (this.model) this.model.release();
		this.model = null;
		this._ranges = null; // 量程属于刚释放的那个模型，关掉后不能留在原地
		this._eyeIds = [];
		this.motion = null; // 核心随模型一起丢弃：能力判定与状态都与模型相关
		// 贴图缓存跨模型复用（切回去不用重下），但组件关闭时必须全量释放：
		// 反复"关闭 → 左下角恢复"会不断新建 WebGL 上下文，纹理不能留给 GC 碰运气
		if (this.textureManager) {
			this.textureManager.release();
			this.textureManager = null;
		}
		// 离屏容器池是常驻单例，组件关闭时必须显式释放本上下文的那一份：
		// 反复"关闭 → 左下角恢复"会不断新建 WebGL 上下文，池里的容器不能留给 GC 碰运气
		this._releaseOffscreenPool();
		if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
		this.canvas = null;
	}

	/**
	 * 释放离屏容器池里属于当前 GL 上下文的那一份（waifu-web 本地补丁）。
	 *
	 * `CubismWebGLOffscreenManager` 是常驻单例，内部按 GL 上下文缓存容器池，官方没有任何
	 * 调用点会释放它——上下文丢失后恢复、或组件关闭再打开，旧上下文的容器都会一直留在池里。
	 * `removeContext()` 只清掉指定上下文，不动单例本身，可以安全地在两种时机调用。
	 */
	_releaseOffscreenPool() {
		try {
			const gl = this.glManager && this.glManager.getGl ? this.glManager.getGl() : null;
			if (gl) CubismWebGLOffscreenManager.getInstance().removeContext(gl);
		} catch (err) {
			console.warn('[waifu] 离屏容器池清理失败：', err);
		}
	}
}
