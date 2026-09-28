/**
 * 行为适配层：把页面事件喂给动画核心，并把核心产出的请求落到 UI 上。
 *
 * 与旧版的区别：这里**不再决定**什么时候打瞌睡、什么时候出随机小表情、点击后做什么——
 * 那些策略全在核心模块（src/motion/state.js）里；本文件只剩下：
 *   DOM 事件 → core.onActivity / onVisibility / onTap
 *   core 的 request → 气泡文案 / 播动作 / 参数复位 / 表情脉冲
 * 开场白是页面级文案（每个会话说一次），留在这一层。
 */

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class Behaviors {
	constructor({ stage, composer, bubble, config, entry }) {
		this.stage = stage;
		this.composer = composer;
		this.bubble = bubble;
		this.config = config;
		this.entry = entry;
		this._onTap = () => this.onTap();
		this._onActivity = () => this.core() && this.core().onActivity();
		this._onVisibility = () => this.core() && this.core().onVisibility(document.hidden);
	}

	/** 动画核心（在 stage 装载模型后创建；模型未就绪时为 null） */
	core() {
		return this.stage && this.stage.engine ? this.stage.engine.motion : null;
	}

	start() {
		this.stage.onTap = this._onTap;
		if (this.stage.engine) this.stage.engine.onRequest = (req) => this.handleRequest(req);
		document.addEventListener('pointermove', this._onActivity);
		document.addEventListener('pointerdown', this._onActivity);
		document.addEventListener('keydown', this._onActivity);
		document.addEventListener('scroll', this._onActivity);
		document.addEventListener('visibilitychange', this._onVisibility);
		const core = this.core();
		if (core) core.onActivity();

		// 开场白每个浏览会话只播一次：站内切换页面（MPA 导航）时不重复问候；
		// 会话标记随 storageKey 隔离，避免同站点多实例互相影响
		const greetKey = `${this.config.storageKey}-greeted`;
		let greeted = null;
		try {
			greeted = sessionStorage.getItem(greetKey);
		} catch {
			/* 隐私模式下静默 */
		}
		if (this.config.behaviors.greeting && !greeted && this.entry.messages && this.entry.messages.greeting) {
			const delay = this.config.behaviors.greetingDelay;
			this._greetTimer = setTimeout(() => this.bubble.say(rand(this.entry.messages.greeting)), delay);
			try {
				sessionStorage.setItem(greetKey, '1');
			} catch {
				/* 隐私模式下静默 */
			}
		}
	}

	stop() {
		if (this._greetTimer) clearTimeout(this._greetTimer);
		this._greetTimer = 0;
		if (this.stage.engine) this.stage.engine.onRequest = null;
		document.removeEventListener('pointermove', this._onActivity);
		document.removeEventListener('pointerdown', this._onActivity);
		document.removeEventListener('keydown', this._onActivity);
		document.removeEventListener('scroll', this._onActivity);
		document.removeEventListener('visibilitychange', this._onVisibility);
	}

	/* ---------- 核心请求 → UI ---------- */

	handleRequest(req) {
		if (!req) return;
		if (req.reset) this.stage.resetParameters();
		if (req.motion) this.stage.playMotion(req.motion.group, req.motion.index, req.motion.priority);
		if (req.pulse) this.pulseTemp(req.pulse.duration);
		if (req.say) this.sayKind(req.say.kind);
	}

	/** 状态文案（池子来自清单 messages；唤醒语是固定文案） */
	sayKind(kind) {
		if (kind === 'wake') {
			this.bubble.say('呀！我在的我在的～');
			return;
		}
		const pool = this.entry.messages && this.entry.messages[kind];
		if (!pool) return;
		const duration = kind === 'sleepy' ? this.config.behaviors.sleepy.sayDuration : undefined;
		this.bubble.say(rand(pool), duration);
	}

	/** 随机叠加一个 temp 表情（点击反应与空闲微动作共用） */
	pulseTemp(duration) {
		const temps = (this.entry.expressions || []).filter((e) => e.temp);
		if (temps.length) this.composer.pulse(rand(temps).name, duration);
	}

	/* ---------- 事件转发 ---------- */

	onTap() {
		const core = this.core();
		if (!core) return;
		const req = core.onTap(); // 睡着时是唤醒；醒着时是"随机小表情 + 文案"
		if (req) this.handleRequest(req);
	}

	sleep() {
		const core = this.core();
		return core ? core.sleep() : false;
	}

	wake(silent) {
		const core = this.core();
		return core ? core.wake(silent) : false;
	}
}
