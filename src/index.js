/**
 * waifu-web 入口。
 *
 * 使用方式（宿主站点一行接入）：
 *   <script src=".../waifu.js" data-models="https://example.com/models.json"></script>
 *
 * 启动时机：页面 load 后空闲再加载运行时与模型（首次约 1MB 代码 + 模型体积），
 * 移动端 / 减弱动效 / 用户已关闭 / WebGL 不可用时零加载静默退出。
 */
import { DEFAULT_CONFIG, mergeConfig, configFromAttributes, loadStorage, saveStorage } from './config.js';
import { canRun, loadRuntime, fetchJSON } from './loader.js';
import { Stage } from './stage.js';
import { ExpressionComposer } from './composer.js';
import { Behaviors } from './behaviors.js';
import { SettingsPanel, DEFAULTS } from './ui/settings.js';
import { injectStyles } from './ui/styles.js';
import { Bubble } from './ui/bubble.js';
import { Toolbar } from './ui/toolbar.js';

const script = document.currentScript || document.querySelector('script[data-models]');
let config = mergeConfig(DEFAULT_CONFIG, script ? configFromAttributes(script.dataset) : {});
const storage = loadStorage(config.storageKey);
const CLOSE_TTL = 86400000; // 关闭状态保留时长：超时后自动恢复显示（24 小时）
let booted = false;
let ctx = null;
let settings = null; // 访客设置（loadSettings 结果）

/**
 * 访客设置：动画幅度、手感、摆动、触碰反应与帧率上限。
 * 每人独立存在自己的 localStorage（键 = storageKey + '-settings'），互不影响，
 * 也不写回站点配置——站点改 config.js 只影响没有自定义过的访客。
 */
const SETTINGS_KEY = () => `${config.storageKey}-settings`;

/** 取当前设置：已存的覆盖默认值 */
function loadSettings() {
	const saved = loadStorage(SETTINGS_KEY());
	const out = { ...DEFAULTS };
	for (const k of Object.keys(DEFAULTS)) {
		if (typeof saved[k] === 'number' && isFinite(saved[k])) out[k] = saved[k];
	}
	return out;
}

/** 把设置写进运行期 config（都是"乘在模型自身范围之上"的系数，不破坏通用性） */
function applySettings(settings) {
	const g = config.gaze || (config.gaze = {});
	g.amplitude = settings.amplitude;
	g.spanScale = settings.spanScale;
	g.spring = { ...(g.spring || {}), follow: settings.follow, inertia: settings.inertia };
	g.sway = { ...(g.sway || {}), gain: settings.swayGain, hoverGain: settings.swayHoverGain };
	g.impulseScale = settings.impulseScale;
	config.maxFps = settings.maxFps;
}

/** 环形索引：支持 -1 / 越界循环切换 */
const nextIndex = (i, len) => ((i % len) + len) % len;

function resolveVendor() {
	if (config.vendorUrl) return config.vendorUrl.endsWith('/') ? config.vendorUrl : `${config.vendorUrl}/`;
	if (script && script.src) return new URL('./vendor/', script.src).href;
	return './vendor/';
}

function scheduleBoot() {
	if (booted) return;
	if (!canRun(config)) return;
	// 关闭状态只保留 24 小时：访客关掉看板娘通常是"此刻不想看"，永久消失太重
	// （没有 disabledAt 的旧记录视为已过期，升级后自动恢复显示）
	if (storage.disabled && Date.now() - (storage.disabledAt || 0) <= CLOSE_TTL) {
		mountRestoreCorner();
		return;
	}
	if (storage.disabled) {
		storage.disabled = false;
		delete storage.disabledAt;
		saveStorage(config.storageKey, storage);
	}
	booted = true;
	injectStyles();
	const start = () => {
		// 页面 load 后等浏览器空闲再启动，不抢首屏带宽；timeout 兜底最迟 2.5s
		if (typeof requestIdleCallback === 'function') requestIdleCallback(boot, { timeout: 2500 });
		else setTimeout(boot, 1500);
	};
	if (document.readyState === 'complete') start();
	else window.addEventListener('load', start, { once: true });
}

async function boot() {
	config.vendorUrl = resolveVendor();
	// 访客自定义的动画/帧率设置要在建 Stage 之前生效，否则首个模型装载用的是默认值
	settings = loadSettings();
	applySettings(settings);
	config.shaderPath = `${config.vendorUrl}shaders/WebGL/`; // 官方 SDK 的 GLSL 由运行时按文件加载
	// stage 在 try 外登记：mount() 里才去加载 engine.js，失败时 ctx 还没赋值，
	// catch 里的 teardown() 会因 ctx 为空直接返回，留下 #waifu-web 容器与画布
	let pendingStage = null;
	try {
		// 运行时与模型清单互不依赖，并行拉取省一个串行往返；
		// 清单 bust=true：确保每次拿到最新版（模型寻址与行为都依赖它）
		const [manifest] = await Promise.all([fetchJSON(config.modelsUrl, true), loadRuntime(config)]);
		if (!manifest || !Array.isArray(manifest.models) || !manifest.models.length) throw new Error('[waifu] 模型清单为空');

		const stage = new Stage(config);
		pendingStage = stage;
		await stage.mount();
		pendingStage = null; // 挂载成功，此后由 ctx 负责销毁
		const bubble = new Bubble();
		const composer = new ExpressionComposer();
		const toolbar = new Toolbar();

		ctx = { stage, bubble, composer, toolbar, manifest, index: resolveStartIndex(manifest), entry: null };
		bubble.mount(stage.root);
		toolbar.mount(stage.root, {
			settings: () => toolbar.toggleSettings(),
			panel: () => {
				if (toolbar.isPanelOpen()) {
					toolbar.togglePanel(false);
				} else {
					toolbar.togglePanel(true);
					toolbar.showBar();
				}
			},
			model: () => switchModel(ctx.index + 1),
			reset: () => {
				composer.clear();
				bubble.say('恢复默认脸啦～');
			},
			min: () => {
				stage.setMinimized(true);
				toolbar.hideBarNow();
				storage.minimized = true;
				saveStorage(config.storageKey, storage);
			},
			onRestore: () => {
				stage.setMinimized(false);
				storage.minimized = false;
				saveStorage(config.storageKey, storage);
			},
			close: closeAll,
		});
		composer.onChange = (names) => toolbar.syncActive(names);

		// 悬停模型/UI 上时从右侧弹出工具栏，移开延时收起（由 stage 统一判定：模型范围内响应，范围外穿透）
		// 设置面板：改动即时生效（量程/弹簧/眨眼/行为交给核心重配，帧率改帧间隔）并持久化
		const settingsPanel = new SettingsPanel({
			get: () => settings,
			onChange: (patch) => {
				settings = { ...settings, ...patch };
				applySettings(settings);
				saveStorage(SETTINGS_KEY(), settings);
				if (stage.engine) {
					stage.engine.setMaxFps(settings.maxFps);
					stage.engine.applyTuning();
				}
			},
			onReset: () => {
				settings = { ...DEFAULTS };
				applySettings(settings);
				saveStorage(SETTINGS_KEY(), settings);
				if (stage.engine) {
					stage.engine.setMaxFps(settings.maxFps);
					stage.engine.applyTuning();
				}
			},
		});
		settingsPanel.mount(stage.root);
		// 挂到工具栏：齿轮按钮开关它，并与表情面板互斥
		toolbar.setSettingsPanel(settingsPanel);
		ctx.settingsPanel = settingsPanel;

		stage.onHover = (onModel) => {
			onModel ? toolbar.showBar() : toolbar.hideBarSoon(200);
			document.body.style.cursor = onModel ? 'pointer' : '';
		};

		// 模型内容对齐后重新锚定 UI（画布高度随模型变化，取实时值：contentBox.maxY 即画布高）
		stage.onAnchor = (box) => {
			bubble.updateAnchor(box, box.maxY);
			toolbar.updateAnchor(box);
		};

		// GPU 上下文被浏览器回收后恢复（标签页长时间后台）：GL 侧资源已作废，
		// 重新装载当前模型来整体重建，避免画面停在空白状态
		stage.onContextRestored = () => {
			if (!ctx || !ctx.entry) return;
			applyModel(ctx.entry).catch((e) => console.warn('[waifu] 上下文恢复后重载模型失败：', e));
		};

		await applyModel(manifest.models[ctx.index]);
		if (storage.minimized) stage.setMinimized(true);
		exposeApi();
		prefetchOtherModels(manifest, ctx.entry && ctx.entry.id);
	} catch (e) {
		window.__waifuError = String((e && e.stack) || e);
		console.warn('[waifu] 启动失败，看板娘已静默停用：', e);
		if (pendingStage) {
			try {
				pendingStage.destroy();
			} catch (err) {
				/* 销毁失败不掩盖原始错误 */
			}
		}
		teardown();
	}
}

/**
 * 非懒加载模式（`data-lazy="false"`）：空闲时把清单里其他模型的资源预取进浏览器缓存。
 * 只发请求、不建模型实例，所以不占显存；预取完成后切换模型无需再等网络。
 * 默认是懒加载（true），大模型站点不该被无声地预取几十 MB。
 */
function prefetchOtherModels(manifest, currentId) {
	if (config.lazy !== false) return;
	const idle = (fn) =>
		typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 3000);
	idle(async () => {
		for (const m of manifest.models) {
			if (m.id === currentId) continue;
			try {
				const base = new URL(m.model, config.modelsUrl || location.href).href;
				const mj = await (await fetch(base)).json();
				const fr = mj.FileReferences || {};
				const files = [];
				const add = (f) => {
					if (f) files.push(new URL(f, base).href);
				};
				add(fr.Moc);
				add(fr.Physics);
				add(fr.Pose);
				(fr.Textures || []).forEach(add);
				const group = (v) => {
					if (!v) return;
					if (Array.isArray(v)) v.forEach((it) => add(it && it.File));
					else Object.keys(v).forEach((k) => (v[k] || []).forEach((it) => add(it && it.File)));
				};
				group(fr.Motions);
				group(fr.Expressions);
				(m.expressions || []).forEach((e) => add(e.file));
				// 串行预取：只求进缓存，不跟首屏抢带宽
				for (const u of files) {
					try {
						await fetch(u, { cache: 'force-cache' });
					} catch (e) {
						/* 单个失败忽略 */
					}
				}
			} catch (e) {
				console.warn('[waifu] 预取模型失败（不影响使用）：', m.id, e);
			}
		}
	});
}

function resolveStartIndex(manifest) {	const want = storage.model;
	if (want) {
		const i = manifest.models.findIndex((m) => m.id === want);
		if (i >= 0) return i;
	}
	const d = manifest.models.findIndex((m) => m.id === manifest.default);
	return d >= 0 ? d : 0;
}

/** 加载互斥：切换进行中忽略新的切换请求，避免并发加载把状态写乱 */
let switching = false;

/**
 * 加载并启用一个模型（按清单条目）。
 * 每个 await 之后都校验 stage 实例仍是同一个：加载期间被关闭（ctx 清空）
 * 或关闭后立即恢复（stage 已重建）时，放弃本次后续步骤，不污染新实例。
 *
 * 加载期间不发气泡提示：气泡锚点要等模型就绪后由 onAnchor 算出，加载中显示会停在
 * 错误位置；而给个"长时长"让它在加载后继续挂着也不对。反馈只留就绪后的"登场"一句。
 */
async function applyModel(entry) {
	const { stage, composer, bubble, toolbar, manifest } = ctx;
	const model = await stage.loadModel(entry);
	if (!model || !ctx || ctx.stage !== stage) return;
	await composer.load(model, (entry.expressions || []).map((e) => ({ ...e, file: e.file || `${e.name}.exp3.json` })));
	if (!ctx || ctx.stage !== stage) return;

	ctx.index = manifest.models.indexOf(entry);
	ctx.entry = entry;

	ctx.behaviors && ctx.behaviors.stop();
	ctx.behaviors = new Behaviors({ stage, composer, bubble, config, entry });
	ctx.behaviors.start();

	toolbar.renderExpressions(entry, composer, (name) => {
		composer.toggle(name);
	});
	storage.model = entry.id;
	saveStorage(config.storageKey, storage);
	return entry;
}

async function switchModel(index) {
	if (!ctx || switching) return;
	const { toolbar, manifest } = ctx;
	const entry = manifest.models[nextIndex(index, manifest.models.length)];
	if (ctx.entry && entry.id === ctx.entry.id) return;
	switching = true;
	toolbar.togglePanel(false);
	try {
		await applyModel(entry);
		// await 期间用户可能"关闭→左下角恢复"，ctx 已是新实例，
		// 必须重新取引用，否则文案写进已脱离文档的旧气泡里
		if (ctx) ctx.bubble.say(`${entry.name} 登场！`, 3000);
	} catch (e) {
		console.warn('[waifu] 切换模型失败：', e);
		if (ctx) ctx.bubble.say('呜…换装失败了，再点一次试试。');
	} finally {
		switching = false;
	}
}

function closeAll() {
	storage.disabled = true;
	storage.disabledAt = Date.now(); // 记录关闭时刻，24 小时后自动恢复显示
	saveStorage(config.storageKey, storage);
	teardown();
	mountRestoreCorner();
}

function teardown() {
	if (!ctx) return;
	// 每一步单独兜底：任何一步异常都不能中断收尾，否则恢复热区不会出现（曾出现"关掉就再也打不开"）
	const step = (label, fn) => {
		try {
			fn();
		} catch (e) {
			console.warn(`[waifu] 关闭时 ${label} 异常（已忽略）：`, e);
		}
	};
	step('停止行为', () => ctx.behaviors && ctx.behaviors.stop());
	step('解绑表情合成', () => ctx.composer.detach());
	step('销毁工具栏', () => ctx.toolbar.destroy());
	step('销毁舞台', () => ctx.stage.destroy());
	document.body.style.cursor = ''; // 悬停判定曾把整页光标改为 pointer，关闭时复原
	ctx = null;
	delete window.Waifu;
}

/** 关闭后在角落留一个透明恢复热区，首次出现时给出提示文案 */
function mountRestoreCorner() {
	if (document.getElementById('waifu-web-restore')) return;
	const btn = document.createElement('button');
	btn.id = 'waifu-web-restore';
	btn.title = '重新打开看板娘';
	Object.assign(btn.style, {
		position: 'fixed', left: '6px', bottom: '6px', width: '24px', height: '24px',
		opacity: '0', border: 'none', background: 'transparent', cursor: 'pointer',
		zIndex: String(config.zIndex),
	});
	btn.addEventListener('click', () => {
		storage.disabled = false;
		delete storage.minimized;
		saveStorage(config.storageKey, storage);
		btn.remove();
		booted = false;
		scheduleBoot();
	});
	document.body.appendChild(btn);

	// 提示一次：看板娘已关闭、点左下角可恢复
	const tip = document.createElement('span');
	tip.textContent = '看板娘已关闭，点左下角可重新打开';
	Object.assign(tip.style, {
		position: 'fixed', left: '36px', bottom: '11px', opacity: '0.7',
		fontSize: '12px', color: '#c58f9c', zIndex: String(config.zIndex),
		transition: 'opacity .5s ease', pointerEvents: 'none',
	});
	document.body.appendChild(tip);
	setTimeout(() => {
		tip.style.opacity = '0';
		setTimeout(() => tip.remove(), 600);
	}, 3500);
}

/** 对外 API（控制台可玩，也可供宿主站点联动） */
function exposeApi() {
	window.Waifu = {
		config,
		_stage: ctx && ctx.stage,
		say: (text, d) => ctx && ctx.bubble.say(text, d),
		toggleExpression: (name) => ctx && ctx.composer.toggle(name),
		setExpressions: (names) => ctx && ctx.composer.setActive(names),
		switchModel: (id) => {
			if (!ctx) return;
			const i = typeof id === 'number' ? id : ctx.manifest.models.findIndex((m) => m.id === id);
			return switchModel(i >= 0 ? i : ctx.index + 1);
		},
		sleep: () => ctx && ctx.behaviors.sleep(),
		wake: () => ctx && ctx.behaviors.wake(),
		playMotion: (group, index, priority) => ctx && ctx.stage.playMotion(group, index, priority),
		/**
		 * 调试：把模型的矩形范围画成半透明紫色块（在画布之下、模型背后），
		 * 用于核对定位是否与预期一致。控制台执行 Waifu.debugBox() 开启，
		 * Waifu.debugBox(false) 关闭；返回值就是当前的 contentBox 数值。
		 */
		debugBox: (on = true) => (ctx && ctx.stage ? ctx.stage.setDebugBox(on) : null),
		/**
		 * 动画核心（src/motion）的直通接口，控制台调手感用：
		 *   Waifu.motion.impulse(3, 0)      手搓一次冲量（头往右甩）
		 *   Waifu.motion.setGazeEnabled(false)  暂停/恢复视线跟随
		 *   Waifu.motion.debug()            取姿态/眨眼/状态机的内部状态
		 */
		/**
		 * 访客设置（与工具栏的齿轮面板同一份数据，存在本机 localStorage）：
		 *   Waifu.settings.get()                      当前设置
		 *   Waifu.settings.set({ amplitude: 1.2 })    改一项或几项（即时生效并保存）
		 *   Waifu.settings.reset()                    恢复默认
		 *   Waifu.settings.show(true/false)           开关设置面板
		 */
		settings: {
			get: () => ({ ...settings }),
			set: (patch) => {
				if (!patch || !ctx) return null;
				settings = { ...settings, ...patch };
				applySettings(settings);
				saveStorage(SETTINGS_KEY(), settings);
				if (ctx.stage.engine) {
					ctx.stage.engine.setMaxFps(settings.maxFps);
					ctx.stage.engine.applyTuning();
				}
				if (ctx.settingsPanel) ctx.settingsPanel.sync();
				return { ...settings };
			},
			reset: () => {
				settings = { ...DEFAULTS };
				applySettings(settings);
				saveStorage(SETTINGS_KEY(), settings);
				if (ctx && ctx.stage.engine) {
					ctx.stage.engine.setMaxFps(settings.maxFps);
					ctx.stage.engine.applyTuning();
				}
				if (ctx && ctx.settingsPanel) ctx.settingsPanel.sync();
				return { ...settings };
			},
			show: (on = true) => {
				if (!ctx || !ctx.settingsPanel) return false;
				ctx.settingsPanel.show(on);
				if (on && ctx.toolbar) ctx.toolbar.togglePanel(false);
				return !!on;
			},
		},
		motion: {
			impulse: (vx = 3, vy = 0) => {
				const core = ctx && ctx.stage.engine ? ctx.stage.engine.motion : null;
				if (core) core.impulse(vx, vy);
				return !!core;
			},
			setGazeEnabled: (on) => {
				const core = ctx && ctx.stage.engine ? ctx.stage.engine.motion : null;
				if (core) core.setGazeEnabled(on !== false);
				return !!core;
			},
			debug: () => {
				const core = ctx && ctx.stage.engine ? ctx.stage.engine.motion : null;
				return core ? core.debug() : null;
			},
		},
	};
}

// 模块加载即调度（defer script 时 DOM 已就绪）
scheduleBoot();
