/**
 * 行为状态机（核心模块，纯逻辑：不碰 DOM、不读时钟，只按 dt 推进与外部事件驱动）。
 *
 * 负责"什么时候做什么"：空闲微动作、打瞌睡/唤醒的时机与触发条件。
 * 不负责文案与播放——它只产出**请求**（request），由适配层去找文案、播动作、放表情：
 *   request = { motion: {group,index,priority} | null, say: {kind} | null,
 *               reset: bool, pulse: {duration} | null }
 *
 * 能力判定（与模型有关的部分）由适配层注入：
 *   canSleep = 模型有 TapBody 动作组 —— 没有这个组就没有"打瞌睡"这个状态
 */

const randRange = (min, max) => min + Math.random() * (max - min);
/** 取有限数值，否则回退默认（配置里可能缺项或写错类型） */
const num = (v, def) => (typeof v === 'number' && isFinite(v) ? v : def);

export function createBehaviorState(cfg, caps, pose) {
	// 阈值都可运行期重配（设置面板）
	let idleCfg = {};
	let sleepyCfg = {};
	let tapCfg = {};
	const sleepy = { enabled: true, hiddenAfter: 60, idleAfter: 180, checkInterval: 5 };
	let capabilities = caps || {};

	/** 重配行为阈值（打瞌睡的判定下一个检查周期生效；正在睡的不会被打断） */
	function configure(next) {
		const c = next || {};
		idleCfg = c.idleRandom || {};
		sleepyCfg = c.sleepy || {};
		tapCfg = c.tap || {};
		sleepy.enabled = sleepyCfg.enabled !== false;
		sleepy.hiddenAfter = num(sleepyCfg.hiddenAfter, 60000) / 1000;
		sleepy.idleAfter = num(sleepyCfg.idleAfter, 180000) / 1000;
		sleepy.checkInterval = num(sleepyCfg.checkInterval, 5000) / 1000;
	}
	configure(cfg);

	let awake = true;
	let idleFor = 0; // 无操作累计秒数
	let hiddenFor = 0; // 页面隐藏累计秒数（可见时为 0）
	let hidden = false;
	let checkAcc = 0;
	let pulseIn = Infinity;
	let request = null;

	/** 这个模型有没有"打瞌睡"这个状态（有 TapBody 组才有） */
	function canSleep() {
		return sleepy.enabled && !!capabilities.hasTapBody;
	}

	function doSleep() {
		awake = false;
		pose && pose.setEnabled(false); // 睡着后不再被鼠标牵着走
		request = {
			motion: { group: 'TapBody', index: 0, priority: 3 },
			say: sleepyCfg.sayDuration === 0 ? null : { kind: 'sleepy' },
			reset: false,
			pulse: null,
		};
	}

	function doWake(silent) {
		awake = true;
		pose && pose.setEnabled(true);
		request = {
			motion: { group: 'Idle', index: 0, priority: 3 },
			say: silent ? null : { kind: 'wake' },
			// 打瞌睡动作写下的低头/闭眼不会被动待机动作接管，先复位再播待机（唤醒时不留睡姿）
			reset: true,
			pulse: null,
		};
	}

	return {
		configure,

		/** 换模型后更新能力（hasTapBody / 之后可能还有别的） */
		setCapabilities(next) {
			capabilities = next || {};
			// 新模型没有打瞌睡状态时，立刻从睡眠状态回到清醒，避免残留"睡着"的标志
			if (!awake && !canSleep()) {
				awake = true;
				pose && pose.setEnabled(true);
			}
		},

		isSleepy() {
			return !awake;
		},

		canSleep,

		/** 用户操作（指针/键盘/滚动）：重置空闲计时；睡着时唤醒 */
		onActivity() {
			idleFor = 0;
			if (!awake) doWake(false);
		},

		/** 页面可见性变化 */
		onVisibility(isHidden) {
			hidden = !!isHidden;
			hiddenFor = 0;
			if (!hidden && !awake) doWake(false);
			if (!hidden) idleFor = 0;
		},

		/** 点击模型：睡着时唤醒；否则出一个随机小表情 + 文案 */
		onTap() {
			idleFor = 0;
			if (!awake) {
				doWake(false);
				return request;
			}
			if (tapCfg.enabled === false) return null;
			request = {
				motion: null,
				say: { kind: 'tap' },
				reset: false,
				pulse: { duration: num(tapCfg.duration, 5000) },
			};
			return request;
		},

		/** 手动进入/退出睡眠（控制台 API 与自动判定共用） */
		sleep() {
			if (!canSleep() || !awake) return false;
			doSleep();
			return true;
		},

		wake(silent) {
			if (awake) return false;
			doWake(!!silent);
			return true;
		},

		/** 取走本帧产生的一次性请求（取过即清） */
		takeRequest() {
			const r = request;
			request = null;
			return r;
		},

		update(dt) {
			const d = Math.max(0, Math.min(0.25, dt || 0));
			idleFor += d;
			if (hidden) hiddenFor += d;

			// 空闲随机小表情：睡着的模型不参与（睡着时表情自己变会像故障）
			if (idleCfg.enabled && awake) {
				if (!isFinite(pulseIn)) {
					pulseIn = randRange(num(idleCfg.minGap, 25000) / 1000, num(idleCfg.maxGap, 45000) / 1000);
				}
				pulseIn -= d;
				if (pulseIn <= 0) {
					pulseIn = randRange(num(idleCfg.minGap, 25000) / 1000, num(idleCfg.maxGap, 45000) / 1000);
					request = {
						motion: null,
						say: null,
						reset: false,
						pulse: { duration: num(idleCfg.duration, 5000) },
					};
				}
			}

			// 打瞌睡判定：按 checkInterval 节流，避免每帧判定
			checkAcc += d;
			if (awake && canSleep() && checkAcc >= sleepy.checkInterval) {
				checkAcc = 0;
				if (hidden && hiddenFor >= sleepy.hiddenAfter) doSleep();
				else if (idleFor >= sleepy.idleAfter) doSleep();
			}
		},

		debug() {
			return { awake, idleFor, hiddenFor, hidden, pulseIn, canSleep: canSleep(), config: sleepy };
		},
	};
}
