/**
 * 工具栏 + 表情面板。
 * 工具栏默认隐藏，鼠标悬停到模型上时从模型右侧弹出。
 * 图标为内联 SVG（见 ui/icons.js），随 bundle 一起走，不加载图标字体。
 * 位置随模型内容包围盒锚定（贴内容顶部右侧）。
 */
import { ICONS } from './icons.js';

const BUTTONS = [
	{ id: 'panel', icon: ICONS.panel, title: '表情' },
	{ id: 'model', icon: ICONS.model, title: '切换模型' },
	{ id: 'settings', icon: ICONS.settings, title: '设置' },
	{ id: 'reset', icon: ICONS.reset, title: '恢复默认' },
	{ id: 'min', icon: ICONS.min, title: '最小化' },
	{ id: 'close', icon: ICONS.close, title: '关闭' },
];

export class Toolbar {
	constructor() {
		this.panel = null;
		this.settingsPanel = null; // ui/settings.js 的面板（可选：宿主不传就没有这块）
		this.gridRefs = new Map(); // name -> button element
		this._hideTimer = null;
		this._outsideCloser = null;
		this._panelOpen = false; // 表情面板开合的唯一真值（不再反查 DOM class）
	}

	/**
	 * 挂载工具栏。
	 * handlers: { panel, model, reset, min, close, onRestore }
	 */
	mount(container, handlers) {
		this.root = container;
		const bar = document.createElement('div');
		bar.className = 'waifu-toolbar';
		for (const b of BUTTONS) {
			const btn = document.createElement('button');
			btn.className = 'waifu-btn';
			btn.innerHTML = b.icon;
			btn.title = b.title;
			btn.addEventListener('click', () => handlers[b.id] && handlers[b.id]());
			// 悬停工具栏期间不隐藏
			btn.addEventListener('pointerenter', () => this.showBar());
			bar.appendChild(btn);
		}
		container.appendChild(bar);
		this.bar = bar;

		this.panel = document.createElement('div');
		this.panel.className = 'waifu-panel';
		this.panel.addEventListener('pointerenter', () => this.showBar());
		container.appendChild(this.panel);

		// 最小化时的恢复按钮
		this.minBtn = document.createElement('button');
		this.minBtn.className = 'waifu-min-btn';
		this.minBtn.title = '展开看板娘';
		this.minBtn.innerHTML = ICONS.panel;
		this.minBtn.addEventListener('click', handlers.onRestore);
		container.appendChild(this.minBtn);
	}

	/** 按清单渲染表情面板（按 group 分组展示） */
	renderExpressions(entry, composer, onToggle) {
		this.panel.innerHTML = '';
		this.gridRefs.clear();

		const head = document.createElement('div');
		head.className = 'waifu-panel-head';
		const title = document.createElement('span');
		title.textContent = '表情';
		const close = document.createElement('button');
		close.className = 'waifu-panel-close';
		close.textContent = '✕';
		close.title = '关闭面板';
		close.addEventListener('click', () => this.togglePanel(false));
		head.appendChild(title);
		head.appendChild(close);
		this.panel.appendChild(head);

		const groups = new Map();
		// expressions 是可选字段（模型可以没有任何表情），这里缺省兜底：
		// 否则一个不写 expressions 的模型会在面板渲染时抛错，把整条启动流程带崩
		for (const exp of entry.expressions || []) {
			const key = exp.group || '自由叠加';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(exp);
		}
		for (const [group, items] of groups) {
			const h = document.createElement('h4');
			h.textContent = group === '自由叠加' ? '自由叠加（可同时开多个）' : `${groupLabel(group)}（同组互斥）`;
			this.panel.appendChild(h);
			const grid = document.createElement('div');
			grid.className = 'waifu-exp-grid';
			for (const item of items) {
				const btn = document.createElement('button');
				btn.className = 'waifu-exp';
				btn.textContent = item.label || item.name;
				btn.title = item.name;
				btn.addEventListener('click', () => onToggle(item.name));
				grid.appendChild(btn);
				this.gridRefs.set(item.name, btn);
			}
			this.panel.appendChild(grid);
		}
		this.syncActive(composer.activeNames());

		// 点击面板与工具栏之外的区域自动收起
		if (!this._outsideCloser) {
			this._outsideCloser = (e) => {
				const settingsOpen = !!(this.settingsPanel && this.settingsPanel.isOpen());
				if (!this._panelOpen && !settingsOpen) return;
				if (this.bar.contains(e.target) || (this.panel && this.panel.contains(e.target))) return;
				if (this.settingsPanel && this.settingsPanel.el && this.settingsPanel.el.contains(e.target)) return;
				this.togglePanel(false);
				if (settingsOpen) this.settingsPanel.show(false);
				this.hideBarSoon();
			};
			document.addEventListener('pointerdown', this._outsideCloser);
		}
	}

	/** 同步按钮高亮 */
	syncActive(names) {
		const set = new Set(names);
		for (const [name, btn] of this.gridRefs) {
			btn.classList.toggle('on', set.has(name));
		}
	}

	togglePanel(show) {
		this._panelOpen = !!show;
		this.panel.classList.toggle('show', this._panelOpen);
		// 表情面板与设置面板互斥：同时开两个会叠在一起挡住模型
		if (this._panelOpen && this.settingsPanel) this.settingsPanel.show(false);
	}

	isPanelOpen() {
		return this._panelOpen;
	}

	/** 挂上设置面板（ui/settings.js 的实例），与表情面板互斥 */
	setSettingsPanel(panel) {
		this.settingsPanel = panel;
		if (panel && panel.el) {
			// 与表情面板一致：鼠标移到面板上时工具栏不收起
			panel.el.addEventListener('pointerenter', () => this.showBar());
			// 已经锚定过（模型先就位、面板后挂）时立刻补一次定位，否则面板会停在静态位置
			if (this._lastAnchorBox) this.updateAnchor(this._lastAnchorBox);
		}
	}

	/** 开关设置面板；打开时收起表情面板 */
	toggleSettings(show) {
		if (!this.settingsPanel) return;
		const next = show == null ? !this.settingsPanel.isOpen() : !!show;
		this.settingsPanel.show(next);
		if (next) this.togglePanel(false);
	}

	/** 卸载：解除全局监听与定时器（关闭看板娘时调用，避免重复开启后累积） */
	destroy() {
		if (this._outsideCloser) {
			document.removeEventListener('pointerdown', this._outsideCloser);
			this._outsideCloser = null;
		}
		clearTimeout(this._hideTimer);
		this._hideTimer = null;
	}

	/* ---------- 工具栏显隐（悬停模型时从右侧弹出） ---------- */

	showBar() {
		clearTimeout(this._hideTimer);
		this.root.classList.add('waifu-tb-show');
	}

	hideBarNow() {
		clearTimeout(this._hideTimer);
		this.root.classList.remove('waifu-tb-show');
	}

	hideBarSoon(delay = 800) {
		clearTimeout(this._hideTimer);
		this._hideTimer = setTimeout(() => {
			// 鼠标正悬停在按钮或任一面板上时不自动收回
			const overSettings = this.settingsPanel && this.settingsPanel.el && this.settingsPanel.el.matches(':hover');
			if (this.bar.matches(':hover') || this.panel.matches(':hover') || overSettings) return;
			// 面板开着时工具栏保持可见，方便连续调整
			if (!this._panelOpen && !(this.settingsPanel && this.settingsPanel.isOpen())) {
				this.root.classList.remove('waifu-tb-show');
			}
		}, delay);
	}

	/** 根据内容包围盒锚定位置：工具栏紧贴模型内容右缘，面板贴工具栏右侧；整体不超出网页边缘。
	 *  注意 box 是 root 内坐标，边界判断须换算成视口坐标（root 自身可能被拖动/不在原点）。 */
	updateAnchor(box) {
		if (!box || !this.bar) return;
		this._lastAnchorBox = box;
		const rootRect = this.root.getBoundingClientRect();
		const rootLeft = rootRect.left;
		const rootTop = rootRect.top;
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// 工具栏：贴模型右缘，垂直/水平都夹在视口内
		const barH = this.bar.offsetHeight || 192;
		let left = Math.min(box.maxX + 6, vw - rootLeft - 40);
		let top = Math.min(Math.max(10, box.minY + 4), Math.max(vh - rootTop - barH - 8, 10));
		this.bar.style.left = `${left}px`;
		this.bar.style.top = `${top}px`;
		// 面板：优先放工具栏右侧，放不下时换到左侧；高度不超出视口底缘（内部滚动，留 24px 呼吸余量）
		let pLeft = left + 38;
		if (rootLeft + pLeft + 238 > vw - 8) pLeft = Math.max(left - 238, 8 - rootLeft);
		const pTop = Math.max(10, box.minY - 10);
		const pMaxH = Math.max(vh - (rootTop + pTop) - 24, 200);
		this.panel.style.left = `${pLeft}px`;
		this.panel.style.top = `${pTop}px`;
		this.panel.style.maxHeight = `${pMaxH}px`;
		// 设置面板：同侧锚定，但**底边贴视口底、向上生长**。
		// 看板娘通常贴在页面底部，若像表情面板那样"从模型顶部往下"放，可用高度只剩两三百像素，
		// 内容要滚动才能看到最后几行（"帧率上限"就被藏在下面，看着像点不开）。
		if (this.settingsPanel && this.settingsPanel.el) {
			const sel = this.settingsPanel.el;
			const w = sel.offsetWidth || 250;
			let sLeft = left + 38;
			if (rootLeft + sLeft + w > vw - 8) sLeft = Math.max(left - w, 8 - rootLeft);
			const rootH = rootRect.height;
			// 相对 root 底边的偏移：让面板底边落在视口底上方 12px 处
			const bottomInset = rootTop + rootH - (vh - 12);
			sel.style.left = `${sLeft}px`;
			sel.style.top = 'auto';
			sel.style.bottom = `${bottomInset}px`;
			// 上限放到 640：看板娘在底部时面板向上生长，空间够，不必让访客滚动才能看到最后一行
			sel.style.maxHeight = `${Math.max(240, Math.min(vh - 32, 640))}px`;
		}
	}
}

function groupLabel(group) {
	const map = { pose: '手部动作', mood: '情绪表情', bg: '背景', extra: '配件装饰' };
	return map[group] || group;
}
