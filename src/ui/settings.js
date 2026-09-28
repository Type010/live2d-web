/**
 * 设置面板：把动画幅度、手感、摆动、触碰反应与帧率做成滑杆，供访客自行调节。
 *
 * 设计约束：
 * - 只暴露"乘在模型自身范围之上的系数"（幅度倍率、灵敏度、弹簧刻度、摆动增益、冲量倍率），
 *   不写死角度、不按模型分支——换任何模型都成立。
 * - 值由调用方（index.js）落到 config 上并持久化到 localStorage，本模块只负责 UI。
 * - 不暴露画质（maxDpr）：清晰度固定按最高渲染，避免访客调低后画面发糊。
 */

/** 滑杆定义：key 与 settings 对象的字段同名；apply 由调用方把 settings 写进 config */
export const CONTROLS = [
	{ group: '动画幅度' },
	{ key: 'amplitude', label: '幅度', min: 0.2, max: 1.5, step: 0.05, digits: 2 },
	{ key: 'spanScale', label: '灵敏度', min: 0.3, max: 1.2, step: 0.05, digits: 2, hint: '量程 = 模型尺寸 × 该值，越小越灵敏' },
	{ group: '手感与摆动' },
	{ key: 'follow', label: '跟手', min: 0, max: 1, step: 0.05, digits: 2, hint: '越大跟得越紧' },
	{ key: 'inertia', label: '惯性', min: 0, max: 1, step: 0.05, digits: 2, hint: '越大过冲与拖尾越明显' },
	{ key: 'swayGain', label: '摆动', min: 0, max: 1.5, step: 0.05, digits: 2 },
	{ key: 'swayHoverGain', label: '悬停摆动', min: 0, max: 2.5, step: 0.05, digits: 2, hint: '指针在模型身上移动时的摆动强度' },
	{ key: 'impulseScale', label: '触碰反应', min: 0, max: 2, step: 0.05, digits: 2, hint: '移上模型 / 点击时的晃动力度' },
	{ group: '性能' },
	// 用自绘按钮而不是原生 <select>：嵌入式 webview（Electron/WebView2 等）里原生下拉弹窗
	// 常常点不开，而这里的按钮走普通 click 事件，任何环境都可靠
	{ key: 'maxFps', label: '帧率上限', type: 'choices', options: [[30, '30'], [45, '45'], [60, '60'], [90, '90'], [120, '120'], [0, '不限']] },
];

/** 默认值（与 src/config.js 的 DEFAULT_CONFIG 保持一致） */
export const DEFAULTS = {
	amplitude: 1,
	spanScale: 0.55,
	follow: 0.55,
	inertia: 0.7,
	swayGain: 0.8,
	swayHoverGain: 1.8,
	impulseScale: 1,
	maxFps: 60,
};

/** 面板挂在工具栏容器里；构造时传入 { get, onChange, onReset } */
export class SettingsPanel {
	constructor({ get, onChange, onReset }) {
		this.get = get; // () => settings 快照
		this.onChange = onChange; // (patch) => void，调用方负责落 config + 持久化
		this.onReset = onReset; // () => void
		this.inputs = new Map();
		this.open = false;
	}

	mount(container) {
		const el = document.createElement('div');
		el.className = 'waifu-panel waifu-settings';
		const head = document.createElement('div');
		head.className = 'waifu-panel-head';
		const title = document.createElement('span');
		title.textContent = '设置';
		const close = document.createElement('button');
		close.className = 'waifu-panel-close';
		close.textContent = '✕';
		close.title = '关闭面板';
		close.addEventListener('click', () => this.show(false));
		head.appendChild(title);
		head.appendChild(close);
		el.appendChild(head);

		for (const c of CONTROLS) {
			if (c.group) {
				const h = document.createElement('h4');
				h.textContent = c.group;
				el.appendChild(h);
				continue;
			}
			const row = document.createElement('div');
			row.className = 'waifu-row';
			const label = document.createElement('label');
			label.textContent = c.label;
			row.appendChild(label);

			let input;
			if (c.type === 'choices') {
				input = document.createElement('div');
				input.className = 'waifu-choices';
				for (const [value, text] of c.options) {
					const btn = document.createElement('button');
					btn.type = 'button';
					btn.className = 'waifu-choice';
					btn.textContent = text;
					btn.dataset.value = String(value);
					btn.addEventListener('click', () => this._emit(c, Number(value)));
					input.appendChild(btn);
				}
			} else {
				input = document.createElement('input');
				input.type = 'range';
				input.min = String(c.min);
				input.max = String(c.max);
				input.step = String(c.step);
				// 拖动过程中即时生效（input 事件），松手不再重复写
				input.addEventListener('input', () => this._emit(c, Number(input.value)));
			}
			row.appendChild(input);

			const val = document.createElement('span');
			val.className = 'val';
			row.appendChild(val);
			el.appendChild(row);

			if (c.hint) {
				const hint = document.createElement('div');
				hint.className = 'waifu-hint';
				hint.textContent = c.hint;
				el.appendChild(hint);
			}
			this.inputs.set(c.key, { c, input, val });
		}

		const foot = document.createElement('div');
		foot.className = 'waifu-settings-foot';
		const reset = document.createElement('button');
		reset.textContent = '恢复默认';
		reset.addEventListener('click', () => {
			this.onReset();
			this.sync();
		});
		foot.appendChild(reset);
		el.appendChild(foot);

		container.appendChild(el);
		this.el = el;
		this.sync();
	}

	_emit(c, value) {
		this.onChange({ [c.key]: value });
		this.sync();
	}

	/** 按当前 settings 刷新控件显示 */
	sync() {
		const s = this.get() || {};
		for (const [key, { c, input, val }] of this.inputs) {
			const v = s[key];
			if (c.type === 'choices') {
				for (const btn of input.querySelectorAll('.waifu-choice')) {
					btn.classList.toggle('on', Number(btn.dataset.value) === Number(v));
				}
				val.textContent = '';
			} else {
				input.value = String(v);
				val.textContent = Number(v).toFixed(c.digits == null ? 2 : c.digits);
			}
		}
	}

	show(on) {
		this.open = !!on;
		if (this.el) this.el.classList.toggle('show', this.open);
	}

	isOpen() {
		return this.open;
	}
}
