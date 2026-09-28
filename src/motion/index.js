/**
 * 动画核心模块（waifu-web motion core）——"角色动画驱动"的唯一实现处。
 *
 * 这里决定角色**动成什么样**：视线与头身姿态（弹簧、冲量、follow-through）、
 * 眨眼节奏、空闲微动作、打瞌睡/唤醒的时机与姿态过渡。
 * 它不读时钟、不碰 DOM、不碰 Live2D——只有 dt 与事件进出，不依赖任何运行时环境。
 *
 * 适配层（engine / stage / behaviors）只做三件事：
 *   1) 把指针、悬停、点击、可见性等事件喂进来；
 *   2) 每帧调 tick(dt)，把返回的归一化姿态乘上**模型自身的参数范围**写进 Live2D；
 *   3) 执行 tick 返回的请求（播动作、出气泡、放表情）。
 *
 * 归一化约定：姿态各分量取值 -1..1，1 表示"用满该参数的可变范围"。
 */

import { createPoseSolver } from './pose.js';
import { createBlink } from './blink.js';
import { createBehaviorState } from './state.js';

export function createMotionDriver(config, capabilities) {
	let cfg = config || {};
	const pose = createPoseSolver(cfg.gaze);
	const blink = createBlink(cfg.blink);
	const state = createBehaviorState(cfg.behaviors, capabilities, pose);
	let caps = capabilities || {};

	return {
		/* ---------- 事件入口（由适配层调用） ---------- */

		/** 归一化指针位置（-1..1，原点=模型顶边中点，y 向上为正） */
		setPointer(x, y) {
			pose.setTarget(x, y);
		},

		/** 指针速度（归一化 -1..1，调用方已平滑）：驱动"反着鼠标方向"的摆动 */
		setPointerSpeed(vx, vy) {
			pose.setPointerSpeed(vx, vy);
		},

		/** 指针是否落在模型身上：在上面移动时摆动更明显 */
		setHover(on) {
			pose.setHover(on);
		},

		/** 冲量（指针移入模型 / 点击模型）：头身带着物理链晃一下 */
		impulse(vx, vy) {
			pose.impulse(vx, vy);
		},

		onActivity() {
			state.onActivity();
		},

		onVisibility(hidden) {
			state.onVisibility(hidden);
		},

		onTap() {
			return state.onTap();
		},

		sleep() {
			return state.sleep();
		},

		wake(silent) {
			return state.wake(silent);
		},

		/** 视线跟随开关（不改变睡眠状态，仅用于调试/宿主页面控制） */
		setGazeEnabled(on) {
			pose.setEnabled(on);
		},

		/**
		 * 重配手感与行为（设置面板即时生效）：弹簧/摆动/冲量倍率、眨眼节奏、行为阈值。
		 * 只改旋钮，不打断当前姿态、眨眼进度或睡眠状态。
		 */
		configure(nextConfig) {
			if (nextConfig) cfg = nextConfig;
			const c = cfg;
			pose.setTuning(c.gaze);
			blink.configure(c.blink);
			state.configure(c.behaviors);
		},

		/** 换模型后更新能力判定（hasTapBody / hasEyeBlink 由适配层从模型读出） */
		setCapabilities(next) {
			caps = next || {};
			state.setCapabilities(caps);
		},

		/* ---------- 每帧 ---------- */

		/**
		 * @param dt 秒（与 SDK 动作/物理同一时钟）
		 * @param opts.eyesSuppressed 当前动作是否自己驱动眼睛（true = 眨眼让位）
		 * @returns {{
		 *   pose: object,          // 归一化姿态：headX/Y/Z、bodyX/Y/Z、eyeX/Y
		 *   weight: number,        // 视线权重；为 0 时适配层应停止写姿态参数（让位给动作）
		 *   eyeOpen: number|null,  // 眼睛张开度 0..1；null = 不由核心管（走 SDK 眨眼）
		 *   state: 'awake'|'sleepy',
		 *   request: object|null,  // 一次性请求：{ motion, say, reset, pulse }
		 *   debug: object,
		 * }}
		 */
		tick(dt, opts) {
			const eyesSuppressed = !!(opts && opts.eyesSuppressed);
			// 先跑状态机（睡眠/唤醒本帧就改变视线权重），再积分姿态，最后算眨眼
			state.update(dt);
			const frame = pose.update(dt);
			const eyeOpen = blink.update(dt, eyesSuppressed);
			return {
				pose: frame.pose,
				weight: frame.weight,
				eyeOpen,
				state: state.isSleepy() ? 'sleepy' : 'awake',
				request: state.takeRequest(),
				debug: { pose: pose.debug(), blink: blink.debug(), state: state.debug() },
			};
		},

		/* ---------- 查询（调试用） ---------- */

		/** 核心内部状态快照（控制台排查用，不产生任何副作用） */
		debug() {
			return { pose: pose.debug(), blink: blink.debug(), state: state.debug() };
		},

		blinkEnabled() {
			return blink.isEnabled();
		},

		/** 唤醒/换模型后重置眨眼计时，避免立刻猛眨一下 */
		resetBlink() {
			blink.reset();
		},
	};
}
