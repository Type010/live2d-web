/**
 * 眨眼状态机（核心模块，纯逻辑：不碰 Live2D、不读时钟，只按 dt 推进）。
 *
 * 分段与官方 CubismEyeBlink 一致：间隔(睁) → 闭 → 保持 → 睁，三段时长按官方
 * 0.1 / 0.05 / 0.15 秒的比例摊开；间隔在 0…2×interval 之间随机。
 *
 * 与官方实现的关键差别：官方把"跳过眨眼"的条件绑在 CubismEyeBlinkUpdater 上
 * （本帧动作有更新就跳过），而待机动作是无限循环、每帧都在更新，眨眼于是永远不会执行。
 * 这里改成由调用方传入"当前动作是否自己驱动眼睛"（suppressed），只在那一刻让位。
 */

const PHASE = { Interval: 0, Closing: 1, Closed: 2, Opening: 3 };
// 官方默认三段时长比例（总计 0.3 秒）
const RATIO = { closing: 0.1 / 0.3, closed: 0.05 / 0.3, opening: 0.15 / 0.3 };

export function createBlink(cfg) {
	// 间隔/时长/开关都可运行期重配（设置面板），所以放在可变量里
	let enabled = true;
	let interval = 4;
	let duration = 0.3;
	let closing = 0;
	let closed = 0;
	let opening = 0;

	/** 重配（下一个间隔周期生效；正在进行的这次眨眼不打断） */
	function configure(next) {
		const c = next || {};
		enabled = c.enabled !== false;
		interval = c.interval > 0 ? c.interval : 4.0; // 秒；<=0 用官方默认
		duration = c.duration > 0 ? c.duration : 0.3;
		closing = duration * RATIO.closing;
		closed = duration * RATIO.closed;
		opening = duration * RATIO.opening;
	}
	configure(cfg);

	let phase = PHASE.Interval;
	let phaseTime = 0;
	let nextBlinkIn = 0;

	/** 下一次眨眼的等待时间：与官方 determinNextBlinkingTiming 同分布（0…2×interval） */
	function schedule() {
		nextBlinkIn = Math.random() * (2 * interval);
	}

	return {
		/** 模型有没有 EyeBlink 组、配置有没有开 */
		isEnabled() {
			return enabled;
		},

		configure,

		/** 重置：换模型或唤醒后重新计时 */
		reset() {
			phase = PHASE.Interval;
			phaseTime = 0;
			schedule();
		},

		/**
		 * 推进一步。
		 * @param dt 秒
		 * @param suppressed 当前动作是否自己驱动眼睛（true = 让位）
		 * @returns {number|null} 眼睛张开度 0…1；**null 表示本帧不要写眼睛参数**
		 *   （配置关闭时永远 null；动作用眼睛期间也让位——写 1 会把动作的闭眼顶开）
		 */
		update(dt, suppressed) {
			if (!enabled) return null;
			const d = Math.max(0, Math.min(0.05, dt || 0));
			if (suppressed) {
				// 让位期间停在"睁"的状态并重新计时，动作结束后不会立刻猛眨一下
				phase = PHASE.Interval;
				phaseTime = 0;
				schedule();
				return null;
			}
			phaseTime += d;
			switch (phase) {
				case PHASE.Closing: {
					const t = Math.min(1, phaseTime / closing);
					if (t >= 1) {
						phase = PHASE.Closed;
						phaseTime = 0;
					}
					return 1 - t;
				}
				case PHASE.Closed: {
					if (phaseTime >= closed) {
						phase = PHASE.Opening;
						phaseTime = 0;
					}
					return 0;
				}
				case PHASE.Opening: {
					const t = Math.min(1, phaseTime / opening);
					if (t >= 1) {
						phase = PHASE.Interval;
						phaseTime = 0;
						schedule();
					}
					return t;
				}
				default: {
					nextBlinkIn -= d;
					if (nextBlinkIn <= 0) {
						phase = PHASE.Closing;
						phaseTime = 0;
					}
					return 1;
				}
			}
		},

		debug() {
			return { enabled, interval, duration, phase, phaseTime, nextBlinkIn };
		},
	};
}
