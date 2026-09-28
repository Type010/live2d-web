/**
 * 姿态求解器（核心模块，纯数学：不碰 Live2D、不碰 DOM、不读时钟）。
 *
 * 输入是归一化的指针位置与冲量，输出是归一化的头/身体/眼球姿态（-1..1），
 * 由适配层（engine）乘上模型自身的参数范围后写进 Live2D。
 *
 * 三组弹簧：
 * - 头：跟得紧，阻尼比 < 1（有过冲，收尾要晃两下）
 * - 身体：目标是"头当前的位置"而不是指针（follow-through）——头先动、身体延迟跟上再回摆，
 *   所以指针一直在移动时身体就一直在摆，不只是进出时动一下
 * - 眼球：更硬的临界阻尼弹簧，跟手但不跟着头一起甩
 *
 * 手感刻度（两个可调旋钮映射到二阶弹簧参数）：
 *   stiffness = 30 + follow × 190，mass = 0.75 + inertia × 2.25，ζ = 1 − inertia × 0.75
 * 积分用半隐式欧拉 + 固定子步（1/120 秒）、单帧 dt 上限 0.05 秒，掉帧时不会发散。
 */

const MAX_STEP = 1 / 120;
const MAX_FRAME_DT = 0.05;
const SETTLE_POS = 0.001;
const SETTLE_VEL = 0.001;
const IMPULSE_CAP = 14; // 归一化视线单位/秒：极端指针速度下也把峰值限制在量程内
const WEIGHT_EASE = 4; // 权重每秒的指数逼近速率（约 0.25 秒完成 1→0）

const clamp01 = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : null);

/** 按 follow / inertia 生成弹簧系数（k 刚度、m 质量、c 阻尼）；opts.zeta 可显式指定阻尼比 */
function makeSpring(follow, inertia, opts = {}) {
	const k = (30 + follow * 190) * (opts.stiffnessScale == null ? 1 : opts.stiffnessScale);
	const m = (0.75 + inertia * 2.25) * (opts.massScale == null ? 1 : opts.massScale);
	const zeta = opts.zeta != null ? opts.zeta : Math.max(0.15, 1 - inertia * 0.75);
	return { k, m, c: 2 * zeta * Math.sqrt(k * m), zeta };
}

export function createPoseSolver(cfg) {
	// 弹簧、摆动增益、冲量倍率都可以运行期重配（设置面板的滑杆即时生效），
	// 所以都放在可变的 tuning 里，由 setTuning() 重建。
	let head, body, eye, swaySpring;
	let swayGain, swayHoverGain, impulseScale;

	/** 按配置重建弹簧刻度；只改旋钮不影响当前姿态（位置/速度继续用旧的积分状态） */
	function setTuning(next) {
		const c = next || {};
		const follow = clamp01(c.spring && c.spring.follow);
		const inertia = clamp01(c.spring && c.spring.inertia);
		const f = follow == null ? 0.55 : follow;
		const i = inertia == null ? 0.7 : inertia;
		head = makeSpring(f, i);
		body = makeSpring(f, i, { stiffnessScale: 0.5, massScale: 1.2, zeta: Math.max(0.15, 1 - i * 0.75 - 0.12) });
		// 眼球：更硬的临界阻尼弹簧（ζ=1，不过冲）——跟手但不跟着头一起甩
		eye = makeSpring(f, i, { stiffnessScale: 4, zeta: 1 });
		// 摆动（sway）：身体"反着鼠标移动方向"左右晃的那条弹簧。
		// 目标是"指针速度取反"，所以鼠标往右划、身体先往左让，停下后再弹回来（会过冲几下）。
		// 阻尼比固定 0.32：晃得明显、收得住，且与头身的手感解耦。
		swaySpring = makeSpring(f, i, { stiffnessScale: 0.9, massScale: 1.1, zeta: 0.32 });
		const swayCfg = c.sway || {};
		swayGain = swayCfg.gain == null ? 0.8 : swayCfg.gain; // 平时（指针不在模型上）
		swayHoverGain = swayCfg.hoverGain == null ? 1.8 : swayCfg.hoverGain; // 指针在模型身上时更明显
		const scale = c.impulseScale;
		impulseScale = typeof scale === 'number' && isFinite(scale) ? Math.max(0, scale) : 1;
	}
	setTuning(cfg);
	const c = cfg || {};

	const pos = { hx: 0, hy: 0, bx: 0, by: 0, ex: 0, ey: 0, sx: 0 };
	const vel = { hx: 0, hy: 0, bx: 0, by: 0, ex: 0, ey: 0, sx: 0 };
	const target = { x: 0, y: 0 };
	let speedX = 0; // 指针横向速度（归一化 ±1）
	let speedY = 0;
	let hovering = false;
	let weight = 1; // 视线权重：打瞌睡时收到 0，让位给睡眠动作/物理
	let weightTarget = 1;

	/** 半隐式欧拉 + 子步；位置与速度都很小时吸附到目标，避免长期残留极小抖动 */
	function step(s, v, tx, ty, spring, dt) {
		const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
		const h = dt / steps;
		for (let n = 0; n < steps; n++) {
			v[0] += ((spring.k * (tx - s[0]) - spring.c * v[0]) / spring.m) * h;
			v[1] += ((spring.k * (ty - s[1]) - spring.c * v[1]) / spring.m) * h;
			s[0] += v[0] * h;
			s[1] += v[1] * h;
		}
		if (
			Math.abs(s[0] - tx) < SETTLE_POS && Math.abs(s[1] - ty) < SETTLE_POS &&
			Math.abs(v[0]) < SETTLE_VEL && Math.abs(v[1]) < SETTLE_VEL
		) {
			s[0] = tx; s[1] = ty; v[0] = 0; v[1] = 0;
		}
	}

	return {
		/** 归一化指针位置（-1..1，原点=模型顶边中点，y 向上为正） */
		setTarget(x, y) {
			target.x = Math.max(-1, Math.min(1, x || 0));
			target.y = Math.max(-1, Math.min(1, y || 0));
		},

		/** 视线权重目标：0 = 完全让位（打瞌睡），1 = 正常跟随 */
		setEnabled(on) {
			weightTarget = on ? 1 : 0;
		},

		/** 指针横向/纵向速度（归一化 -1..1，调用方已平滑）：用于"反着鼠标方向"的摆动 */
		setPointerSpeed(vx, vy) {
			speedX = Math.max(-1, Math.min(1, vx || 0));
			speedY = Math.max(-1, Math.min(1, vy || 0));
		},

		/** 指针是否在模型身上：在上面移动时摆动更明显 */
		setHover(on) {
			hovering = !!on;
		},

		/** 重配手感（设置面板即时生效）：弹簧刻度、摆动增益、冲量倍率 */
		setTuning,

		/** 冲量：直接加到速度上（指针移入模型 / 点击模型时的"晃一下"） */
		impulse(vx, vy) {
			const k = impulseScale;
			const add = (cur, d) => Math.max(-IMPULSE_CAP, Math.min(IMPULSE_CAP, cur + (d || 0) * k));
			vel.hx = add(vel.hx, vx);
			vel.hy = add(vel.hy, vy);
			vel.bx = add(vel.bx, (vx || 0) * 0.6);
			vel.by = add(vel.by, (vy || 0) * 0.6);
			vel.sx = add(vel.sx, (vx || 0) * 1.2); // 摆动也跟着被推一把，点击时晃得更明显
		},

		/**
		 * 推进一步。dt 为秒（调用方传 SDK 的时间增量，与动作/物理同一个时钟）。
		 * 返回归一化姿态与当前权重；weight 为 0 时调用方应停止写参数（让动作/物理接管）。
		 */
		update(dt) {
			const d = Math.max(0, Math.min(MAX_FRAME_DT, dt || 0));
			if (weight !== weightTarget) {
				weight += (weightTarget - weight) * Math.min(1, WEIGHT_EASE * d);
				if (Math.abs(weight - weightTarget) < 0.002) weight = weightTarget;
			}
			const hs = [pos.hx, pos.hy];
			const bs = [pos.bx, pos.by];
			const es = [pos.ex, pos.ey];
			const ss = [pos.sx, 0];
			const hv = [vel.hx, vel.hy];
			const bv = [vel.bx, vel.by];
			const ev = [vel.ex, vel.ey];
			const sv = [vel.sx, 0];
			step(hs, hv, target.x, target.y, head, d);
			// 身体的目标是"头当前位置"，不是指针——这就是 follow-through
			step(bs, bv, hs[0], hs[1], body, d);
			step(es, ev, target.x, target.y, eye, d);
			// 摆动：目标 = 指针速度**取反**（鼠标往右划 → 身体先往左让，停下后弹回来）
			const gain = hovering ? swayHoverGain : swayGain;
			step(ss, sv, -speedX * gain, 0, swaySpring, d);
			pos.hx = hs[0]; pos.hy = hs[1];
			pos.bx = bs[0]; pos.by = bs[1];
			pos.ex = es[0]; pos.ey = es[1];
			pos.sx = ss[0];
			vel.hx = hv[0]; vel.hy = hv[1];
			vel.bx = bv[0]; vel.by = bv[1];
			vel.ex = ev[0]; vel.ey = ev[1];
			vel.sx = sv[0];

			return {
				weight,
				pose: {
					headX: pos.hx * weight,
					headY: pos.hy * weight,
					headZ: (pos.hx * pos.hy * -1 + pos.sx * 0.25) * weight, // 斜着看时头部侧倾；摆动也带一点歪头
					bodyX: (pos.bx + pos.sx * 0.35) * weight, // 身体左右：跟随 + 摆动的横向分量
					bodyY: pos.by * weight,
					bodyZ: (pos.bx * -1 + pos.sx * 1.0) * weight, // 身体侧倾：视线方向 + 摆动（左右晃的主要来源）
					eyeX: pos.ex * weight,
					eyeY: pos.ey * weight,
				},
			};
		},

		/** 调试用：当前内部状态快照 */
		debug() {
			return {
				target: { ...target }, weight, speed: { x: speedX, y: speedY }, hovering,
				spring: { head, body, eye, sway: swaySpring }, pos: { ...pos }, vel: { ...vel },
			};
		},
	};
}
