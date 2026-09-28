/**
 * 对话气泡：显示一段文案，超时自动淡出。
 * 位置由 stage 的内容包围盒锚定，始终贴在模型头顶上方。
 */
export class Bubble {
	constructor() {
		this.el = null;
		this.timer = null;
	}

	mount(container) {
		this.el = document.createElement('div');
		this.el.className = 'waifu-bubble';
		container.appendChild(this.el);
	}

	/** 内容包围盒变化时重新锚定（紧贴模型头顶上方几像素，水平居中于内容） */
	updateAnchor(box, canvasHeight) {
		if (!this.el || !box) return;
		this.el.style.left = `${(box.minX + box.maxX) / 2}px`;
		this.el.style.bottom = `${canvasHeight - box.minY + 6}px`;
	}

	say(text, duration = 3500) {
		if (!this.el) return;
		this.el.textContent = text;
		this.el.classList.add('show');
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.el.classList.remove('show'), duration);
	}
}
