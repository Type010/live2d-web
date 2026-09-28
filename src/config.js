/**
 * 默认配置与合并工具。
 * 使用方通过 script 标签的 data-* 属性覆盖：
 *   data-models / data-core / data-vendor / data-min-width / data-z-index / data-lazy
 * 模型显示尺寸由 models.json 的 scale 控制，不走 script 属性。
 */
export const DEFAULT_CONFIG = {
	// 模型清单 URL（必填）。清单可托管任意静态服务，模型路径允许完整远程 URL。
	modelsUrl: null,
	// Cubism 内核 URL。默认取 bundle 同目录 vendor/live2dcubismcore.min.js
	coreUrl: null,
	// 运行时目录（内核 live2dcubismcore.min.js、渲染引擎 engine.js、着色器 shaders/）。默认 bundle 同目录 vendor/
	vendorUrl: null,
	// 懒加载（data-lazy，默认 true）：模型资源在切换到它时才下载。
	// 置 false 时启动后的空闲时段会把清单里所有模型的资源预取进浏览器缓存，
	// 之后切换无需等网络——只预取不加载体，不占显存。
	lazy: true,
	minWidth: 768,
	zIndex: 9999,
	storageKey: 'waifu-web',
	// 初始画布高度（px）；模型加载后按清单 content 自动贴合内容，此处仅作加载期间兜底
	height: 240,
	// 模型基准显示高度（px）：实际大小 = 该值 × 模型条目的 scale，各模型独立调大小
	modelHeight: 350,
	// 渲染帧率上限：高刷屏（120/165Hz）下逐帧重绘会明显拖慢宿主页面，60 已足够顺滑
	maxFps: 60,
	// 画布像素比上限：模型贴图普遍 4K/8K 而显示高度仅 350px，截断过分（如固定 2）
	// 会在 2.5x/3x 缩放的屏幕上放大位图导致发糊；画布只有 360px 宽，dpr3 的填充量仍很小。
	// 这一项**不开放给访客**（设置面板里没有），固定按最清晰渲染，避免有人调低后画面发糊。
	maxDpr: 3,
	behaviors: {
		greeting: true,
		greetingDelay: 800, // 开场白延迟（ms）
		// 空闲随机表情：默认关闭——访客没有操作时表情自己变化会被当成故障
		// （每个 25~45 秒随机挑一个 temp 表情脉冲 5 秒）。需要 VTS 那种自发表情时改 true。
		idleRandom: { enabled: false, minGap: 25000, maxGap: 45000, duration: 5000 },
		// pauseGaze: 打瞌睡期间停止视线跟随（睡着的人不该继续盯着鼠标）
		sleepy: { enabled: true, hiddenAfter: 60000, idleAfter: 180000, checkInterval: 5000, sayDuration: 6000, pauseGaze: true },
		tap: { enabled: true, duration: 5000 },
	},
	/*
	 * 视线跟随便量：数值是「占模型自身参数可变范围的比例」，不是固定角度。
	 * 实际量程在装载模型时从模型里读（见 engine._setupGaze），所以换模型不用改代码，
	 * 模型没有的参数会自动跳过。
	 * head/tilt 头部左右·上下·侧倾；bodyX/bodyY/bodyZ 身体左右·前后·侧倾；
	 * eyes 眼球。身体三个轴都会带动物理链，头发裙摆随之摆动。
	 *
	 * spring：头/身体的跟随手感，二阶弹簧。
	 *   follow  0~1，越大跟得越紧（刚度 30→220）
	 *   inertia 0~1，越大越"重"：质量变大、阻尼比变小（1→0.25），过冲和拖尾更明显
	 *   眼球不受这两个值影响，永远是硬弹簧跟手（眼睛不跟着头一起甩）；
	 *   身体的目标是"头当前的位置"而不是指针（follow-through）：头先动、身体延迟跟上再回摆，
	 *   所以鼠标在模型上移动的过程中身体会一直摆，不只是进出时动一下
	 * hoverImpulse / tapImpulse：指针移上模型、点击模型时给视线的冲量（0 = 关闭）。
	 *   强度按此值 × (0.6 + 0.4×指针速度) 施加；冲量速度上限 14（归一化视线单位/秒）。
	 *   默认值下头会甩到 ±15° 上下、身体 ±8~10°，来回摆两下后收住。
	 */
	gaze: {
		enabled: true,
		// amplitude：幅度总倍率（设置面板的"动画幅度"滑杆）——乘在上面各轴比例之上，
		// 所以调节它不会破坏"比例来自模型自身范围"这条通用性
		amplitude: 1,
		head: 1, tilt: 0.7, bodyX: 1, bodyY: 0.7, bodyZ: 1, eyes: 1,
		/*
		 * spanScale：视线量程 = 模型显示尺寸 × 该值（下限 200px / 220px）。
		 * 越小越灵敏——早期用"视口一半"当量程，指针要移出几百像素才到满量程，
		 * 观感是"怎么动都不动"；0.55 表示指针离开模型中心约 200px 就到满偏。
		 */
		spanScale: 0.55,
		spring: { follow: 0.55, inertia: 0.7 },
		hoverImpulse: 7.5,
		tapImpulse: 9,
		/*
		 * sway：身体"反着鼠标移动方向"的左右摆动（鼠标往右划 → 身体先往左让，停下后弹回来）。
		 * gain 是平时的强度，hoverGain 是指针在模型身上移动时的强度（更明显）。
		 * 数值乘以指针速度（约 ±1），再乘到 bodyZ/bodyX 上，所以 1.0 就接近"满量程左右晃"。
		 */
		sway: { gain: 0.8, hoverGain: 1.8 },
		// impulseScale：移入/点击冲量的总倍率（设置面板的"触碰反应"滑杆）
		impulseScale: 1,
	},
	/*
	 * 自动眨眼：interval 是眨眼间隔[秒]（实际间隔在该值的 0~2 倍间随机），
	 * duration 是单次眨眼总时长[秒]（闭/保持/睁三段按官方 0.1/0.05/0.15 的比例摊开）。
	 * 写 0 表示沿用官方默认（4 秒 / 0.3 秒）。动作自己驱动眼睛时会自动让位，无需配置。
	 */
	blink: { enabled: true, interval: 3.5, duration: 0.25 },
};

/** 合并覆盖项（data-* 属性产出的都是标量，浅合并即可） */
export function mergeConfig(base, overrides) {
	const out = { ...base };
	for (const key of Object.keys(overrides || {})) {
		const v = overrides[key];
		if (v !== undefined && v !== null) out[key] = v;
	}
	return out;
}

/** 从 script 标签 data-* 属性构造覆盖项 */
export function configFromAttributes(dataset) {
	const o = {};
	if (dataset.models) o.modelsUrl = dataset.models;
	if (dataset.core) o.coreUrl = dataset.core;
	if (dataset.vendor) o.vendorUrl = dataset.vendor;
	if (dataset.minWidth) o.minWidth = Number(dataset.minWidth) || DEFAULT_CONFIG.minWidth;
	if (dataset.zIndex) o.zIndex = Number(dataset.zIndex) || DEFAULT_CONFIG.zIndex;
	// data-lazy="false"：清单里所有模型的资源在空闲时预取进浏览器缓存，
	// 之后切换模型不用再等网络（只预取、不建 GL 资源，不占显存）
	if (dataset.lazy !== undefined) o.lazy = dataset.lazy !== 'false';
	return o;
}

/** localStorage 记忆（开关/最小化/位置），损坏时静默重建 */
export function loadStorage(key) {
	try {
		return JSON.parse(localStorage.getItem(key)) || {};
	} catch {
		return {};
	}
}

export function saveStorage(key, data) {
	try {
		localStorage.setItem(key, JSON.stringify(data));
	} catch {
		/* 隐私模式等场景下静默失败 */
	}
}
