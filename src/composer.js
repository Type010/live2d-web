/**
 * 表情合成引擎：实现官方管线不支持的「持久任意叠加」。
 *
 * 为什么必须自研（官方 CubismExpressionMotionManager 走不通）：
 * 官方的表情管理器确实能同时合成队列里的多个表情（updateMotion 遍历整个队列、把各表情的
 * 参数累加到同一张 _expressionParameterValues 表上，且是 additive/multiply/overwrite
 * 三通道分离，比本文件的单通道更精细）。但它的队列是**为"切换表情"设计的**：
 *   - startMotion() 每启动一个新表情，就给队列里所有已有表情设 fadeOut（cubismmotionqueuemanager.ts:67-75）；
 *   - 表情播完即置 isFinished（acubismmotion.ts:83-88）；
 *   - 最新一个淡入完成后直接删掉前面所有表情（cubismexpressionmotionmanager.ts:229-242）。
 * 所以官方表达的是"A 淡出、B 淡入"，最终只剩最后一个——撑不住"同时挂着脸红 + 眼镜 + 睫毛"
 * 这种持久叠加。要绕开就得每帧重建整个队列，反而比现在每次激活集合变化时算一次更重。
 *
 * 本实现的取舍：挂接模型 core 的 update，在每帧参数求值前，把激活表情集合按
 * Add/Overwrite/Multiply 语义合并写进参数，并复位已取消的参数。
 * 合并只在激活集合变化时重算（_rebuild），每帧只做写参数，没有淡入淡出——
 * 这是拿"切换渐变"换"持久叠加 + 每帧零重算"。
 * 表情层因此优先于动作/眨眼/物理：多个表情可同时生效、按参数级叠加，互不顶掉。
 *
 * 互斥组（group）由清单定义：同组单选（模型参数结构限制），组外自由叠加。
 */
import { fetchJSON } from './loader.js';

export class ExpressionComposer {
	constructor() {
		this.defs = new Map(); // name -> {item, params}
		this.active = new Set();
		this.merged = []; // [[paramId, {value, blend}]]
		this.mergedIds = new Set(); // merged 里的参数 id，随 _rebuild 更新
		this.lastIds = []; // 上帧写过的参数 id，用于复位
		this._temps = new Map(); // name -> {timer, evicted, group}：临时表情可多个并存
		this.onChange = null;
		this._detach = null;
	}

	setActive(names) {
		this.active.clear();
		for (const n of names || []) {
			if (this.defs.has(n)) this.active.add(n);
		}
		this._commit();
	}

	/** 加载表情定义（file 相对模型 model3.json 所在目录），并切换到新模型 */
	async load(model, expressionItems) {
		const items = expressionItems || [];
		const results = await Promise.all(
			items.map(async (item) => {
				try {
					const def = await fetchJSON(new URL(item.file, model.baseUrl).href);
					return { item, def };
				} catch (e) {
					console.warn(`[waifu] 表情 ${item.name} 加载失败`, e);
					return null;
				}
			}),
		);
		// 新模型登场：先清空上一个模型的叠加状态，避免旧表情参数写进新模型
		this.clear();
		this.defs = new Map();
		for (const r of results) {
			if (r) this.defs.set(r.item.name, { item: r.item, params: (r.def && r.def.Parameters) || [] });
		}
		this.attach(model);
	}

	/** 挂接 core 参数求值；cubismModel 为官方 CubismModel（切换模型时先 detach 旧模型） */
	attach(model) {
		this.detach();
		const core = model.cubismModel || (model.internalModel && model.internalModel.coreModel) || model;
		// 官方框架只认 CubismIdHandle，这里统一把字符串参数名解析成 handle
		this._id = (name) => (model.resolveParamId ? model.resolveParamId(name) : name);
		const origUpdate = core.update.bind(core);
		const self = this;
		core.update = function () {
			self.applyFrame(core);
			return origUpdate();
		};
		this._detach = () => {
			core.update = origUpdate;
		};
	}

	detach() {
		if (this._detach) {
			this._detach();
			this._detach = null;
		}
		this._clearTemps();
	}

	/** 清掉所有临时表情及其定时器（detach / clear / 换模型共用） */
	_clearTemps() {
		if (this._temps) {
			for (const t of this._temps.values()) clearTimeout(t.timer);
			this._temps.clear();
		}
	}

	/** 重算合并结果并通知宿主——激活集合变化的统一出口 */
	_commit() {
		this._rebuild();
		if (this.onChange) this.onChange(this.activeNames());
	}

	/** 重算合并结果（激活集合变化时调用一次） */
	_rebuild() {
		const acc = new Map(); // paramId -> {value, blend}
		for (const name of this.active) {
			const def = this.defs.get(name);
			if (!def) continue;
			for (const p of def.params) {
				if (!p || typeof p.Value !== 'number') continue;
				const prev = acc.get(p.Id);
				const blend = p.Blend || 'Overwrite';
				if (!prev) {
					acc.set(p.Id, { value: p.Value, blend });
				} else if (blend === 'Add') {
					prev.value += p.Value;
				} else if (blend === 'Multiply') {
					// 多个 Multiply 作用于同一参数时要逐个相乘（VTS 语义）；
					// 直接覆盖只剩"默认值 × 最后一个"，会丢掉先前的乘数
					prev.value *= p.Value;
					prev.blend = 'Multiply';
				} else {
					prev.value = p.Value;
					prev.blend = blend;
				}
			}
		}
		this.merged = [...acc.entries()];
		// 参数 id 集合只在激活集合变化时算一次（applyFrame 每帧都要用，
		// 早先每帧 new Set() 再展开一次，是纯浪费）
		this.mergedIds = new Set(this.merged.map(([id]) => id));
	}

	applyFrame(core) {
		if (!this.merged.length && !this.lastIds.length) return;
		const currentIds = this.mergedIds;
		// 复位上帧写过的、本帧不再激活的参数
		for (const id of this.lastIds) {
			if (!currentIds.has(id)) {
				const idx = core.getParameterIndex(this._id(id));
				if (idx >= 0) core.setParameterValueByIndex(idx, core.getParameterDefaultValue(idx));
			}
		}
		// 应用激活集合：先回默认基线（避免 Add 连帧累加），再按混合语义写入
		for (const [id, m] of this.merged) {
			const idx = core.getParameterIndex(this._id(id));
			if (idx < 0) continue;
			core.setParameterValueByIndex(idx, core.getParameterDefaultValue(idx));
			if (m.blend === 'Add') core.addParameterValueById(this._id(id), m.value);
			else if (m.blend === 'Multiply') core.multiplyParameterValueById(this._id(id), m.value);
			else core.setParameterValueById(this._id(id), m.value);
		}
		this.lastIds = [...currentIds];
	}

	/* ---------- 对外状态操作 ---------- */

	activeNames() {
		return [...this.active];
	}

	/** 切换表情；同组互斥由清单 group 定义。返回切换后的激活集合 */
	toggle(name) {
		const def = this.defs.get(name);
		if (!def) return this.activeNames();
		const group = def.item.group;
		if (this.active.has(name)) {
			this.active.delete(name);
		} else {
			if (group) {
				for (const other of [...this.active]) {
					if (this.defs.get(other) && this.defs.get(other).item.group === group) {
						this.active.delete(other);
					}
				}
			}
			this.active.add(name);
		}
		this._commit();
		return this.activeNames();
	}

	clear() {
		this._clearTemps();
		this.active.clear();
		this._commit();
	}

	/**
	 * 临时叠加一个表情（点击反应、空闲微动作等自动行为用）。
	 *
	 * 多个临时表情可并存：不同组的 temp 各自独立倒计时，互不顶掉——
	 * 早期是"单临时槽"，新 temp 会立刻替换旧的，导致连点两下时前一个反应凭空消失，
	 * 也拿不到"脸红 + 比心同时挂着"这类组合。同组互斥仍然成立（顶掉同组的激活项，
	 * 结束后恢复，除非期间用户手动点了同组其他表情）。
	 */
	pulse(name, duration) {
		const def = this.defs.get(name);
		if (!def) return;
		// 已在手动激活或已在临时叠加中：不重复处理，也不重设定时器
		if (this.active.has(name)) return;
		const group = def.item.group;
		// 顶掉同组的激活项（手动的与临时的都算），temp 结束后恢复
		const evicted = [];
		if (group) {
			for (const other of [...this.active]) {
				const d = this.defs.get(other);
				if (d && d.item.group === group) {
					evicted.push(other);
					this.active.delete(other);
					// 被顶掉的是另一个临时表情时，连同它的恢复逻辑一起结束，避免它被再次恢复
					if (this._temps.has(other)) {
						clearTimeout(this._temps.get(other).timer);
						this._temps.delete(other);
					}
				}
			}
		}
		this.active.add(name);
		const timer = setTimeout(() => this._restoreTemp(name), duration);
		this._temps.set(name, { timer, evicted, group });
		this._commit();
	}

	_restoreTemp(name) {
		const t = this._temps.get(name);
		if (!t) return;
		this._temps.delete(name);
		if (!this.active.has(name)) return; // 期间已被手动取消
		this.active.delete(name);
		const { evicted, group } = t;
		// 同组已有其他激活项（temp 期间用户手动点了同组表情）时不再恢复被顶掉的
		const blocked = group && [...this.active].some((o) => {
			const d = this.defs.get(o);
			return d && d.item.group === group;
		});
		if (!blocked) {
			for (const e of evicted) if (!this.active.has(e)) this.active.add(e);
		}
		this._commit();
	}
}
